import type { SkillLoaderContext } from './loader.js';
import { importModule, versionedJsPath } from './loader.js';
import {
  LIVE_TIERS,
  type SkillHealthRecord,
  type SkillRegistry,
  type SkillRegistryRow,
  type SkillTier,
} from './registry.js';
import { skillFromModule } from './skill-module.js';
import type { Skill } from './types.js';

/**
 * The control plane (design-docs/claw-self-authoring.md §9, §10 Phase 2).
 *
 * The supervisor is human-authored, trusted, in-repo code OUTSIDE the
 * self-authoring loop — it observes the per-skill health record and moves trust
 * tiers, but never sits on the per-message hot path. It has three invocation
 * modes, none per-wakeup:
 *
 *   - reactive  — {@link evaluateSupervision}, run by the health wrapper after
 *                 each skill invocation: auto-promote a clean canary, or
 *                 auto-quarantine a skill past its failure threshold (and buffer
 *                 a reactive notice, since the wrapper cannot address a foreign
 *                 channel — see registry.ts SkillNoticeRow).
 *   - scheduled — {@link quarantineScan}, an optional cron scan that catches
 *                 skills which failed while idle (same threshold logic).
 *   - on-demand — the privileged `supervisor` skill's channel commands
 *                 ({@link createSupervisorSkill}): !skills / !promote /
 *                 !quarantine / !restore / !rollback / !why.
 *
 * Capability elevation (write effects) is explicitly NOT in Phase 2: the gate
 * still rejects external writes, so `!promote` only raises the trust tier, never
 * the capability ceiling. The read-only ceiling holds for every self-authored
 * skill at every tier. See README "Skills (Phase 2)".
 */

export interface SupervisionConfig {
  /** Auto-promote canary → trusted after this many clean invocations. */
  promoteAfter: number;
  /** Auto-quarantine at this many consecutive failures. */
  quarantineAfter: number;
  /** Channel a reactive notice is intended for (buffered, surfaced by commands). */
  supervisorChannel?: string;
}

/** Result of one supervision evaluation (for the wrapper's optional logging). */
export interface SupervisionOutcome {
  quarantined?: boolean;
  promoted?: boolean;
}

function isoAt(now: () => number): string {
  return new Date(now()).toISOString();
}

/**
 * Reactive supervision: evaluate a single skill's health after an invocation.
 * Cheap and data-plane (a registry write); called by the health wrapper.
 */
export function evaluateSupervision(
  registry: SkillRegistry,
  skillId: string,
  config: SupervisionConfig,
  now: () => number = Date.now,
): SupervisionOutcome {
  const row = registry.get(skillId);
  const health = registry.getHealth(skillId);
  if (!row || !health) {
    return {};
  }

  // Auto-quarantine: consecutive failures at/over the threshold. Applies to any
  // live tier; the dispatcher then skips the skill exactly like a disabled row.
  if (
    LIVE_TIERS.includes(row.tier) &&
    health.consecutiveFailures >= config.quarantineAfter
  ) {
    const at = isoAt(now);
    registry.setTier(skillId, 'quarantined');
    registry.recordAudit({
      skillId,
      from: row.tier,
      to: 'quarantined',
      reason: `auto: ${health.consecutiveFailures} consecutive failures (>= ${config.quarantineAfter})`,
      actor: 'auto',
      at,
    });
    registry.recordNotice({
      skillId,
      message: `auto-quarantined after ${health.consecutiveFailures} consecutive failures — last error: ${
        health.lastError ?? 'n/a'
      }`,
      at,
    });
    return { quarantined: true };
  }

  // Auto-promote: a clean canary that has accrued enough successful invocations.
  if (
    row.tier === 'canary' &&
    health.consecutiveFailures === 0 &&
    health.successes >= config.promoteAfter
  ) {
    registry.setTier(skillId, 'trusted');
    registry.recordAudit({
      skillId,
      from: 'canary',
      to: 'trusted',
      reason: `auto: ${health.successes} clean invocations (>= ${config.promoteAfter})`,
      actor: 'auto',
      at: isoAt(now),
    });
    return { promoted: true };
  }

  return {};
}

/**
 * Scheduled supervision: sweep every live self-authored skill and quarantine
 * any already over the failure threshold. Catches skills that failed while idle
 * (the reactive path only fires when a skill is invoked). Returns the ids it
 * quarantined. A pure registry operation — safe to call directly (tests) or from
 * a cron binding.
 */
