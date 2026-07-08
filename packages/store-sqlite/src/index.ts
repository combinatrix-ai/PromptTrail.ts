import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cwd } from 'node:process';
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
  applySessionDelta,
  jsonOrNull,
  normalizeStoredMessages,
  parseJson,
  parseJsonRequired,
  reconstructStoredRun,
  type ReconstructOnceEntry,
} from '@prompttrail/store-common';

interface SqliteRunStoreOptions {
  path?: string;
  agents: Record<string, Agent>;
  /** Injectable clock for the lease (defaults to `Date.now`). Tests only. */
  now?: () => number;
}

interface LeaseRow {
  holder: string;
  token: number;
  expires_at: number;
  ttl_ms: number;
}

/**
 * Store-wide single-writer lease backed by a single SQLite row (id = 1).
 * better-sqlite3 is synchronous, so each acquire/renew/handoff reads and writes
 * the row within one JS tick — the read-then-write is atomic in-process. The
 * fencing token persists in the row, so it stays monotonic across process
 * restarts (a reopened store reads the last token and bumps from it).
 */
class SqliteLease implements RunStoreLease {
  private readonly selectStmt: Database.Statement;
  private readonly upsertStmt: Database.Statement;

  constructor(
    db: Database.Database,
    private readonly now: () => number,
  ) {
    this.selectStmt = db.prepare(
      'SELECT holder, token, expires_at, ttl_ms FROM lease WHERE id = 1',
    );
    this.upsertStmt = db.prepare(`
      INSERT INTO lease (id, holder, token, expires_at, ttl_ms)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        holder = excluded.holder,
        token = excluded.token,
        expires_at = excluded.expires_at,
        ttl_ms = excluded.ttl_ms
    `);
  }

  private readRow(): LeaseRow | undefined {
    return this.selectStmt.get() as LeaseRow | undefined;
  }

  private write(row: LeaseRow): void {
    this.upsertStmt.run(row.holder, row.token, row.expires_at, row.ttl_ms);
  }

  private isActive(row: LeaseRow | undefined, at: number): boolean {
    return row !== undefined && row.expires_at > at;
  }

  private view(row: LeaseRow): RunStoreLeaseState {
    return { holder: row.holder, token: row.token, expiresAt: row.expires_at };
  }

  /** Synchronous active-token read used by the store's fence check. */
  activeToken(): number | undefined {
    const row = this.readRow();
    return this.isActive(row, this.now()) ? row!.token : undefined;
  }

  async acquire(
    holder: string,
    ttlMs: number,
  ): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const row = this.readRow();
    if (this.isActive(row, at)) {
      if (row!.holder !== holder) {
        return undefined;
      }
      const renewed: LeaseRow = {
        holder,
        token: row!.token,
        expires_at: at + ttlMs,
        ttl_ms: ttlMs,
      };
      this.write(renewed);
      return this.view(renewed);
    }
    const next: LeaseRow = {
      holder,
      token: (row?.token ?? 0) + 1,
      expires_at: at + ttlMs,
      ttl_ms: ttlMs,
    };
    this.write(next);
    return this.view(next);
  }

  async renew(
    holder: string,
    ttlMs?: number,
  ): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const row = this.readRow();
    if (!this.isActive(row, at) || row!.holder !== holder) {
      return undefined;
    }
    const ttl = ttlMs ?? row!.ttl_ms;
    const renewed: LeaseRow = {
      holder,
      token: row!.token,
      expires_at: at + ttl,
      ttl_ms: ttl,
    };
    this.write(renewed);
    return this.view(renewed);
  }

  async release(holder: string): Promise<void> {
    const at = this.now();
    const row = this.readRow();
    if (this.isActive(row, at) && row!.holder === holder) {
      // Retain the token for monotonicity; just expire the lease.
      this.write({ ...row!, expires_at: 0 });
    }
  }

  async handoff(opts: {
    from: string;
    to: string;
    ttlMs: number;
  }): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const row = this.readRow();
    if (!this.isActive(row, at) || row!.holder !== opts.from) {
      return undefined;
    }
    const next: LeaseRow = {
      holder: opts.to,
      token: row!.token + 1,
      expires_at: at + opts.ttlMs,
      ttl_ms: opts.ttlMs,
    };
    this.write(next);
    return this.view(next);
  }

  async current(): Promise<RunStoreLeaseState | undefined> {
    const row = this.readRow();
    return this.isActive(row, this.now()) ? this.view(row!) : undefined;
  }
}

