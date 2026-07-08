import { createClient, type Client } from '@libsql/client';
import {
  assertFenceAllowed,
  type Agent,
  type AssistantDeliveryOutboxEntry,
  type DurableRunStore,
  type DurableTimer,
  type Inbound,
  type InboundKind,
  type OnceScope,
  type ProviderSessionBinding,
  type RunStoreLease,
  type RunStoreLeaseState,
  type SessionCheckpointDelta,
  type StoredRun,
  type StoredRunPatch,
} from '@prompttrail/core';
import {
  jsonOrNull,
  normalizeStoredMessages,
  parseJson,
  parseJsonRequired,
  reconstructStoredRun,
  type ReconstructOnceEntry,
} from '@prompttrail/store-common';

export interface LibsqlRunStoreOptions {
  /** Pre-created libsql Client. Takes priority over url/authToken. */
  client?: Client;
  /** libsql database URL (e.g. "file:/path/to/db.sqlite" or a Turso URL). */
  url?: string;
  /** Auth token for remote Turso databases. */
  authToken?: string;
  /** Agents map used to reconstruct stored runs. */
  agents: Record<string, Agent>;
  /** Injectable clock for the lease (defaults to `Date.now`). Tests only. */
  now?: () => number;
}

interface LibsqlLeaseRow {
  holder: string;
  token: number;
  expiresAt: number;
  ttlMs: number;
}

/**
 * Store-wide single-writer lease backed by a single libSQL row (id = 1).
 * libSQL is networked/async, so each acquire/renew/handoff reads the row then
 * writes it back in two round trips — correct for the single-writer arbitration
 * this lease provides (the launcher/heartbeat serializes lease operations). The
 * fencing token persists in the row, so it stays monotonic across reopens.
 */
class LibsqlLease implements RunStoreLease {
  constructor(
    private readonly client: Client,
    private readonly now: () => number,
  ) {}

  private async readRow(): Promise<LibsqlLeaseRow | undefined> {
    const res = await this.client.execute(
      'SELECT holder, token, expires_at, ttl_ms FROM lease WHERE id = 1',
    );
    if (res.rows.length === 0) {
      return undefined;
    }
    const r = res.rows[0];
    return {
      holder: r[0] as string,
      token: r[1] as number,
      expiresAt: r[2] as number,
      ttlMs: r[3] as number,
    };
  }