export function quarantineScan(
  registry: SkillRegistry,
  config: SupervisionConfig,
  now: () => number = Date.now,
): string[] {
  const quarantined: string[] = [];
  for (const row of registry.list()) {
    if (row.tier === 'builtin' || !LIVE_TIERS.includes(row.tier)) {
      continue;
    }
    const health = registry.getHealth(row.id);
    if (!health || health.consecutiveFailures < config.quarantineAfter) {
      continue;
    }
    const at = isoAt(now);
    registry.setTier(row.id, 'quarantined');
    registry.recordAudit({
      skillId: row.id,
      from: row.tier,
      to: 'quarantined',
      reason: `scheduled scan: ${health.consecutiveFailures} consecutive failures (>= ${config.quarantineAfter})`,
      actor: 'auto',
      at,
    });
    registry.recordNotice({
      skillId: row.id,
      message: `quarantined by scheduled scan after ${health.consecutiveFailures} consecutive failures — last error: ${
        health.lastError ?? 'n/a'
      }`,
      at,
    });
    quarantined.push(row.id);
  }
  return quarantined;
}

function shortHash(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 10) : 'n/a';
}

function health(
  registry: SkillRegistry,
  id: string,
): SkillHealthRecord | undefined {
  return registry.getHealth(id);
}

function failureCount(h: SkillHealthRecord | undefined): number {
  return h ? h.invocations - h.successes : 0;
}

/** Render the pending-notice banner, marking those notices delivered. */
function drainNotices(registry: SkillRegistry): string {
  const pending = registry.listPendingNotices();
  if (pending.length === 0) {
    return '';
  }
  registry.markNoticesDelivered(pending.map((n) => n.id));
  const lines = pending.map((n) => `  ! ${n.skillId}: ${n.message}`);
  return `Supervisor notices (${pending.length}):\n${lines.join('\n')}\n\n`;
}

function renderSkillsList(registry: SkillRegistry): string {
  const rows = registry.list();
  if (rows.length === 0) {
    return 'No skills registered.';
  }
  const lines = rows.map((row) => {
    const h = health(registry, row.id);
    return [
      row.id,
      `"${row.name}"`,
      `tier=${row.tier}`,
      `enabled=${row.enabled}`,
      `inv=${h?.invocations ?? 0}`,
      `fail=${failureCount(h)}`,
      `hash=${shortHash(row.activeVersion ?? row.manifestHash)}`,
    ].join('  ');
  });
  return `Skills (${rows.length}):\n${lines.join('\n')}`;
}

function renderWhy(registry: SkillRegistry, id: string): string {
  const row = registry.get(id);
  if (!row) {
    return `Unknown skill "${id}".`;
  }
  const h = health(registry, id);
  const gate = row.gateResult as {
    passed?: boolean;
    stages?: { name: string; ok: boolean }[];
  } | null;
  const gateSummary = gate?.stages
    ? gate.stages.map((s) => `${s.name}:${s.ok ? 'ok' : 'FAIL'}`).join(' | ')
    : 'n/a';
  const audit = registry.listAudit(id, 5);
  const auditLines =
    audit.length > 0
      ? audit
          .map(
            (a) => `  ${a.at} ${a.from} → ${a.to} (${a.reason}) [${a.actor}]`,
          )
          .join('\n')
      : '  (none)';
  return [
    `why ${id} (tier=${row.tier}, enabled=${row.enabled}):`,
    `  invocations: ${h?.invocations ?? 0}, successes: ${h?.successes ?? 0}, failures: ${failureCount(h)}, consecutiveFailures: ${h?.consecutiveFailures ?? 0}`,
    `  lastError: ${h?.lastError ?? 'none'}`,
    `  lastLatencyMs: ${h?.lastLatencyMs ?? 'n/a'}`,
    `  activeVersion: ${shortHash(row.activeVersion)} (of ${registry.listVersions(id).length} version(s))`,
    `  gate: ${gateSummary}`,
    `  recent audit:`,
    auditLines,
  ].join('\n');
}