export interface SqliteWriteJournalEntry {
  at: string;
  runId: string;
  op:
    | 'create'
    | 'appendInbox'
    | 'appendSessionDelta'
    | 'recordOnce'
    | 'upsertOutbox'
    | 'recordProviderSession'
    | 'upsertTimer'
    | 'patch'
    | 'delete';
  summary: string;
}

export interface SqliteRunCounts {
  runs: number;
  session_deltas: number;
  once_memo: number;
  inbox: number;
  outbox: number;
}

interface RunRow {
  run_id: string;
  agent_name: string;
  status: StoredRun<any>['status'];
  graph_cursor: number | null;
  graph_suspended_at: string | null;
  context_json: string | null;
  initial_session_json: string;
  graph_manifest_json: string | null;
}

interface SessionDeltaRow {
  run_id: string;
  seq: number;
  from_version: number;
  to_version: number;
  appended_messages_json: string;
  vars_set_json: string | null;
  vars_deleted_json: string | null;
  rewrite: 0 | 1;
}

interface OnceMemoRow {
  run_id: string;
  scope: OnceScope;
  key: string;
  value_json: string;
}

interface InboxRow {
  run_id: string;
  offset: number;
  kind: Inbound['kind'];
  content: string;
  attrs_json: string | null;
}

interface OutboxRow {
  run_id: string;
  idempotency_key: string;
  entry_json: string;
}

interface ProviderSessionRow {
  run_id: string;
  node_path: string;
  binding_json: string;
}

interface TimerRow {
  run_id: string;
  id: string;
  wake_at: number;
  payload: string | null;
  kind: InboundKind | null;
  created_at: number;
  fired_at: number | null;
}

/**
 * SQLite restart substrate for PromptTrail durable runs.
 *
 * Reads (`get`/`has`/`entries`) are async to match the `DurableRunStore`
 * interface, but are still served from the hydrated in-memory `runs` Map —
 * construction replays all SQLite rows into live runs, so each read resolves
 * immediately without hitting the database. SQLite owns process-restart
 * recovery: each granular durable write maps directly to one SQL statement.
 */
export class SqliteRunStore implements DurableRunStore {
  private static readonly maxJournalEntriesPerRun = 50;

  private readonly db: Database.Database;
  private readonly runs = new Map<string, StoredRun<any>>();
  private readonly writeJournal = new Map<string, SqliteWriteJournalEntry[]>();
  private readonly sqliteLease: SqliteLease;
  readonly lease: RunStoreLease;

  private readonly insertRunStmt: Database.Statement;
  private readonly updateRunStmt: Database.Statement;
  private readonly deleteRunStmt: Database.Statement;
  private readonly insertSessionDeltaStmt: Database.Statement;
  private readonly nextSessionDeltaSeqStmt: Database.Statement;
  private readonly upsertOnceMemoStmt: Database.Statement;
  private readonly insertInboxStmt: Database.Statement;
  private readonly upsertOutboxStmt: Database.Statement;
  private readonly upsertProviderSessionStmt: Database.Statement;
  private readonly upsertTimerStmt: Database.Statement;

