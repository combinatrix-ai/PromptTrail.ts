import type { SkillSynthesizer } from './authoring.js';
import type { GateResult } from './gate.js';
import { runGate } from './gate.js';
import { promoteAndRegister, type SkillLoaderContext } from './loader.js';
import type { Skill, SkillProvenance } from './types.js';

/**
 * The authoring entry point (design-docs/claw-self-authoring.md §4, §6).
 *
 * A hand-written, TRUSTED, built-in skill triggered by `!skill <instruction>`.
 * It is the meta layer: instruction → synthesize → gate → on pass hot-load and
 * reply with a provenance summary; on fail reply with the failed stage + detail.
 *
 * Authorization (§6): dispatch is narrowed to `CLAW_AUTHORING_CHANNELS` via the
 * trigger channel, and (defense in depth) the behavior re-checks the channel and
 * an optional `CLAW_AUTHORS` allowlist before doing any work. Authoring is
 * rate-limited to one run at a time via a simple mutex — synthesis + the gate
 * subprocesses are heavy and must not overlap.
 */

/** One-authoring-run-at-a-time gate (trivial rate limit, §4 step 6). */
export class AuthoringMutex {
  private busy = false;

  async run<T>(
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.busy) {
      return { ran: false };
    }
    this.busy = true;
    try {
      return { ran: true, value: await fn() };
    } finally {
      this.busy = false;
    }
  }
}

const AUTHOR_PREFIX = '!skill';

