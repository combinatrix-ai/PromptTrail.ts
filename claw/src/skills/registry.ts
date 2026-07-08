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

/**
 * Trust tier of a skill (design-docs §9).
 *   - 'builtin'     — hand-written, trusted, outside the self-authoring loop.
 *   - 'staged'      — gate-passed but not yet activated (a transient logical
 *                     state; the authoring flow immediately activates to canary).
 *   - 'canary'      — live and dispatching, but flagged for close watching and
 *                     capped at the read-only ceiling (Phase 1 behavior IS this).
 *   - 'trusted'     — auto-promoted from canary after N clean invocations; still
 *                     read-only in Phase 2 (write elevation is deferred).
 *   - 'quarantined' — auto- or hand-demoted past the failure threshold; the
 *                     dispatcher skips it exactly like a disabled row.
 */
export type SkillTier =
  | 'builtin'
  | 'staged'
  | 'canary'
  | 'trusted'
  | 'quarantined';

/** Live tiers whose failure/clean-run streaks the supervisor evaluates. */
export const LIVE_TIERS: readonly SkillTier[] = ['canary', 'trusted'];

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

/**
 * Provenance/audit row: one per tier transition (design-docs §9, §10 Phase 2).
 * `from`/`to` are tier names for tier moves and short manifest hashes for a
 * rollback; `actor` is 'auto' (supervisor logic) or an author/supervisor id.
 */
export interface SkillAuditRow {
  skillId: string;
  from: string;
  to: string;
  reason: string;
  actor: string;
  at: string;
}

/**
 * A buffered reactive-supervisor notice (design-docs §9). Delivering a message
 * to CLAW_SUPERVISOR_CHANNEL from inside the health wrapper is awkward in claw's
 * message-triggered binding model (the wrapper runs while replying to the
 * *triggering* message, with no handle to a different channel), so an
 * auto-quarantine records a durable pending-notice row instead. The next
 * supervisor command (`!skills`/`!why`) or the scheduled scan surfaces it.
 */
export interface SkillNoticeRow {
  id: number;
  skillId: string;
  message: string;
  createdAt: string;
  delivered: boolean;
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

interface AuditRow {
  skill_id: string;
  from_tier: string;
  to_tier: string;
  reason: string;
  actor: string;
  at: string;
}

interface NoticeRow {
  id: number;
  skill_id: string;
  message: string;
  created_at: string;
  delivered: number;
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
      CREATE TABLE IF NOT EXISTS skill_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT NOT NULL,
        from_tier TEXT NOT NULL,
        to_tier TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_notices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0
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

  /** Move a skill's trust tier (design-docs §9); a pure registry write. */
  setTier(id: string, tier: SkillTier): void {
    this.db.prepare('UPDATE skills SET tier = ? WHERE id = ?').run(tier, id);
  }

  /**
   * Repoint the active-version pointer (design-docs §9 rollback). Moves
   * `active_version` and mirrors the build's `manifest_hash`/`source_hash` so a
   * later restart's fast-path reload trusts the rolled-back build.
   */
  setActiveVersion(
    id: string,
    version: { manifestHash: string; sourceHash: string | null },
  ): void {
    this.db
      .prepare(
        'UPDATE skills SET active_version = ?, manifest_hash = ?, source_hash = ? WHERE id = ?',
      )
      .run(version.manifestHash, version.manifestHash, version.sourceHash, id);
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

  /** Clear the consecutive-failure streak and last error (design-docs §9 restore). */
  resetConsecutiveFailures(skillId: string): void {
    this.db
      .prepare(
        'UPDATE skill_health SET consecutive_failures = 0, last_error = NULL, updated_at = ? WHERE skill_id = ?',
      )
      .run(new Date().toISOString(), skillId);
  }

  /** Append a provenance/audit row for one tier transition (design-docs §9). */
  recordAudit(entry: SkillAuditRow): void {
    this.db
      .prepare(
        `INSERT INTO skill_audit (skill_id, from_tier, to_tier, reason, actor, at)
         VALUES (@skill_id, @from_tier, @to_tier, @reason, @actor, @at)`,
      )
      .run({
        skill_id: entry.skillId,
        from_tier: entry.from,
        to_tier: entry.to,
        reason: entry.reason,
        actor: entry.actor,
        at: entry.at,
      });
  }

  /** Recent audit rows for a skill, newest first (default 10). */
  listAudit(skillId: string, limit = 10): SkillAuditRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM skill_audit WHERE skill_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(skillId, limit) as AuditRow[];
    return rows.map(fromAuditRow);
  }

  /** Buffer a reactive-supervisor notice for later delivery (design-docs §9). */
  recordNotice(notice: { skillId: string; message: string; at: string }): void {
    this.db
      .prepare(
        `INSERT INTO skill_notices (skill_id, message, created_at, delivered)
         VALUES (?, ?, ?, 0)`,
      )
      .run(notice.skillId, notice.message, notice.at);
  }

  /** Undelivered notices, oldest first. */
  listPendingNotices(): SkillNoticeRow[] {
    const rows = this.db
      .prepare('SELECT * FROM skill_notices WHERE delivered = 0 ORDER BY id')
      .all() as NoticeRow[];
    return rows.map(fromNoticeRow);
  }

  /** Mark notices delivered so a later command/scan does not re-report them. */
  markNoticesDelivered(ids: readonly number[]): void {
    if (ids.length === 0) {
      return;
    }
    const stmt = this.db.prepare(
      'UPDATE skill_notices SET delivered = 1 WHERE id = ?',
    );
    const tx = this.db.transaction((batch: readonly number[]) => {
      for (const id of batch) {
        stmt.run(id);
      }
    });
    tx(ids);
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

function fromAuditRow(row: AuditRow): SkillAuditRow {
  return {
    skillId: row.skill_id,
    from: row.from_tier,
    to: row.to_tier,
    reason: row.reason,
    actor: row.actor,
    at: row.at,
  };
}

function fromNoticeRow(row: NoticeRow): SkillNoticeRow {
  return {
    id: row.id,
    skillId: row.skill_id,
    message: row.message,
    createdAt: row.created_at,
    delivered: row.delivered === 1,
  };
}