/** Bind a rolled-back module's built artifact back into the live skill map. */
async function rollback(
  ctx: SkillLoaderContext,
  id: string,
  actor: string,
  now: () => number,
): Promise<string> {
  const registry = ctx.registry;
  const row = registry.get(id);
  if (!row) {
    return `Unknown skill "${id}".`;
  }
  const versions = registry.listVersions(id);
  const activeIndex = versions.findIndex(
    (v) => v.manifestHash === row.activeVersion,
  );
  // The immediately-preceding immutable version (insertion order = newest last).
  const from = activeIndex === -1 ? versions.length - 1 : activeIndex;
  if (from <= 0) {
    return `Cannot roll back "${id}": no previous version (only ${versions.length} on record).`;
  }
  const prev = versions[from - 1];
  const jsPath = versionedJsPath(ctx.skillsDir, id, prev.manifestHash);
  let skill: Skill;
  try {
    const module = await importModule(jsPath);
    skill = skillFromModule(module, {
      reply: ctx.replySource,
      provenance: row.provenance,
    });
  } catch (error) {
    return `Rollback of "${id}" failed to load version ${shortHash(
      prev.manifestHash,
    )}: ${error instanceof Error ? error.message : String(error)}`;
  }
  // Rebind the in-process behavior and repoint the active version (instant —
  // the parent graph and live conversations are undisturbed, §8/§9).
  ctx.skills.set(id, skill);
  registry.setActiveVersion(id, {
    manifestHash: prev.manifestHash,
    sourceHash: prev.sourceHash,
  });
  registry.recordAudit({
    skillId: id,
    from: shortHash(row.activeVersion),
    to: shortHash(prev.manifestHash),
    reason: 'rollback (active-version pointer moved)',
    actor,
    at: isoAt(now),
  });
  return `Rolled "${id}" back to version ${shortHash(prev.manifestHash)} (was ${shortHash(
    row.activeVersion,
  )}); it now dispatches the previous behavior.`;
}

/** A single-tier promote/quarantine/restore, with the audit row. */
function transition(
  registry: SkillRegistry,
  id: string,
  to: SkillTier,
  reason: string,
  actor: string,
  now: () => number,
  guard: (row: SkillRegistryRow) => string | undefined,
): string {
  const row = registry.get(id);
  if (!row) {
    return `Unknown skill "${id}".`;
  }
  const rejection = guard(row);
  if (rejection) {
    return rejection;
  }
  registry.setTier(id, to);
  registry.recordAudit({
    skillId: id,
    from: row.tier,
    to,
    reason,
    actor,
    at: isoAt(now),
  });
  return `${id}: ${row.tier} → ${to} (${reason}).`;
}

export interface SupervisorCommandDeps {
  loaderContext: SkillLoaderContext;
  now?: () => number;
}

/**
 * Parse and execute one supervisor command line. Returns the channel-facing
 * reply. Never throws — bad input becomes a usage/error string. Exported for
 * tests and for {@link createSupervisorSkill}.
 */
export async function runSupervisorCommand(
  deps: SupervisorCommandDeps,
  content: string,
  actor: string,
): Promise<string> {
  const registry = deps.loaderContext.registry;
  const now = deps.now ?? Date.now;
  const trimmed = content.trim();
  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const arg = rest[0];

  const requireArg = (): string | undefined =>
    arg ? undefined : `Usage: ${command} <skill-id>`;

  switch (command) {
    case '!skills':
      return drainNotices(registry) + renderSkillsList(registry);

    case '!why': {
      const usage = requireArg();
      if (usage) {
        return usage;
      }
      return drainNotices(registry) + renderWhy(registry, arg);
    }

    case '!promote': {
      const usage = requireArg();
      if (usage) {
        return usage;
      }
      const current = registry.get(arg);
      if (!current) {
        return `Unknown skill "${arg}".`;
      }
      // Promote is ONE step: staged→canary, canary→trusted. Trust tier only —
      // the read-only capability ceiling is unchanged (Phase 2 defers write
      // elevation; see README).
      const target: SkillTier | undefined =
        current.tier === 'staged'
          ? 'canary'
          : current.tier === 'canary'
            ? 'trusted'
            : undefined;
      if (!target) {
        return `Cannot promote "${arg}" from tier "${current.tier}" (promotable: staged→canary, canary→trusted).`;
      }
      return transition(
        registry,
        arg,
        target,
        'promoted (trust tier only; read-only ceiling unchanged — Phase 2 defers write elevation)',
        actor,
        now,
        () => undefined,
      );
    }

    case '!quarantine': {
      const usage = requireArg();
      if (usage) {
        return usage;
      }
      return transition(
        registry,
        arg,
        'quarantined',
        'quarantined by supervisor',
        actor,
        now,
        (row) =>
          row.tier === 'builtin'
            ? `Cannot quarantine builtin skill "${arg}".`
            : undefined,
      );
    }

    case '!restore': {
      const usage = requireArg();
      if (usage) {
        return usage;
      }
      const result = transition(
        registry,
        arg,
        'canary',
        'restored from quarantine (consecutive failures reset)',
        actor,
        now,
        (row) =>
          row.tier === 'quarantined'
            ? undefined
            : `Cannot restore "${arg}" from tier "${row.tier}" (only quarantined skills are restorable).`,
      );
      if (result.includes('→ canary')) {
        registry.resetConsecutiveFailures(arg);
      }
      return result;
    }

    case '!rollback': {
      const usage = requireArg();
      if (usage) {
        return usage;
      }
      return rollback(deps.loaderContext, arg, actor, now);
    }

    default:
      return `Unknown supervisor command "${command}". Try: !skills, !promote <id>, !quarantine <id>, !restore <id>, !rollback <id>, !why <id>.`;
  }
}