  private async write(row: LibsqlLeaseRow): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO lease (id, holder, token, expires_at, ttl_ms)
            VALUES (1, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              holder = excluded.holder,
              token = excluded.token,
              expires_at = excluded.expires_at,
              ttl_ms = excluded.ttl_ms`,
      args: [row.holder, row.token, row.expiresAt, row.ttlMs],
    });
  }

  private isActive(row: LibsqlLeaseRow | undefined, at: number): boolean {
    return row !== undefined && row.expiresAt > at;
  }

  private view(row: LibsqlLeaseRow): RunStoreLeaseState {
    return { holder: row.holder, token: row.token, expiresAt: row.expiresAt };
  }

  /** Active-token read used by the store's fence check. */
  async activeToken(): Promise<number | undefined> {
    const row = await this.readRow();
    return this.isActive(row, this.now()) ? row!.token : undefined;
  }

  async acquire(
    holder: string,
    ttlMs: number,
  ): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const row = await this.readRow();
    if (this.isActive(row, at)) {
      if (row!.holder !== holder) {
        return undefined;
      }
      const renewed: LibsqlLeaseRow = {
        holder,
        token: row!.token,
        expiresAt: at + ttlMs,
        ttlMs,
      };
      await this.write(renewed);
      return this.view(renewed);
    }
    const next: LibsqlLeaseRow = {
      holder,
      token: (row?.token ?? 0) + 1,
      expiresAt: at + ttlMs,
      ttlMs,
    };
    await this.write(next);
    return this.view(next);
  }

  async renew(
    holder: string,
    ttlMs?: number,
  ): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const row = await this.readRow();
    if (!this.isActive(row, at) || row!.holder !== holder) {
      return undefined;
    }
    const ttl = ttlMs ?? row!.ttlMs;
    const renewed: LibsqlLeaseRow = {
      holder,
      token: row!.token,
      expiresAt: at + ttl,
      ttlMs: ttl,
    };
    await this.write(renewed);
    return this.view(renewed);
  }

  async release(holder: string): Promise<void> {
    const at = this.now();
    const row = await this.readRow();
    if (this.isActive(row, at) && row!.holder === holder) {
      await this.write({ ...row!, expiresAt: 0 });
    }
  }

  async handoff(opts: {
    from: string;
    to: string;
    ttlMs: number;
  }): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const row = await this.readRow();
    if (!this.isActive(row, at) || row!.holder !== opts.from) {
      return undefined;
    }
    const next: LibsqlLeaseRow = {
      holder: opts.to,
      token: row!.token + 1,
      expiresAt: at + opts.ttlMs,
      ttlMs: opts.ttlMs,
    };
    await this.write(next);
    return this.view(next);
  }

  async current(): Promise<RunStoreLeaseState | undefined> {
    const row = await this.readRow();
    return this.isActive(row, this.now()) ? this.view(row!) : undefined;
  }
}

/**
 * libSQL durable run store for PromptTrail.
 *
 * Reads (get/has/entries) are LAZY: each call queries the database and
 * reconstructs a fresh StoredRun from the stored rows. There is no in-memory
 * hydration on startup. Writes are write-through: each durable-store write
 * maps to a single parameterised SQL statement.
 *
 * Construction is async: use `LibsqlRunStore.open(options)` which enables
 * foreign keys and runs CREATE TABLE IF NOT EXISTS before returning the
 * store instance.
 *
 * libSQL is real SQLite under the hood, so FOREIGN KEY ... ON DELETE CASCADE
 * is fully supported. FK enforcement is enabled in open() via
 * `PRAGMA foreign_keys = ON`. delete() relies on cascade to clean child rows.
 */
export class LibsqlRunStore implements DurableRunStore {
  readonly lease: RunStoreLease;
  private readonly libsqlLease: LibsqlLease;

  private constructor(
    private readonly client: Client,
    private readonly agents: Record<string, Agent>,
    now: () => number,
  ) {
    this.libsqlLease = new LibsqlLease(client, now);
    this.lease = this.libsqlLease;
  }

  private async assertFence(fence: number | undefined): Promise<void> {
    assertFenceAllowed(await this.libsqlLease.activeToken(), fence);
  }

  /**
   * Open a LibsqlRunStore, enabling foreign keys and creating the schema if it
   * does not exist. Pass a pre-created `client` or a `url` (and optional
   * `authToken`) to connect.
   */
  static async open(options: LibsqlRunStoreOptions): Promise<LibsqlRunStore> {
    let client: Client;
    if (options.client) {
      client = options.client;
    } else if (options.url) {
      // intMode: 'number' ensures INTEGER columns come back as JS numbers, not
      // BigInt, which would break the seq/graph_cursor arithmetic.
      client = createClient({
        url: options.url,
        authToken: options.authToken,
        intMode: 'number',
      });
    } else {
      throw new Error('LibsqlRunStore.open requires either a client or a url.');
    }
    const store = new LibsqlRunStore(
      client,
      options.agents,
      options.now ?? Date.now,
    );
    await store.createSchema();
    return store;
  }

  async get(runId: string): Promise<StoredRun<any> | undefined> {
    return this.reconstructRun(runId);
  }

  async has(runId: string): Promise<boolean> {
    const res = await this.client.execute({
      sql: 'SELECT 1 FROM runs WHERE run_id = ? LIMIT 1',
      args: [runId],
    });
    return res.rows.length > 0;
  }

  async entries(): Promise<Iterable<[string, StoredRun<any>]>> {
    const res = await this.client.execute(
      'SELECT run_id FROM runs ORDER BY run_id',
    );
    const pairs: [string, StoredRun<any>][] = [];
    for (const row of res.rows) {
      const id = row[0] as string;
      const run = await this.reconstructRun(id);
      if (run) {
        pairs.push([id, run]);
      }
    }
    return pairs;
  }

  async create(
    runId: string,
    run: StoredRun<any>,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    await this.client.execute({
      sql: `INSERT INTO runs (
        run_id,
        agent_name,
        status,
        graph_cursor,
        graph_suspended_at,
        context_json,
        initial_session_json,
        graph_manifest_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        runId,
        run.agentName,
        run.status,
        run.graphCursor ?? null,
        run.graphSuspendedAt ?? null,
        jsonOrNull(run.context),
        JSON.stringify(run.initial.toJSON()),
        jsonOrNull(run.graphManifest),
      ],
    });
  }

  async patch(
    runId: string,
    patch: StoredRunPatch,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    // Read current values so we can fill in unpatched fields.
    const res = await this.client.execute({
      sql: `SELECT agent_name, status, graph_cursor, graph_suspended_at,
                   context_json, graph_manifest_json
            FROM runs WHERE run_id = ?`,
      args: [runId],
    });
    if (res.rows.length === 0) {
      return;
    }
    const row = res.rows[0];
    const current = {
      agent_name: row[0] as string,
      status: row[1] as string,
      graph_cursor: row[2] as number | null,
      graph_suspended_at: row[3] as string | null,
      context_json: row[4] as string | null,
      graph_manifest_json: row[5] as string | null,
    };

    await this.client.execute({
      sql: `UPDATE runs SET
              agent_name = ?,
              status = ?,
              graph_cursor = ?,
              graph_suspended_at = ?,
              context_json = ?,
              graph_manifest_json = ?
            WHERE run_id = ?`,
      args: [
        'agentName' in patch
          ? (patch.agentName ?? current.agent_name)
          : current.agent_name,
        'status' in patch ? (patch.status ?? current.status) : current.status,
        'graphCursor' in patch
          ? (patch.graphCursor ?? null)
          : current.graph_cursor,
        'graphSuspendedAt' in patch
          ? (patch.graphSuspendedAt ?? null)
          : current.graph_suspended_at,
        'context' in patch ? jsonOrNull(patch.context) : current.context_json,
        'graphManifest' in patch
          ? jsonOrNull(patch.graphManifest)
          : current.graph_manifest_json,
        runId,
      ],
    });
  }

  async appendInbox(
    runId: string,
    inbound: Inbound,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    // INSERT OR IGNORE for offset idempotency — duplicate offsets are silently dropped.
    await this.client.execute({
      sql: `INSERT OR IGNORE INTO inbox (run_id, offset_num, kind, content, attrs_json)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        runId,
        inbound.offset,
        inbound.kind,
        inbound.content,
        jsonOrNull(inbound.attrs),
      ],
    });
  }

  async appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    // Single-statement seq allocation: INSERT ... SELECT COALESCE(MAX(seq)+1, 0)
    // computes the next seq and inserts in one round trip, so there is no
    // window between reading the max and writing the row for another
    // statement on this run to land in.
    await this.client.execute({
      sql: `INSERT INTO session_deltas (
              run_id,
              seq,
              from_version,
              to_version,
              appended_messages_json,
              vars_set_json,
              vars_deleted_json,
              rewrite
            )
            SELECT ?, COALESCE(MAX(seq) + 1, 0), ?, ?, ?, ?, ?, ?
            FROM session_deltas WHERE run_id = ?`,
      args: [
        runId,
        delta.fromVersion,
        delta.toVersion,
        JSON.stringify(delta.appendedMessages),
        jsonOrNull(delta.varsSet),
        jsonOrNull(delta.varsDeleted),
        delta.rewrite ? 1 : 0,
        runId,
      ],
    });
  }

  async recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    await this.client.execute({
      sql: `INSERT INTO once_memo (run_id, scope, key, value_json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(run_id, scope, key)
            DO UPDATE SET value_json = excluded.value_json`,
      args: [runId, scope, key, JSON.stringify(value)],
    });
  }

  async upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    await this.client.execute({
      sql: `INSERT INTO outbox (run_id, idempotency_key, entry_json)
            VALUES (?, ?, ?)
            ON CONFLICT(run_id, idempotency_key)
            DO UPDATE SET entry_json = excluded.entry_json`,
      args: [runId, entry.idempotencyKey, JSON.stringify(entry)],
    });
  }

  async recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    await this.client.execute({
      sql: `INSERT INTO provider_sessions (run_id, node_path, binding_json)
            VALUES (?, ?, ?)
            ON CONFLICT(run_id, node_path)
            DO UPDATE SET binding_json = excluded.binding_json`,
      args: [runId, nodePath, JSON.stringify(binding)],
    });
  }

  async upsertTimer(
    runId: string,
    timer: DurableTimer,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    await this.client.execute({
      sql: `INSERT INTO timers (run_id, id, wake_at, payload, kind, created_at, fired_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id, id)
            DO UPDATE SET
              wake_at = excluded.wake_at,
              payload = excluded.payload,
              kind = excluded.kind,
              created_at = excluded.created_at,
              fired_at = excluded.fired_at`,
      args: [
        runId,
        timer.id,
        timer.wakeAt,
        timer.payload ?? null,
        timer.kind ?? null,
        timer.createdAt,
        timer.firedAt ?? null,
      ],
    });
  }

  async delete(runId: string, fence?: number): Promise<void> {
    await this.assertFence(fence);
    // Deleting the parent runs row is sufficient: the schema declares
    // FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE on every
    // child table (session_deltas, once_memo, inbox, outbox, provider_sessions),
    // and PRAGMA foreign_keys = ON is set in open(). The cascade automatically
    // removes all child rows when the parent run is deleted.
    await this.client.execute({
      sql: 'DELETE FROM runs WHERE run_id = ?',
      args: [runId],
    });
  }

  /** Close the underlying libsql client connection. */
  async close(): Promise<void> {
    this.client.close();
  }

  // ---------------------------------------------------------------------------
  // Schema creation
  // ---------------------------------------------------------------------------

  private async createSchema(): Promise<void> {
    // Enable FK enforcement before creating tables. libsql is real SQLite and
    // supports FOREIGN KEY ... ON DELETE CASCADE — we rely on this in delete().
    await this.client.execute('PRAGMA foreign_keys = ON');

    await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL,
        graph_cursor INTEGER,
        graph_suspended_at TEXT,
        context_json TEXT,
        initial_session_json TEXT NOT NULL,
        graph_manifest_json TEXT
      );

      CREATE TABLE IF NOT EXISTS session_deltas (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        from_version INTEGER NOT NULL,
        to_version INTEGER NOT NULL,
        appended_messages_json TEXT NOT NULL,
        vars_set_json TEXT,
        vars_deleted_json TEXT,
        rewrite INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS once_memo (
        run_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (run_id, scope, key),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS inbox (
        run_id TEXT NOT NULL,
        offset_num INTEGER NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        attrs_json TEXT,
        PRIMARY KEY (run_id, offset_num),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS outbox (
        run_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        PRIMARY KEY (run_id, idempotency_key),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS provider_sessions (
        run_id TEXT NOT NULL,
        node_path TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        PRIMARY KEY (run_id, node_path),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS timers (
        run_id TEXT NOT NULL,
        id TEXT NOT NULL,
        wake_at INTEGER NOT NULL,
        payload TEXT,
        kind TEXT,
        created_at INTEGER NOT NULL,
        fired_at INTEGER,
        PRIMARY KEY (run_id, id),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        holder TEXT NOT NULL,
        token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ttl_ms INTEGER NOT NULL
      );
    `);
  }

  // ---------------------------------------------------------------------------
  // Lazy reconstruction (per-run, queried on every get() call)
  // ---------------------------------------------------------------------------

  private async reconstructRun(
    runId: string,
  ): Promise<StoredRun<any> | undefined> {
    // 1. Load the run row.
    const runRes = await this.client.execute({
      sql: `SELECT run_id, agent_name, status, graph_cursor, graph_suspended_at,
                   context_json, initial_session_json, graph_manifest_json
            FROM runs WHERE run_id = ?`,
      args: [runId],
    });
    if (runRes.rows.length === 0) {
      return undefined;
    }
    const r = runRes.rows[0];
    const row = {
      run_id: r[0] as string,
      agent_name: r[1] as string,
      status: r[2] as StoredRun<any>['status'],
      graph_cursor: r[3] as number | null,
      graph_suspended_at: r[4] as string | null,
      context_json: r[5] as string | null,
      initial_session_json: r[6] as string,
      graph_manifest_json: r[7] as string | null,
    };

    // 2. Gather session deltas ordered by seq.
    const deltaRes = await this.client.execute({
      sql: `SELECT from_version, to_version, appended_messages_json,
                   vars_set_json, vars_deleted_json, rewrite
            FROM session_deltas
            WHERE run_id = ?
            ORDER BY seq ASC`,
      args: [runId],
    });
    const deltas: SessionCheckpointDelta<any>[] = deltaRes.rows.map((drow) => ({
      fromVersion: drow[0] as number,
      toVersion: drow[1] as number,
      appendedMessages: normalizeStoredMessages(
        parseJsonRequired(drow[2] as string),
      ),
      varsSet: parseJson(drow[3] as string | null),
      varsDeleted: parseJson(drow[4] as string | null),
      rewrite: (drow[5] as number) === 1,
    }));

    // 3. Gather once_memo entries.
    const onceRes = await this.client.execute({
      sql: 'SELECT scope, key, value_json FROM once_memo WHERE run_id = ?',
      args: [runId],
    });
    const once: ReconstructOnceEntry[] = onceRes.rows.map((orow) => ({
      scope: orow[0] as OnceScope,
      key: orow[1] as string,
      value: parseJson(orow[2] as string),
    }));

    // 4. Gather inbox entries ordered by offset.
    const inboxRes = await this.client.execute({
      sql: `SELECT offset_num, kind, content, attrs_json
            FROM inbox WHERE run_id = ?
            ORDER BY offset_num ASC`,
      args: [runId],
    });
    const inbox: Inbound[] = inboxRes.rows.map((irow) => ({
      offset: irow[0] as number,
      kind: irow[1] as Inbound['kind'],
      content: irow[2] as string,
      attrs: parseJson(irow[3] as string | null),
    }));

    // 5. Gather outbox entries.
    const outboxRes = await this.client.execute({
      sql: 'SELECT entry_json FROM outbox WHERE run_id = ?',
      args: [runId],
    });
    const outbox: AssistantDeliveryOutboxEntry[] = outboxRes.rows.map(
      (brow) => parseJson(brow[0] as string) as AssistantDeliveryOutboxEntry,
    );

    // 6. Gather provider_sessions.
    const provRes = await this.client.execute({
      sql: 'SELECT node_path, binding_json FROM provider_sessions WHERE run_id = ?',
      args: [runId],
    });
    const providerSessions: Record<string, ProviderSessionBinding> = {};
    for (const prow of provRes.rows) {
      providerSessions[prow[0] as string] = parseJson(
        prow[1] as string,
      ) as ProviderSessionBinding;
    }

    // 7. Gather durable timers ordered by id.
    const timerRes = await this.client.execute({
      sql: `SELECT id, wake_at, payload, kind, created_at, fired_at
            FROM timers WHERE run_id = ? ORDER BY id ASC`,
      args: [runId],
    });
    const timers: DurableTimer[] = timerRes.rows.map((trow) => {
      const timer: DurableTimer = {
        id: trow[0] as string,
        wakeAt: trow[1] as number,
        createdAt: trow[4] as number,
      };
      if (trow[2] !== null) {
        timer.payload = trow[2] as string;
      }
      if (trow[3] !== null) {
        timer.kind = trow[3] as InboundKind;
      }
      if (trow[5] !== null) {
        timer.firedAt = trow[5] as number;
      }
      return timer;
    });

    // 8. Delegate assembly to the shared reconstruction helper.
    return reconstructStoredRun(
      {
        agentName: row.agent_name,
        status: row.status,
        graphCursor: row.graph_cursor ?? undefined,
        graphSuspendedAt: row.graph_suspended_at ?? undefined,
        context: parseJson(row.context_json),
        initialSession: parseJsonRequired(row.initial_session_json),
        graphManifest: parseJson(row.graph_manifest_json),
        deltas,
        once,
        inbox,
        outbox,
        providerSessions,
        timers,
      },
      this.agents,
    );
  }
}
