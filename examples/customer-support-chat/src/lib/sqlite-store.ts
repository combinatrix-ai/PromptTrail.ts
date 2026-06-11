import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cwd } from 'node:process';
import {
  Session,
  type Agent,
  type AssistantDeliveryOutboxEntry,
  type DurableRunStore,
  type Inbound,
  type OnceScope,
  type ProviderSessionBinding,
  type SessionCheckpointDelta,
  type StoredRun,
  type StoredRunPatch,
  type Vars,
  type Attrs,
} from '@prompttrail/core';

interface SqliteRunStoreOptions {
  path?: string;
  agents: Record<string, Agent>;
}

interface RunRow {
  run_id: string;
  agent_name: string;
  status: StoredRun<any, any>['status'];
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

/**
 * SQLite restart substrate for PromptTrail durable runs.
 *
 * Reads (`get`/`has`/`entries`) are served from hydrated in-memory
 * `StoredRun` objects, matching `MemoryRunStore`. SQLite owns process restart
 * recovery: each granular durable write maps directly to one SQL statement and
 * construction replays those rows into live runs.
 */
export class SqliteRunStore implements DurableRunStore {
  private readonly db: Database.Database;
  private readonly runs = new Map<string, StoredRun<any, any>>();

  private readonly insertRunStmt: Database.Statement;
  private readonly updateRunStmt: Database.Statement;
  private readonly deleteRunStmt: Database.Statement;
  private readonly insertSessionDeltaStmt: Database.Statement;
  private readonly nextSessionDeltaSeqStmt: Database.Statement;
  private readonly upsertOnceMemoStmt: Database.Statement;
  private readonly insertInboxStmt: Database.Statement;
  private readonly upsertOutboxStmt: Database.Statement;
  private readonly upsertProviderSessionStmt: Database.Statement;

  constructor(options: SqliteRunStoreOptions) {
    const dbPath = options.path ?? defaultSupportDbPath();
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

    this.hydrate(options.agents);
  }

  get(runId: string): StoredRun<any, any> | undefined {
    return this.runs.get(runId);
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  entries(): Iterable<[string, StoredRun<any, any>]> {
    return this.runs.entries();
  }

  async create(runId: string, run: StoredRun<any, any>): Promise<void> {
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
  }

  async patch(runId: string, patch: StoredRunPatch): Promise<void> {
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
  }

  async appendInbox(runId: string, inbound: Inbound): Promise<void> {
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
  }

  async appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any, any>,
  ): Promise<void> {
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
  }

  async recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    this.upsertOnceMemoStmt.run(runId, scope, key, JSON.stringify(value));
    run.once[scope].set(key, value);
  }

  async upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry<any>,
  ): Promise<void> {
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
  }

  async recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
  ): Promise<void> {
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
  }

  async delete(runId: string): Promise<void> {
    this.deleteRunStmt.run(runId);
    this.runs.delete(runId);
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

    for (const row of runRows) {
      const agent = agents[row.agent_name];
      if (!agent) {
        throw new Error(
          `Cannot hydrate durable run ${row.run_id}: unknown agent "${row.agent_name}".`,
        );
      }
      const run: StoredRun<any, any> = {
        agent,
        agentName: row.agent_name,
        graphManifest: parseJson(row.graph_manifest_json),
        initial: Session.fromJSON(parseJsonRequired(row.initial_session_json)),
        status: row.status,
        once: { run: new Map(), conversation: new Map() },
        outbox: [],
        inbox: [],
        providerSessions: {},
        graphCursor: row.graph_cursor ?? undefined,
        graphSuspendedAt: row.graph_suspended_at ?? undefined,
        context: parseJson(row.context_json),
      };
      this.runs.set(row.run_id, run);
    }

    for (const row of deltaRows) {
      const run = this.runs.get(row.run_id);
      if (!run) {
        continue;
      }
      applySessionDelta(run, {
        fromVersion: row.from_version,
        toVersion: row.to_version,
        appendedMessages: parseJsonRequired(row.appended_messages_json),
        varsSet: parseJson(row.vars_set_json),
        varsDeleted: parseJson(row.vars_deleted_json),
        rewrite: row.rewrite === 1,
      });
    }

    for (const row of onceRows) {
      this.runs
        .get(row.run_id)
        ?.once[row.scope].set(row.key, parseJson(row.value_json));
    }

    for (const row of inboxRows) {
      this.runs.get(row.run_id)?.inbox.push({
        offset: row.offset,
        kind: row.kind,
        content: row.content,
        attrs: parseJson(row.attrs_json),
      });
    }

    for (const row of outboxRows) {
      this.runs
        .get(row.run_id)
        ?.outbox.push(
          parseJson(row.entry_json) as AssistantDeliveryOutboxEntry,
        );
    }

    for (const row of providerRows) {
      const run = this.runs.get(row.run_id);
      if (!run) {
        continue;
      }
      run.providerSessions = {
        ...(run.providerSessions ?? {}),
        [row.node_path]: parseJson(row.binding_json) as ProviderSessionBinding,
      };
    }
  }
}

export function defaultSupportDbPath(): string {
  if (cwd().endsWith(join('examples', 'customer-support-chat'))) {
    return join(cwd(), '.data', 'support.db');
  }
  return join(
    cwd(),
    'examples',
    'customer-support-chat',
    '.data',
    'support.db',
  );
}

function applySessionDelta<TVars extends Vars, TAttrs extends Attrs>(
  run: StoredRun<TVars, TAttrs>,
  delta: SessionCheckpointDelta<TVars, TAttrs>,
): void {
  const current = run.result ?? run.initial;
  if (current.version >= delta.toVersion) {
    return;
  }
  if (delta.rewrite) {
    run.result = new Session<TVars, TAttrs>(
      [...delta.appendedMessages],
      { ...(delta.varsSet ?? {}) } as TVars,
      current.print,
      delta.toVersion,
      delta.toVersion,
    );
    return;
  }
  const vars = { ...current.vars } as Record<string, unknown>;
  for (const key of delta.varsDeleted ?? []) {
    delete vars[key];
  }
  Object.assign(vars, delta.varsSet);
  run.result = new Session<TVars, TAttrs>(
    [...current.messages, ...delta.appendedMessages],
    vars as TVars,
    current.print,
    delta.toVersion,
  );
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T = any>(json: string | null): T | undefined {
  return json === null ? undefined : (JSON.parse(json) as T);
}

function parseJsonRequired<T = any>(json: string): T {
  return JSON.parse(json) as T;
}