const SUPERVISOR_COMMANDS = [
  '!skills',
  '!promote',
  '!quarantine',
  '!restore',
  '!rollback',
  '!why',
] as const;

/** Match a message whose first token is one of the supervisor commands. */
function isSupervisorCommand(content: string): boolean {
  const first = content.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return (SUPERVISOR_COMMANDS as readonly string[]).includes(first);
}

/** Channel + author gate for a supervisor command (matches the author skill). */
export function supervisorAuthorized(input: {
  channel?: string;
  channelId?: string;
  authorId?: string;
  authorName?: string;
  supervisorChannels: string[];
  authors: string[];
}): string | undefined {
  if (input.supervisorChannels.length > 0) {
    const inChannel =
      (input.channel !== undefined &&
        input.supervisorChannels.includes(input.channel)) ||
      (input.channelId !== undefined &&
        input.supervisorChannels.includes(input.channelId));
    if (!inChannel) {
      return 'Supervisor commands are not permitted in this channel.';
    }
  }
  if (input.authors.length > 0) {
    const allowed =
      (input.authorId !== undefined &&
        input.authors.includes(input.authorId)) ||
      (input.authorName !== undefined &&
        input.authors.includes(input.authorName));
    if (!allowed) {
      return 'You are not on the supervisor allowlist (CLAW_AUTHORS).';
    }
  }
  return undefined;
}

export interface SupervisorSkillOptions extends SupervisorCommandDeps {
  /** Channels the supervisor commands are permitted in (same gating as !skill). */
  supervisorChannels: string[];
  /** Optional author allowlist (id or name); empty = any author in-channel. */
  authors: string[];
}

/**
 * The built-in, trusted `supervisor` skill (tier 'builtin', like `status`). It
 * is a normal registry row — the parent graph stays static — whose behavior runs
 * the on-demand supervisor commands. Channel narrowing is on the trigger; author
 * gating is re-checked in-behavior (defense in depth, matching the author skill).
 */
export function createSupervisorSkill(options: SupervisorSkillOptions): Skill {
  const { supervisorChannels, authors } = options;
  return {
    id: 'supervisor',
    name: 'Supervisor',
    trigger: {
      channel: supervisorChannels.length > 0 ? supervisorChannels : undefined,
      predicateKey: `commands:${SUPERVISOR_COMMANDS.join(',')}`,
      when: (content) => isSupervisorCommand(content),
    },
    behavior: (agent) =>
      agent.transform(
        'supervise',
        { effect: { repeatable: true } },
        async (session) => {
          const last = session.getLastMessage();
          const content = last?.content ?? '';
          const attrs = (last?.attrs ?? {}) as Record<string, unknown>;
          const rejection = supervisorAuthorized({
            channel:
              typeof attrs.channel === 'string' ? attrs.channel : undefined,
            channelId:
              typeof attrs.channelId === 'string' ? attrs.channelId : undefined,
            authorId:
              typeof attrs.authorId === 'string' ? attrs.authorId : undefined,
            authorName:
              typeof attrs.author === 'string' ? attrs.author : undefined,
            supervisorChannels,
            authors,
          });
          const actor =
            (typeof attrs.authorId === 'string' && attrs.authorId) ||
            (typeof attrs.author === 'string' && attrs.author) ||
            'unknown';
          const reply =
            rejection ?? (await runSupervisorCommand(options, content, actor));
          return session.addMessage({ type: 'assistant', content: reply });
        },
      ),
    provenance: {
      authoredBy: 'claw-maintainers',
      motivation:
        'Trusted Phase 2 control plane: on-demand supervisor commands (!skills, !promote, !quarantine, !restore, !rollback, !why).',
      createdAt: '2026-07-08T00:00:00.000Z',
    },
  };
}