/** Extract `meta.id` from module source to name the staging dir (pre-import). */
function extractModuleId(source: string): string {
  const match = source.match(/id:\s*['"]([A-Za-z][A-Za-z0-9_-]*)['"]/);
  return match ? match[1] : 'skill-candidate';
}

function stageGlyph(ok: boolean): string {
  return ok ? 'ok' : 'FAIL';
}

function summarizeGate(result: GateResult): string {
  return result.stages
    .map((stage) => `${stage.name} ${stageGlyph(stage.ok)}`)
    .join(' | ');
}

function channelLabel(channels: string[] | undefined): string {
  return channels && channels.length > 0 ? channels.join(', ') : 'any channel';
}

export interface AuthoringDeps {
  loaderContext: SkillLoaderContext;
  synthesizer: SkillSynthesizer;
  /** ISO clock (injectable for tests). */
  now?: () => number;
}

/**
 * The core pipeline: synthesize → gate → (pass) promote+register / (fail)
 * report. Returns the channel-facing reply text. Never throws — synthesis and
 * gate failures become reportable strings so the author always hears back.
 */
export async function runAuthoring(
  deps: AuthoringDeps,
  instruction: string,
  authoredBy: string,
): Promise<string> {
  const now = deps.now ?? Date.now;
  let source: string;
  try {
    source = await deps.synthesizer.synthesize(instruction);
  } catch (error) {
    return `Skill synthesis failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  const gate = await runGate(
    { id: extractModuleId(source), source },
    deps.loaderContext.gateOptions,
  );

  if (
    !gate.result.passed ||
    !gate.module ||
    !gate.builtPath ||
    !gate.sourcePath
  ) {
    const failed = gate.result.stages.find((s) => !s.ok);
    return [
      `Skill authoring REJECTED by the verification gate (${gate.result.durationMs}ms).`,
      `Failed stage: ${failed?.name ?? 'unknown'}`,
      `Detail: ${(failed?.detail ?? 'no detail').slice(0, 900)}`,
      `Stages: ${summarizeGate(gate.result)}`,
    ].join('\n');
  }

  const provenance: SkillProvenance = {
    authoredBy,
    motivation: instruction,
    createdAt: new Date(now()).toISOString(),
  };

  let skill: Skill;
  try {
    skill = promoteAndRegister(deps.loaderContext, {
      module: gate.module,
      stagingSourcePath: gate.sourcePath,
      stagingBuiltPath: gate.builtPath,
      source,
      gateResult: gate.result,
      provenance,
    });
  } catch (error) {
    return `Gate passed but hot-load failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  return [
    `Authored and activated skill "${skill.id}" (${skill.name}).`,
    `Trigger: ${skill.trigger.predicateKey} in ${channelLabel(gate.module.trigger.channels)}`,
    `Gate (${gate.result.durationMs}ms): ${summarizeGate(gate.result)}`,
    `Manifest: ${gate.result.manifestHash ?? 'n/a'}`,
    `Disable: set the "${skill.id}" registry row enabled=0 (dispatcher stops matching; live conversations unaffected).`,
  ].join('\n');
}

export interface AuthorSkillOptions extends AuthoringDeps {
  /** Channels where `!skill` authoring is permitted (trigger + behavior gate). */
  authoringChannels: string[];
  /** Optional author allowlist (id or name); empty = any author in-channel. */
  authors: string[];
  mutex?: AuthoringMutex;
}

/**
 * Build the trusted, built-in authoring skill. It is registered like any other
 * skill (tier 'builtin') but its behavior runs the privileged authoring
 * pipeline. Channel narrowing is on the trigger; author gating is in-behavior.
 */
export function createAuthorSkill(options: AuthorSkillOptions): Skill {
  const mutex = options.mutex ?? new AuthoringMutex();
  const authoringChannels = options.authoringChannels;
  const authors = options.authors;

  return {
    id: 'author-skill',
    name: 'Skill Authoring',
    trigger: {
      channel: authoringChannels.length > 0 ? authoringChannels : undefined,
      predicateKey: `startsWith:${AUTHOR_PREFIX}`,
      when: (content) =>
        content.trimStart().toLowerCase().startsWith(AUTHOR_PREFIX),
    },
    behavior: (agent) =>
      agent.transform(
        'author',
        { effect: { repeatable: true } },
        async (session) => {
          const last = session.getLastMessage();
          const content = last?.content ?? '';
          const attrs = (last?.attrs ?? {}) as Record<string, unknown>;
          const channel =
            typeof attrs.channel === 'string' ? attrs.channel : undefined;
          const channelId =
            typeof attrs.channelId === 'string' ? attrs.channelId : undefined;
          const authorId =
            typeof attrs.authorId === 'string' ? attrs.authorId : undefined;
          const authorName =
            typeof attrs.author === 'string' ? attrs.author : undefined;

          const reply = await authorTurn({
            content,
            channel,
            channelId,
            authorId,
            authorName,
            authoringChannels,
            authors,
            mutex,
            deps: options,
          });
          return session.addMessage({ type: 'assistant', content: reply });
        },
      ),
    provenance: {
      authoredBy: 'claw-maintainers',
      motivation:
        'Trusted Phase 1 authoring entry point: `!skill <instruction>` synthesizes, gates, and hot-loads a new skill.',
      createdAt: '2026-07-08T00:00:00.000Z',
    },
  };
}

interface AuthorTurnInput {
  content: string;
  channel?: string;
  channelId?: string;
  authorId?: string;
  authorName?: string;
  authoringChannels: string[];
  authors: string[];
  mutex: AuthoringMutex;
  deps: AuthoringDeps;
}

/** Authorization + rate-limit wrapper around {@link runAuthoring}. Exported for tests. */
export async function authorTurn(input: AuthorTurnInput): Promise<string> {
  // Channel gate (defense in depth; the trigger already narrows dispatch).
  if (input.authoringChannels.length > 0) {
    const inChannel =
      (input.channel !== undefined &&
        input.authoringChannels.includes(input.channel)) ||
      (input.channelId !== undefined &&
        input.authoringChannels.includes(input.channelId));
    if (!inChannel) {
      return 'Skill authoring is not permitted in this channel.';
    }
  }

  // Author allowlist (optional).
  if (input.authors.length > 0) {
    const allowed =
      (input.authorId !== undefined &&
        input.authors.includes(input.authorId)) ||
      (input.authorName !== undefined &&
        input.authors.includes(input.authorName));
    if (!allowed) {
      return 'You are not on the skill-authoring allowlist (CLAW_AUTHORS).';
    }
  }

  const instruction = input.content
    .trimStart()
    .slice(AUTHOR_PREFIX.length)
    .trim();
  if (instruction.length === 0) {
    return 'Usage: !skill <instruction> — describe the trigger and behavior of the skill to author.';
  }

  const outcome = await input.mutex.run(() =>
    runAuthoring(
      input.deps,
      instruction,
      input.authorId ?? input.authorName ?? 'unknown',
    ),
  );
  if (!outcome.ran) {
    return 'Another skill is being authored right now; please retry in a moment.';
  }
  return outcome.value;
}