  constructor(options: SqliteRunStoreOptions) {
    const dbPath = options.path ?? join(cwd(), '.data', 'prompttrail.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.createSchema();

    this.insertRunStmt = this.db.prepare(`
      INSERT INTO runs (
        run_id,
        agent_name,
        status,
        graph_cursor,
        graph_suspended_at,
        context_json,
        initial_session_json,
        graph_manifest_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateRunStmt = this.db.prepare(`
      UPDATE runs
      SET
        agent_name = ?,
        status = ?,
        graph_cursor = ?,
        graph_suspended_at = ?,
        context_json = ?,
        graph_manifest_json = ?
      WHERE run_id = ?
    `);
    this.deleteRunStmt = this.db.prepare('DELETE FROM runs WHERE run_id = ?');
    this.nextSessionDeltaSeqStmt = this.db.prepare(`
      SELECT COALESCE(MAX(seq) + 1, 0) AS seq
      FROM session_deltas
      WHERE run_id = ?
    `);
    this.insertSessionDeltaStmt = this.db.prepare(`
      INSERT INTO session_deltas (
        run_id,
        seq,
        from_version,
        to_version,
        appended_messages_json,
        vars_set_json,
        vars_deleted_json,
        rewrite
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.upsertOnceMemoStmt = this.db.prepare(`
      INSERT INTO once_memo (run_id, scope, key, value_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, scope, key)
      DO UPDATE SET value_json = excluded.value_json
    `);
    this.insertInboxStmt = this.db.prepare(`
      INSERT OR IGNORE INTO inbox (run_id, offset, kind, content, attrs_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.upsertOutboxStmt = this.db.prepare(`
      INSERT INTO outbox (run_id, idempotency_key, entry_json)
      VALUES (?, ?, ?)
      ON CONFLICT(run_id, idempotency_key)
      DO UPDATE SET entry_json = excluded.entry_json
    `);
    this.upsertProviderSessionStmt = this.db.prepare(`
      INSERT INTO provider_sessions (run_id, node_path, binding_json)
      VALUES (?, ?, ?)
      ON CONFLICT(run_id, node_path)
      DO UPDATE SET binding_json = excluded.binding_json
    `);

    this.upsertTimerStmt = this.db.prepare(`
      INSERT INTO timers (run_id, id, wake_at, payload, kind, created_at, fired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, id)
      DO UPDATE SET
        wake_at = excluded.wake_at,
        payload = excluded.payload,
        kind = excluded.kind,
        created_at = excluded.created_at,
        fired_at = excluded.fired_at
    `);

    this.sqliteLease = new SqliteLease(this.db, options.now ?? Date.now);
    this.lease = this.sqliteLease;

    this.hydrate(options.agents);
  }

  private assertFence(fence: number | undefined): void {
    assertFenceAllowed(this.sqliteLease.activeToken(), fence);
  }

  async get(runId: string): Promise<StoredRun<any> | undefined> {
    return this.runs.get(runId);
  }

  async has(runId: string): Promise<boolean> {
    return this.runs.has(runId);
  }

  async entries(): Promise<Iterable<[string, StoredRun<any>]>> {
    return this.runs.entries();
  }

  async create(
    runId: string,
    run: StoredRun<any>,
    fence?: number,
  ): Promise<void> {
    this.assertFence(fence);
    this.insertRunStmt.run(
      runId,
      run.agentName,
      run.status,
      run.graphCursor ?? null,
      run.graphSuspendedAt ?? null,
      jsonOrNull(run.context),
      JSON.stringify(run.initial.toJSON()),
      jsonOrNull(run.graphManifest),
    );
    this.runs.set(runId, run);
    this.recordJournal(
      runId,
      'create',
      `INSERT runs (${runId}, agent=${run.agentName})`,
    );
  }

  async patch(
    runId: string,
    patch: StoredRunPatch,
    fence?: number,
  ): Promise<void> {
    this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    Object.assign(run, patch);
    this.updateRunStmt.run(
      run.agentName,
      run.status,
      run.graphCursor ?? null,
      run.graphSuspendedAt ?? null,
      jsonOrNull(run.context),
      jsonOrNull(run.graphManifest),
      runId,
    );
    this.recordJournal(runId, 'patch', patchSummary(patch));
  }

  async appendInbox(
    runId: string,
    inbound: Inbound,
    fence?: number,
  ): Promise<void> {
    this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    this.insertInboxStmt.run(
      runId,
      inbound.offset,
      inbound.kind,
      inbound.content,
      jsonOrNull(inbound.attrs),
    );
    // Keep the in-memory inbox in sync with the DB (INSERT OR IGNORE semantics)
    if (!run.inbox[inbound.offset]) {
      run.inbox.push(inbound);
    }
    this.recordJournal(
      runId,
      'appendInbox',
      `INSERT inbox (offset ${inbound.offset}, ${quoteOneLine(
        inbound.content,
      )})`,
    );
  }

  async appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
    fence?: number,
  ): Promise<void> {
    this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    const seq = (
      this.nextSessionDeltaSeqStmt.get(runId) as { seq: number } | undefined
    )?.seq;
    this.insertSessionDeltaStmt.run(
      runId,
      seq ?? 0,
      delta.fromVersion,
      delta.toVersion,
      JSON.stringify(delta.appendedMessages),
      jsonOrNull(delta.varsSet),
      jsonOrNull(delta.varsDeleted),
      delta.rewrite ? 1 : 0,
    );
    applySessionDelta(run, delta);
    this.recordJournal(runId, 'appendSessionDelta', sessionDeltaSummary(delta));
  }

  async recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
    fence?: number,
  ): Promise<void> {
    this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    this.upsertOnceMemoStmt.run(runId, scope, key, JSON.stringify(value));
    run.once[scope].set(key, value);
    this.recordJournal(
      runId,
      'recordOnce',
      `UPSERT once_memo (${scope}, ${quoteOneLine(key)})`,
    );
  }

  async upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
    fence?: number,
  ): Promise<void> {
    this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    this.upsertOutboxStmt.run(
      runId,
      entry.idempotencyKey,
      JSON.stringify(entry),
    );
    const outbox = (run.outbox ??= []);
    const index = outbox.findIndex(
      (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
    );
    if (index >= 0) {
      outbox[index] = entry;
    } else {
      outbox.push(entry);
    }
    this.recordJournal(
      runId,
      'upsertOutbox',
      `UPSERT outbox (${quoteOneLine(entry.idempotencyKey)})`,
    );
  }

  async recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
    fence?: number,
  ): Promise<void> {
    this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    this.upsertProviderSessionStmt.run(
      runId,
      nodePath,
      JSON.stringify(binding),
    );
    run.providerSessions = {
      ...(run.providerSessions ?? {}),
      [nodePath]: binding,
    };
    this.recordJournal(
      runId,
      'recordProviderSession',
      `UPSERT provider_sessions (${nodePath})`,
    );
  }

  async upsertTimer(
    runId: string,
    timer: DurableTimer,
    fence?: number,
  ): Promise<void> {
    this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    this.upsertTimerStmt.run(
      runId,
      timer.id,
      timer.wakeAt,
      timer.payload ?? null,
      timer.kind ?? null,
      timer.createdAt,
      timer.firedAt ?? null,
    );
    const timers = (run.timers ??= []);
    const index = timers.findIndex((candidate) => candidate.id === timer.id);
    if (index >= 0) {
      timers[index] = timer;
    } else {
      timers.push(timer);
    }
    this.recordJournal(
      runId,
      'upsertTimer',
      `UPSERT timers (${quoteOneLine(timer.id)}, wake_at=${timer.wakeAt}${
        timer.firedAt !== undefined ? ', fired' : ''
      })`,
    );
  }

  async delete(runId: string, fence?: number): Promise<void> {
    this.assertFence(fence);
    this.deleteRunStmt.run(runId);
    this.runs.delete(runId);
    this.recordJournal(runId, 'delete', `DELETE runs (${runId})`);
  }

  writesFor(runId: string): SqliteWriteJournalEntry[] {
    return [...(this.writeJournal.get(runId) ?? [])];
  }

  countsFor(runId: string): SqliteRunCounts {
    return {
      runs: this.countRows('runs', runId),
      session_deltas: this.countRows('session_deltas', runId),
      once_memo: this.countRows('once_memo', runId),
      inbox: this.countRows('inbox', runId),
      outbox: this.countRows('outbox', runId),
    };
  }

  close(): void {
    this.db.close();
  }

  private createSchema(): void {
    this.db.exec(`
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
        offset INTEGER NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        attrs_json TEXT,
        PRIMARY KEY (run_id, offset),
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

  private hydrate(agents: Record<string, Agent>): void {
    const runRows = this.db
      .prepare('SELECT * FROM runs ORDER BY run_id')
      .all() as RunRow[];
    const deltaRows = this.db
      .prepare('SELECT * FROM session_deltas ORDER BY run_id, seq')
      .all() as SessionDeltaRow[];
    const onceRows = this.db
      .prepare('SELECT * FROM once_memo ORDER BY run_id, scope, key')
      .all() as OnceMemoRow[];
    const inboxRows = this.db
      .prepare('SELECT * FROM inbox ORDER BY run_id, offset')
      .all() as InboxRow[];
    const outboxRows = this.db
      .prepare('SELECT * FROM outbox ORDER BY run_id, idempotency_key')
      .all() as OutboxRow[];
    const providerRows = this.db
      .prepare('SELECT * FROM provider_sessions ORDER BY run_id, node_path')
      .all() as ProviderSessionRow[];
    const timerRows = this.db
      .prepare('SELECT * FROM timers ORDER BY run_id, id')
      .all() as TimerRow[];

    // Group child rows per run_id, preserving the SELECT ordering so each
    // run's components (deltas in seq order, inbox in offset order, etc.) are
    // assembled exactly as before.
    const deltasByRun = groupBy(deltaRows, (row) => row.run_id);
    const onceByRun = groupBy(onceRows, (row) => row.run_id);
    const inboxByRun = groupBy(inboxRows, (row) => row.run_id);
    const outboxByRun = groupBy(outboxRows, (row) => row.run_id);
    const providerByRun = groupBy(providerRows, (row) => row.run_id);
    const timersByRun = groupBy(timerRows, (row) => row.run_id);

    for (const row of runRows) {
      const deltas: SessionCheckpointDelta<any>[] = (
        deltasByRun.get(row.run_id) ?? []
      ).map((drow) => ({
        fromVersion: drow.from_version,
        toVersion: drow.to_version,
        appendedMessages: normalizeStoredMessages(
          parseJsonRequired(drow.appended_messages_json),
        ),
        varsSet: parseJson(drow.vars_set_json),
        varsDeleted: parseJson(drow.vars_deleted_json),
        rewrite: drow.rewrite === 1,
      }));

      const once: ReconstructOnceEntry[] = (
        onceByRun.get(row.run_id) ?? []
      ).map((orow) => ({
        scope: orow.scope,
        key: orow.key,
        value: parseJson(orow.value_json),
      }));

      const inbox: Inbound[] = (inboxByRun.get(row.run_id) ?? []).map(
        (irow) => ({
          offset: irow.offset,
          kind: irow.kind,
          content: irow.content,
          attrs: parseJson(irow.attrs_json),
        }),
      );

      const outbox: AssistantDeliveryOutboxEntry[] = (
        outboxByRun.get(row.run_id) ?? []
      ).map(
        (brow) => parseJson(brow.entry_json) as AssistantDeliveryOutboxEntry,
      );

      const providerSessions: Record<string, ProviderSessionBinding> = {};
      for (const prow of providerByRun.get(row.run_id) ?? []) {
        providerSessions[prow.node_path] = parseJson(
          prow.binding_json,
        ) as ProviderSessionBinding;
      }

      const timers: DurableTimer[] = (timersByRun.get(row.run_id) ?? []).map(
        (trow) => timerFromRow(trow),
      );

      const run = reconstructStoredRun(
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
        agents,
      );
      this.runs.set(row.run_id, run);
    }
  }

  private countRows(table: keyof SqliteRunCounts, runId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`)
      .get(runId) as { count: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }

  private recordJournal(
    runId: string,
    op: SqliteWriteJournalEntry['op'],
    summary: string,
  ): void {
    const entries = this.writeJournal.get(runId) ?? [];
    entries.push({
      at: new Date().toISOString(),
      runId,
      op,
      summary,
    });
    if (entries.length > SqliteRunStore.maxJournalEntriesPerRun) {
      entries.splice(
        0,
        entries.length - SqliteRunStore.maxJournalEntriesPerRun,
      );
    }
    this.writeJournal.set(runId, entries);
  }
}

function timerFromRow(row: TimerRow): DurableTimer {
  const timer: DurableTimer = {
    id: row.id,
    wakeAt: row.wake_at,
    createdAt: row.created_at,
  };
  if (row.payload !== null) {
    timer.payload = row.payload;
  }
  if (row.kind !== null) {
    timer.kind = row.kind;
  }
  if (row.fired_at !== null) {
    timer.firedAt = row.fired_at;
  }
  return timer;
}

function groupBy<T>(
  rows: readonly T[],
  key: (row: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const bucket = grouped.get(id);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(id, [row]);
    }
  }
  return grouped;
}

function quoteOneLine(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  const truncated =
    compact.length > 72 ? `${compact.slice(0, 69).trimEnd()}...` : compact;
  return JSON.stringify(truncated);
}

function sessionDeltaSummary(delta: SessionCheckpointDelta<any>): string {
  const parts = [
    `v${delta.fromVersion} -> v${delta.toVersion}`,
    `+${delta.appendedMessages.length} messages`,
  ];
  if (delta.rewrite) {
    parts.push('rewrite');
  }
  return `INSERT session_deltas (${parts.join(', ')})`;
}

function patchSummary(patch: StoredRunPatch): string {
  const assignments: string[] = [];
  if ('status' in patch) {
    assignments.push(`status=${patch.status ?? 'null'}`);
  }
  if ('graphCursor' in patch) {
    assignments.push(`graph_cursor=${patch.graphCursor ?? 'null'}`);
  }
  if ('graphSuspendedAt' in patch) {
    assignments.push(`graph_suspended_at=${patch.graphSuspendedAt ?? 'null'}`);
  }
  if ('agentName' in patch) {
    assignments.push(`agent_name=${patch.agentName ?? 'null'}`);
  }
  if ('context' in patch) {
    assignments.push('context_json');
  }
  if ('graphManifest' in patch) {
    assignments.push('graph_manifest_json');
  }
  return `UPDATE runs SET ${assignments.join(', ') || 'metadata'}`;
}
