import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { SkillProvenance } from './types.js';

/**
 * Persistent SkillRegistry (design-docs/claw-self-authoring.md §7).
 *
 * A deliberately separate abstraction from the run store: its access pattern is
 * load-all-on-boot plus occasional append/enable/disable and per-invocation
 * health writes, not per-run checkpoint deltas. Backed by its own SQLite file
 * via better-sqlite3.
 *
 * Phase 0 rows carry only the *serializable* subset of a skill: the executable
 * `when`/`behavior` live in the in-process skill map (keyed by `behaviorRef`),
 * which the dispatcher joins against at runtime. `channel` + `predicateKey`
 * describe the trigger; `behaviorRef` is the in-process skill id.
 */

/** A persisted skill row (the serializable subset of a {@link Skill}). */
export interface SkillRegistryRow {
  id: string;
  name: string;
  /** Serializable trigger channel narrowing; null means "any channel". */
  channel: string | string[] | null;
  /** Serializable name of the trigger predicate (Phase 0: informational). */
  predicateKey: string;
  /** Reference to the executable skill in the in-process map (Phase 0: id). */
  behaviorRef: string;
  provenance: SkillProvenance;
  enabled: boolean;
  createdAt: string;
}

/** Per-skill health record (design-docs/claw-self-authoring.md §9 Phase 0). */
export interface SkillHealthRecord {
  skillId: string;
  invocations: number;
  successes: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastLatencyMs: number | null;
  updatedAt: string;
}

/** Outcome recorded for one skill invocation. */
export interface SkillHealthUpdate {
  success: boolean;
  latencyMs: number;
  error?: string;
}

interface SkillRow {
  id: string;
  name: string;
  channel: string | null;
  predicate_key: string;
  behavior_ref: string;
  provenance: string;
  enabled: number;
  created_at: string;
}

interface HealthRow {
  skill_id: string;
  invocations: number;
  successes: number;
  consecutive_failures: number;
  last_error: string | null;
  last_latency_ms: number | null;
  updated_at: string;
}

export class SkillRegistry {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        channel TEXT,
        predicate_key TEXT NOT NULL,
        behavior_ref TEXT NOT NULL,
        provenance TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_health (
        skill_id TEXT PRIMARY KEY,
        invocations INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_latency_ms INTEGER,
        updated_at TEXT NOT NULL
      );
    `);
  }

  /** All rows in insertion order, enabled or not. */
  list(): SkillRegistryRow[] {
    const rows = this.db
      .prepare('SELECT * FROM skills ORDER BY rowid')
      .all() as SkillRow[];
    return rows.map(fromSkillRow);
  }

  /** Enabled rows only, in insertion (dispatch-priority) order. */
  listEnabled(): SkillRegistryRow[] {
    const rows = this.db
      .prepare('SELECT * FROM skills WHERE enabled = 1 ORDER BY rowid')
      .all() as SkillRow[];
    return rows.map(fromSkillRow);
  }

  get(id: string): SkillRegistryRow | undefined {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as
      | SkillRow
      | undefined;
    return row ? fromSkillRow(row) : undefined;
  }

  /** Insert a row, replacing any existing row with the same id. */
  upsert(row: SkillRegistryRow): void {
    this.db
      .prepare(
        `INSERT INTO skills
           (id, name, channel, predicate_key, behavior_ref, provenance, enabled, created_at)
         VALUES (@id, @name, @channel, @predicate_key, @behavior_ref, @provenance, @enabled, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           channel = excluded.channel,
           predicate_key = excluded.predicate_key,
           behavior_ref = excluded.behavior_ref,
           provenance = excluded.provenance,
           enabled = excluded.enabled`,
      )
      .run(toSkillRow(row));
  }

  /** Seed a row only if no row with that id exists yet (first-boot seeding). */
  seedIfMissing(row: SkillRegistryRow): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO skills
           (id, name, channel, predicate_key, behavior_ref, provenance, enabled, created_at)
         VALUES (@id, @name, @channel, @predicate_key, @behavior_ref, @provenance, @enabled, @created_at)`,
      )
      .run(toSkillRow(row));
    return result.changes > 0;
  }

  /** Enable/disable a skill by row update (revocation is `false`). */
  setEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE skills SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id);
  }

  /** Record one skill invocation outcome into its health record. */
  recordHealth(skillId: string, update: SkillHealthUpdate): SkillHealthRecord {
    const now = new Date().toISOString();
    const current = this.getHealth(skillId);
    const next: SkillHealthRecord = {
      skillId,
      invocations: (current?.invocations ?? 0) + 1,
      successes: (current?.successes ?? 0) + (update.success ? 1 : 0),
      consecutiveFailures: update.success
        ? 0
        : (current?.consecutiveFailures ?? 0) + 1,
      lastError: update.success
        ? (current?.lastError ?? null)
        : (update.error ?? null),
      lastLatencyMs: update.latencyMs,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO skill_health
           (skill_id, invocations, successes, consecutive_failures, last_error, last_latency_ms, updated_at)
         VALUES (@skill_id, @invocations, @successes, @consecutive_failures, @last_error, @last_latency_ms, @updated_at)
         ON CONFLICT(skill_id) DO UPDATE SET
           invocations = excluded.invocations,
           successes = excluded.successes,
           consecutive_failures = excluded.consecutive_failures,
           last_error = excluded.last_error,
           last_latency_ms = excluded.last_latency_ms,
           updated_at = excluded.updated_at`,
      )
      .run({
        skill_id: next.skillId,
        invocations: next.invocations,
        successes: next.successes,
        consecutive_failures: next.consecutiveFailures,
        last_error: next.lastError,
        last_latency_ms: next.lastLatencyMs,
        updated_at: next.updatedAt,
      });
    return next;
  }

  getHealth(skillId: string): SkillHealthRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM skill_health WHERE skill_id = ?')
      .get(skillId) as HealthRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      skillId: row.skill_id,
      invocations: row.invocations,
      successes: row.successes,
      consecutiveFailures: row.consecutive_failures,
      lastError: row.last_error,
      lastLatencyMs: row.last_latency_ms,
      updatedAt: row.updated_at,
    };
  }

  close(): void {
    this.db.close();
  }
}

function fromSkillRow(row: SkillRow): SkillRegistryRow {
  return {
    id: row.id,
    name: row.name,
    channel:
      row.channel === null
        ? null
        : (JSON.parse(row.channel) as string | string[]),
    predicateKey: row.predicate_key,
    behaviorRef: row.behavior_ref,
    provenance: JSON.parse(row.provenance) as SkillProvenance,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

function toSkillRow(row: SkillRegistryRow): SkillRow {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel === null ? null : JSON.stringify(row.channel),
    predicate_key: row.predicateKey,
    behavior_ref: row.behaviorRef,
    provenance: JSON.stringify(row.provenance),
    enabled: row.enabled ? 1 : 0,
    created_at: row.createdAt,
  };
}
