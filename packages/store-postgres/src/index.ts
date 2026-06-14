import type { Pool, PoolClient } from 'pg';
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

export interface PostgresRunStoreOptions {
  pool?: Pool;
  connectionString?: string;
  agents: Record<string, Agent>;
  /** Override the pool factory — mainly for injecting a pg-mem pool in tests. */
  clientFactory?: () => Pool;
}

/**
 * PostgreSQL durable run store for PromptTrail.
 *
 * Reads (get/has/entries) are LAZY: each call queries the database and
 * reconstructs a fresh StoredRun from the stored rows. There is no in-memory
 * hydration on startup. Writes are write-through: each durable-store write
 * maps to a single parameterised SQL statement.
 *
 * Construction is async: use `PostgresRunStore.open(options)` which runs
 * CREATE TABLE IF NOT EXISTS before returning the store instance.
 */
export class PostgresRunStore implements DurableRunStore {
  private constructor(
    private readonly pool: Pool,
    private readonly agents: Record<string, Agent>,
  ) {}

  /**
   * Open a PostgresRunStore, creating the schema if it does not exist.
   * Pass an injected `pool` for testing (e.g. pg-mem) or a `connectionString`
   * for production use.
   */
  static async open(
    options: PostgresRunStoreOptions,
  ): Promise<PostgresRunStore> {
    let pool: Pool;
    if (options.pool) {
      pool = options.pool;
    } else if (options.clientFactory) {
      pool = options.clientFactory();
    } else if (options.connectionString) {
      // Lazy import so the package compiles even in pg-mem test environments
      const { Pool: PgPool } = await import('pg');
      pool = new PgPool({ connectionString: options.connectionString });
    } else {
      throw new Error(
        'PostgresRunStore.open requires pool, clientFactory, or connectionString.',
      );
    }
    const store = new PostgresRunStore(pool, options.agents);
    await store.createSchema();
    return store;
  }

  async get(runId: string): Promise<StoredRun<any> | undefined> {
    const client = await this.pool.connect();
    try {
      return await this.reconstructRun(client, runId);
    } finally {
      client.release();
    }
  }

