import { Agent, type Session } from '@prompttrail/core';
import { SkillRegistry } from './registry.js';
import { evaluateSupervision, type SupervisionConfig } from './supervisor.js';
import { MATCHED_SKILL_VAR, type Skill, type SkillContext } from './types.js';

/**
 * Registry-dispatch graph (design-docs/claw-self-authoring.md §3).
 *
 * The parent graph is STATIC:
 *
 *   dispatch (transform)  — reads the registry at runtime, records the first
 *                           matching skill id in a session var
 *   route (conditional)   — then: run the matched skill's behavior subroutine
 *                           else: the existing default reply node
 *
 * Adding/removing/enabling a registry row never changes this shape, so the
 * parent graph's manifest hash is stable and long-lived conversations keep
 * resuming (the whole point of decision §3 / the §8 payoff).
 */

/** Read the dispatch-written matched skill id from an untyped session. */
function readMatchedSkillId(session: Session): string {
  const value = (session.getVarsObject() as Record<string, unknown>)[
    MATCHED_SKILL_VAR
  ];
  return typeof value === 'string' ? value : '';
}

/** Build a {@link SkillContext} from the current session's last message. */
export function toSkillContext(session: Session): SkillContext {
  const last = session.getLastMessage();
  const attrs = (last?.attrs ?? {}) as Record<string, unknown>;
  return {
    content: last?.content ?? '',
    channel: typeof attrs.channel === 'string' ? attrs.channel : undefined,
    channelId:
      typeof attrs.channelId === 'string' ? attrs.channelId : undefined,
    session,
  };
}

function channelMatches(
  configured: string | string[] | null | undefined,
  ctx: SkillContext,
): boolean {
  if (configured === null || configured === undefined) {
    return true;
  }
  const wanted = Array.isArray(configured) ? configured : [configured];
  return wanted.some((c) => c === ctx.channel || c === ctx.channelId);
}

/**
 * Joins persistent registry rows (order, enabled, channel) against the
 * in-process skill map (the executable `when`/`behavior`). Returns the first
 * enabled skill, in registry order, whose channel and predicate both match.
 */
export class SkillDispatcher {
  constructor(
    private readonly registry: SkillRegistry,
    private readonly skills: Map<string, Skill>,
  ) {}

  match(ctx: SkillContext): Skill | undefined {
    for (const row of this.registry.listEnabled()) {
      if (row.tier === 'quarantined') {
        // Quarantined skills are skipped exactly like disabled ones (§9); the
        // supervisor must !restore them before they dispatch again.
        continue;
      }
      const skill = this.skills.get(row.behaviorRef);
      if (!skill) {
        // Unknown ref: warned at boot (validateSkillRegistry); skip at runtime.
        continue;
      }
      if (!channelMatches(row.channel, ctx)) {
        continue;
      }
      if (skill.trigger.when(ctx.content, ctx)) {
        return skill;
      }
    }
    return undefined;
  }
}

/**
 * Runs a skill's behavior subroutine and records the outcome to the registry
 * health record (design-docs §9). This explicit wrapper sits in the dispatch
 * path so every skill invocation is instrumented: invocations, successes,
 * consecutiveFailures, lastError, lastLatencyMs.
 *
 * When a {@link SupervisionConfig} is supplied it also runs the cheap,
 * data-plane REACTIVE supervision step after recording health: auto-promote a
 * clean canary, or auto-quarantine a skill past its failure threshold (both are
 * registry writes; the supervisor is never on the blocking path). Builtin skills
 * (status, author, supervisor itself) are left untouched by supervision.
 */
export async function runSkillInstrumented(
  registry: SkillRegistry,
  skill: Skill,
  session: Session,
  now: () => number = Date.now,
  supervision?: SupervisionConfig,
): Promise<Session> {
  const start = now();
  const supervise = (): void => {
    if (supervision) {
      evaluateSupervision(registry, skill.id, supervision, now);
    }
  };
  try {
    const behaviorAgent = skill.behavior(
      Agent.create(`skill-${skill.id.replace(/[^A-Za-z0-9_-]/g, '-')}`),
    );
    const result = (await behaviorAgent.execute({ session })) as Session;
    registry.recordHealth(skill.id, {
      success: true,
      latencyMs: Math.max(0, now() - start),
    });
    supervise();
    return result;
  } catch (error) {
    registry.recordHealth(skill.id, {
      success: false,
      latencyMs: Math.max(0, now() - start),
      error: error instanceof Error ? error.message : String(error),
    });
    supervise();
    throw error;
  }
}

/** Warn (do not throw) on registry rows whose behaviorRef has no skill. */
export function validateSkillRegistry(
  registry: SkillRegistry,
  skills: Map<string, Skill>,
  warn: (message: string) => void = console.warn,
): void {
  for (const row of registry.list()) {
    if (!skills.has(row.behaviorRef)) {
      warn(
        `Skill registry row "${row.id}" references unknown behavior "${row.behaviorRef}"; it will never match until the skill is loaded.`,
      );
    }
  }
}

export interface ClawSkillAgentOptions {
  registry: SkillRegistry;
  /** Executable skills keyed by id (joined against registry rows). */
  skills: Map<string, Skill>;
  /** Builds the default reply node(s) — today's echo/openai/codex behavior. */
  defaultReply: (agent: Agent) => Agent;
  /** Injectable clock for deterministic health latencies in tests. */
  now?: () => number;
  /** Reactive supervision thresholds (auto-promote / auto-quarantine). */
  supervision?: SupervisionConfig;
}

/**
 * Build claw's static registry-dispatch main agent. The graph shape is fixed
 * regardless of how many skills are registered.
 */
export function createClawSkillAgent(options: ClawSkillAgentOptions): Agent {
  const dispatcher = new SkillDispatcher(options.registry, options.skills);
  const now = options.now ?? Date.now;

  return Agent.create('main')
    .transform('dispatch', (session) => {
      const ctx = toSkillContext(session);
      const matched = dispatcher.match(ctx);
      return session.withVar(MATCHED_SKILL_VAR, matched?.id ?? '');
    })
    .conditional(
      'route',
      ({ session }) => readMatchedSkillId(session).length > 0,
      (thenAgent) =>
        thenAgent.transform(
          'run-skill',
          { effect: { repeatable: true } },
          async (session) => {
            const skillId = readMatchedSkillId(session);
            const skill = options.skills.get(skillId);
            if (!skill) {
              return session;
            }
            return runSkillInstrumented(
              options.registry,
              skill,
              session,
              now,
              options.supervision,
            );
          },
        ),
      (elseAgent) => options.defaultReply(elseAgent),
    );
}
