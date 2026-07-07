import { createClient, type Client } from '@libsql/client';
import {
  type Agent,
  type AssistantDeliveryOutboxEntry,
  type DurableRunStore,
  type Inbound,
  type OnceScope,
  type ProviderSessionBinding,
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
  private constructor(
    private readonly client: Client,
    private readonly agents: Record<string, Agent>,
  ) {}

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
    const store = new LibsqlRunStore(client, options.agents);
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

  async create(runId: string, run: StoredRun<any>): Promise<void> {
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

  async patch(runId: string, patch: StoredRunPatch): Promise<void> {
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

  async appendInbox(runId: string, inbound: Inbound): Promise<void> {
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
  ): Promise<void> {
    // Compute the next seq atomically by reading the current MAX.
    const seqRes = await this.client.execute({
      sql: `SELECT COALESCE(MAX(seq) + 1, 0) AS seq
            FROM session_deltas WHERE run_id = ?`,
      args: [runId],
    });
    const seq = seqRes.rows[0][0] as number;

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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        runId,
        seq,
        delta.fromVersion,
        delta.toVersion,
        JSON.stringify(delta.appendedMessages),
        jsonOrNull(delta.varsSet),
        jsonOrNull(delta.varsDeleted),
        delta.rewrite ? 1 : 0,
      ],
    });
  }

  async recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
  ): Promise<void> {
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
  ): Promise<void> {
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
  ): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO provider_sessions (run_id, node_path, binding_json)
            VALUES (?, ?, ?)
            ON CONFLICT(run_id, node_path)
            DO UPDATE SET binding_json = excluded.binding_json`,
      args: [runId, nodePath, JSON.stringify(binding)],
    });
  }

  async delete(runId: string): Promise<void> {
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

    // 7. Delegate assembly to the shared reconstruction helper.
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
      },
      this.agents,
    );
  }
}
