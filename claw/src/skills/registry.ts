import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { SkillProvenance } from './types.js';

/**
 * Persistent SkillRegistry (design-docs/claw-self-authoring.md §7, §9).
 *
 * A deliberately separate abstraction from the run store: its access pattern is
 * load-all-on-boot plus occasional append/enable/disable, per-invocation health
 * writes, and (Phase 1) gate-provenance + version writes — not per-run
 * checkpoint deltas. Backed by its own SQLite file via better-sqlite3.
 *
 * Rows carry only the *serializable* subset of a skill: the executable
 * `behavior` lives in the in-process skill map (keyed by `behaviorRef`), which
 * the dispatcher joins against at runtime. `channel` + `predicateKey` describe
 * the trigger.
 *
 * Phase 1 additions (trust tiers + active-version pointer, §9):
 *   - `tier`          — 'builtin' (hand-written, trusted) or 'staged' (gated,
 *                       self-authored). Higher tiers land in Phase 2.
 *   - `sourcePath`    — durable `.ts` source location for reload after restart.
 *   - `sourceHash`    — hash of that source; boot re-runs the full gate only if
 *                       it changed.
 *   - `manifestHash`  — the active build's graph manifest hash (excluded from
 *                       the parent manifest, §8).
 *   - `activeVersion` — the active manifest hash pointer; rollback (Phase 2)
 *                       moves it. Past versions are immutable rows in
 *                       `skill_versions`.
 *   - `gateResult`    — the recorded gate outcome JSON (provenance).
 */

/** Trust tier of a skill (design-docs §9). Phase 1 lands builtin + staged. */
export type SkillTier = 'builtin' | 'staged';

/** A persisted skill row (the serializable subset of a Skill + provenance). */
export interface SkillRegistryRow {
  id: string;
  name: string;
  /** Serializable trigger channel narrowing; null means "any channel". */
  channel: string | string[] | null;
  /** Serializable name of the trigger predicate. */
  predicateKey: string;
  /** Reference to the executable skill in the in-process map. */
  behaviorRef: string;
  provenance: SkillProvenance;
  enabled: boolean;
  createdAt: string;
  /** Trust tier (default 'builtin' for seeded hand-written skills). */
  tier: SkillTier;
  /** Durable `.ts` source path (self-authored skills only). */
  sourcePath: string | null;
  /** Hash of the source at `sourcePath` (gate re-run trigger on boot). */
  sourceHash: string | null;
  /** Active build's graph manifest hash. */
  manifestHash: string | null;
  /** Active-version pointer (manifest hash); rollback moves it. */
  activeVersion: string | null;
  /** Recorded gate result JSON (provenance). */
  gateResult: unknown | null;
}

/** An immutable, gated build of a skill, versioned by its manifest hash (§9). */
export interface SkillVersionRow {
  skillId: string;
  manifestHash: string;
  sourceHash: string | null;
  sourcePath: string | null;
  gateResult: unknown | null;
  createdAt: string;
}

/** Per-skill health record (design-docs/claw-self-authoring.md §9). */
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
  tier: string | null;
  source_path: string | null;
  source_hash: string | null;
  manifest_hash: string | null;
  active_version: string | null;
  gate_result: string | null;
}