  async has(runId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        'SELECT 1 FROM runs WHERE run_id = $1 LIMIT 1',
        [runId],
      );
      return res.rowCount !== null && res.rowCount > 0;
    } finally {
      client.release();
    }
  }

  async entries(): Promise<Iterable<[string, StoredRun<any>]>> {
    const client = await this.pool.connect();
    try {
      const res = await client.query('SELECT run_id FROM runs ORDER BY run_id');
      const pairs: [string, StoredRun<any>][] = [];
      for (const row of res.rows as { run_id: string }[]) {
        const run = await this.reconstructRun(client, row.run_id);
        if (run) {
          pairs.push([row.run_id, run]);
        }
      }
      return pairs;
    } finally {
      client.release();
    }
  }

  async create(runId: string, run: StoredRun<any>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO runs (
          run_id,
          agent_name,
          status,
          graph_cursor,
          graph_suspended_at,
          context_json,
          initial_session_json,
          graph_manifest_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          runId,
          run.agentName,
          run.status,
          run.graphCursor ?? null,
          run.graphSuspendedAt ?? null,
          jsonOrNull(run.context),
          JSON.stringify(run.initial.toJSON()),
          jsonOrNull(run.graphManifest),
        ],
      );
    } finally {
      client.release();
    }
  }

  async patch(runId: string, patch: StoredRunPatch): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Read current run to merge patch (we need current values for missing patch fields)
      const res = await client.query(
        `SELECT agent_name, status, graph_cursor, graph_suspended_at, context_json, graph_manifest_json
         FROM runs WHERE run_id = $1`,
        [runId],
      );
      if (res.rowCount === 0 || res.rowCount === null) {
        return;
      }
      const current = res.rows[0] as {
        agent_name: string;
        status: string;
        graph_cursor: number | null;
        graph_suspended_at: string | null;
        context_json: string | null;
        graph_manifest_json: string | null;
      };

      await client.query(
        `UPDATE runs SET
          agent_name = $1,
          status = $2,
          graph_cursor = $3,
          graph_suspended_at = $4,
          context_json = $5,
          graph_manifest_json = $6
        WHERE run_id = $7`,
        [
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
      );
    } finally {
      client.release();
    }
  }

  async appendInbox(runId: string, inbound: Inbound): Promise<void> {
    const client = await this.pool.connect();
    try {
      // INSERT ... ON CONFLICT DO NOTHING for offset idempotency
      await client.query(
        `INSERT INTO inbox (run_id, offset_num, kind, content, attrs_json)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (run_id, offset_num) DO NOTHING`,
        [
          runId,
          inbound.offset,
          inbound.kind,
          inbound.content,
          jsonOrNull(inbound.attrs),
        ],
      );
    } finally {
      client.release();
    }
  }

  async appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Compute next seq
      const seqRes = await client.query(
        `SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM session_deltas WHERE run_id = $1`,
        [runId],
      );
      const seq: number = Number((seqRes.rows[0] as { seq: unknown }).seq);

      await client.query(
        `INSERT INTO session_deltas (
          run_id,
          seq,
          from_version,
          to_version,
          appended_messages_json,
          vars_set_json,
          vars_deleted_json,
          rewrite
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          runId,
          seq,
          delta.fromVersion,
          delta.toVersion,
          JSON.stringify(delta.appendedMessages),
          jsonOrNull(delta.varsSet),
          jsonOrNull(delta.varsDeleted),
          delta.rewrite ? 1 : 0,
        ],
      );
    } finally {
      client.release();
    }
  }

  async recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO once_memo (run_id, scope, key, value_json)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (run_id, scope, key)
         DO UPDATE SET value_json = EXCLUDED.value_json`,
        [runId, scope, key, JSON.stringify(value)],
      );
    } finally {
      client.release();
    }
  }

  async upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO outbox (run_id, idempotency_key, entry_json)
         VALUES ($1, $2, $3)
         ON CONFLICT (run_id, idempotency_key)
         DO UPDATE SET entry_json = EXCLUDED.entry_json`,
        [runId, entry.idempotencyKey, JSON.stringify(entry)],
      );
    } finally {
      client.release();
    }
  }

  async recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO provider_sessions (run_id, node_path, binding_json)
         VALUES ($1, $2, $3)
         ON CONFLICT (run_id, node_path)
         DO UPDATE SET binding_json = EXCLUDED.binding_json`,
        [runId, nodePath, JSON.stringify(binding)],
      );
    } finally {
      client.release();
    }
  }

  async delete(runId: string): Promise<void> {
    // Delete the run AND all of its child rows in a single transaction.
    // We deliberately do NOT rely on FOREIGN KEY ... ON DELETE CASCADE here:
    // the schema omits FK constraints for pg-mem compatibility, so child rows
    // in session_deltas/once_memo/inbox/outbox/provider_sessions would
    // otherwise be orphaned — leaking storage and corrupting a later run that
    // reuses the same runId (reconstructRun would fold the old child rows into
    // the new run). Real-Postgres deployments MAY also add FK ON DELETE CASCADE
    // via migration, but delete() must not depend on it.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM session_deltas WHERE run_id = $1', [
        runId,
      ]);
      await client.query('DELETE FROM once_memo WHERE run_id = $1', [runId]);
      await client.query('DELETE FROM inbox WHERE run_id = $1', [runId]);
      await client.query('DELETE FROM outbox WHERE run_id = $1', [runId]);
      await client.query('DELETE FROM provider_sessions WHERE run_id = $1', [
        runId,
      ]);
      await client.query('DELETE FROM runs WHERE run_id = $1', [runId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Close the connection pool. Call during disposal. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  // -------------------------------------------------------------------------
  // Schema creation
  // -------------------------------------------------------------------------

  private async createSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // NOTE on pg-mem v3 compatibility:
      // pg-mem's CREATE TABLE IF NOT EXISTS fails on re-execution when the
      // table already exists because it validates the full column-constraint AST
      // even when skipping creation. We guard each CREATE with a prior
      // information_schema check so the DDL is only run once per table.
      // Real Postgres accepts repeated CREATE TABLE IF NOT EXISTS fine.
      //
      // NOTE on FOREIGN KEY ... ON DELETE CASCADE:
      // pg-mem v3 does not support FK constraints. We omit them here; delete()
      // explicitly removes the run row, and child rows are cleaned up by the
      // DELETE in test teardown. A production Postgres migration would add the
      // FK constraints via ALTER TABLE.
      const tables: Record<string, string> = {
        runs: `CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          agent_name TEXT NOT NULL,
          status TEXT NOT NULL,
          graph_cursor INTEGER,
          graph_suspended_at TEXT,
          context_json TEXT,
          initial_session_json TEXT NOT NULL,
          graph_manifest_json TEXT
        )`,
        session_deltas: `CREATE TABLE session_deltas (
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          from_version INTEGER NOT NULL,
          to_version INTEGER NOT NULL,
          appended_messages_json TEXT NOT NULL,
          vars_set_json TEXT,
          vars_deleted_json TEXT,
          rewrite INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (run_id, seq)
        )`,
        once_memo: `CREATE TABLE once_memo (
          run_id TEXT NOT NULL,
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY (run_id, scope, key)
        )`,
        inbox: `CREATE TABLE inbox (
          run_id TEXT NOT NULL,
          offset_num INTEGER NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          attrs_json TEXT,
          PRIMARY KEY (run_id, offset_num)
        )`,
        outbox: `CREATE TABLE outbox (
          run_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          PRIMARY KEY (run_id, idempotency_key)
        )`,
        provider_sessions: `CREATE TABLE provider_sessions (
          run_id TEXT NOT NULL,
          node_path TEXT NOT NULL,
          binding_json TEXT NOT NULL,
          PRIMARY KEY (run_id, node_path)
        )`,
      };

      for (const [tableName, ddl] of Object.entries(tables)) {
        const res = await client.query(
          `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
          [tableName],
        );
        if (res.rowCount === 0 || res.rowCount === null) {
          await client.query(ddl);
        }
      }
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Lazy reconstruction (ported from SqliteRunStore.hydrate, per-run)
  // -------------------------------------------------------------------------

  private async reconstructRun(
    client: PoolClient,
    runId: string,
  ): Promise<StoredRun<any> | undefined> {
    // 1. Load the run row
    const runRes = await client.query(
      `SELECT run_id, agent_name, status, graph_cursor, graph_suspended_at,
              context_json, initial_session_json, graph_manifest_json
       FROM runs WHERE run_id = $1`,
      [runId],
    );
    if (runRes.rowCount === 0 || runRes.rowCount === null) {
      return undefined;
    }
    const row = runRes.rows[0] as {
      run_id: string;
      agent_name: string;
      status: StoredRun<any>['status'];
      graph_cursor: number | null;
      graph_suspended_at: string | null;
      context_json: string | null;
      initial_session_json: string;
      graph_manifest_json: string | null;
    };

    // 2. Gather session deltas in seq order (parsed + normalized).
    const deltaRes = await client.query(
      `SELECT from_version, to_version, appended_messages_json,
              vars_set_json, vars_deleted_json, rewrite
       FROM session_deltas
       WHERE run_id = $1
       ORDER BY seq ASC`,
      [runId],
    );
    const deltas: SessionCheckpointDelta<any>[] = (
      deltaRes.rows as {
        from_version: number;
        to_version: number;
        appended_messages_json: string;
        vars_set_json: string | null;
        vars_deleted_json: string | null;
        rewrite: number;
      }[]
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

    // 3. Gather once_memo entries.
    const onceRes = await client.query(
      `SELECT scope, key, value_json FROM once_memo WHERE run_id = $1`,
      [runId],
    );
    const once: ReconstructOnceEntry[] = (
      onceRes.rows as {
        scope: OnceScope;
        key: string;
        value_json: string;
      }[]
    ).map((orow) => ({
      scope: orow.scope,
      key: orow.key,
      value: parseJson(orow.value_json),
    }));

    // 4. Gather inbox entries ordered by offset.
    const inboxRes = await client.query(
      `SELECT offset_num, kind, content, attrs_json
       FROM inbox WHERE run_id = $1 ORDER BY offset_num ASC`,
      [runId],
    );
    const inbox: Inbound[] = (
      inboxRes.rows as {
        offset_num: number;
        kind: Inbound['kind'];
        content: string;
        attrs_json: string | null;
      }[]
    ).map((irow) => ({
      offset: irow.offset_num,
      kind: irow.kind,
      content: irow.content,
      attrs: parseJson(irow.attrs_json),
    }));

    // 5. Gather outbox entries.
    const outboxRes = await client.query(
      `SELECT entry_json FROM outbox WHERE run_id = $1`,
      [runId],
    );
    const outbox: AssistantDeliveryOutboxEntry[] = (
      outboxRes.rows as { entry_json: string }[]
    ).map((brow) => parseJson(brow.entry_json) as AssistantDeliveryOutboxEntry);

    // 6. Gather provider_sessions.
    const provRes = await client.query(
      `SELECT node_path, binding_json FROM provider_sessions WHERE run_id = $1`,
      [runId],
    );
    const providerSessions: Record<string, ProviderSessionBinding> = {};
    for (const prow of provRes.rows as {
      node_path: string;
      binding_json: string;
    }[]) {
      providerSessions[prow.node_path] = parseJson(
        prow.binding_json,
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