interface VersionRow {
  skill_id: string;
  manifest_hash: string;
  source_hash: string | null;
  source_path: string | null;
  gate_result: string | null;
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
        created_at TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'builtin',
        source_path TEXT,
        source_hash TEXT,
        manifest_hash TEXT,
        active_version TEXT,
        gate_result TEXT
      );
      CREATE TABLE IF NOT EXISTS skill_versions (
        skill_id TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        source_hash TEXT,
        source_path TEXT,
        gate_result TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (skill_id, manifest_hash)
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
    this.migrateSkillColumns();
  }

  /** Idempotently add Phase 1 columns to a pre-existing Phase 0 `skills` table. */
  private migrateSkillColumns(): void {
    const existing = new Set(
      (
        this.db.prepare('PRAGMA table_info(skills)').all() as { name: string }[]
      ).map((c) => c.name),
    );
    const additions: [string, string][] = [
      ['tier', "TEXT NOT NULL DEFAULT 'builtin'"],
      ['source_path', 'TEXT'],
      ['source_hash', 'TEXT'],
      ['manifest_hash', 'TEXT'],
      ['active_version', 'TEXT'],
      ['gate_result', 'TEXT'],
    ];
    for (const [name, decl] of additions) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE skills ADD COLUMN ${name} ${decl}`);
      }
    }
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

  /**
   * Enabled, self-authored (non-builtin) rows with a durable source path —
   * the set the boot loader re-imports and re-gates (design-docs §7).
   */
  listReloadable(): SkillRegistryRow[] {
    return this.listEnabled().filter(
      (row) => row.tier !== 'builtin' && row.sourcePath !== null,
    );
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
           (id, name, channel, predicate_key, behavior_ref, provenance, enabled, created_at,
            tier, source_path, source_hash, manifest_hash, active_version, gate_result)
         VALUES (@id, @name, @channel, @predicate_key, @behavior_ref, @provenance, @enabled, @created_at,
            @tier, @source_path, @source_hash, @manifest_hash, @active_version, @gate_result)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           channel = excluded.channel,
           predicate_key = excluded.predicate_key,
           behavior_ref = excluded.behavior_ref,
           provenance = excluded.provenance,
           enabled = excluded.enabled,
           tier = excluded.tier,
           source_path = excluded.source_path,
           source_hash = excluded.source_hash,
           manifest_hash = excluded.manifest_hash,
           active_version = excluded.active_version,
           gate_result = excluded.gate_result`,
      )
      .run(toSkillRow(row));
  }

  /** Seed a row only if no row with that id exists yet (first-boot seeding). */
  seedIfMissing(row: SkillRegistryRow): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO skills
           (id, name, channel, predicate_key, behavior_ref, provenance, enabled, created_at,
            tier, source_path, source_hash, manifest_hash, active_version, gate_result)
         VALUES (@id, @name, @channel, @predicate_key, @behavior_ref, @provenance, @enabled, @created_at,
            @tier, @source_path, @source_hash, @manifest_hash, @active_version, @gate_result)`,
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

  /** Append an immutable version row (design-docs §9); idempotent per hash. */
  recordVersion(version: SkillVersionRow): void {
    this.db
      .prepare(
        `INSERT INTO skill_versions
           (skill_id, manifest_hash, source_hash, source_path, gate_result, created_at)
         VALUES (@skill_id, @manifest_hash, @source_hash, @source_path, @gate_result, @created_at)
         ON CONFLICT(skill_id, manifest_hash) DO UPDATE SET
           source_hash = excluded.source_hash,
           source_path = excluded.source_path,
           gate_result = excluded.gate_result`,
      )
      .run({
        skill_id: version.skillId,
        manifest_hash: version.manifestHash,
        source_hash: version.sourceHash,
        source_path: version.sourcePath,
        gate_result:
          version.gateResult === null || version.gateResult === undefined
            ? null
            : JSON.stringify(version.gateResult),
        created_at: version.createdAt,
      });
  }

  /** All immutable versions of a skill, newest last (insertion order). */
  listVersions(skillId: string): SkillVersionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY rowid')
      .all(skillId) as VersionRow[];
    return rows.map(fromVersionRow);
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

function parseJsonOrNull(value: string | null): unknown | null {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
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
    tier: (row.tier as SkillTier | null) ?? 'builtin',
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    manifestHash: row.manifest_hash,
    activeVersion: row.active_version,
    gateResult: parseJsonOrNull(row.gate_result),
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
    tier: row.tier,
    source_path: row.sourcePath,
    source_hash: row.sourceHash,
    manifest_hash: row.manifestHash,
    active_version: row.activeVersion,
    gate_result:
      row.gateResult === null || row.gateResult === undefined
        ? null
        : JSON.stringify(row.gateResult),
  };
}

function fromVersionRow(row: VersionRow): SkillVersionRow {
  return {
    skillId: row.skill_id,
    manifestHash: row.manifest_hash,
    sourceHash: row.source_hash,
    sourcePath: row.source_path,
    gateResult: parseJsonOrNull(row.gate_result),
    createdAt: row.created_at,
  };
}
