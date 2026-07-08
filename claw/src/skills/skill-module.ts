import type { Agent, ModelOutput, Source } from '@prompttrail/core';
import type { Skill, SkillProvenance, SkillTrigger } from './types.js';

/**
 * The reply `Source` injected into a skill's `behavior`. Authored modules
 * annotate the parameter as `Source<string>` (simpler for the synthesizer), but
 * production injects claw's configured LLM source (`Source<ModelOutput>`) and
 * the gate injects a mock string source — so the contract accepts either.
 */
export type SkillReplySource = Source<string> | Source<ModelOutput>;

/**
 * Phase 1 skill module format (design-docs/claw-self-authoring.md §2, §11).
 *
 * A self-authored skill is a SINGLE TypeScript file exporting the shape below.
 * The whole point is that this is *typed data + one prompt-only builder*, not
 * prose:
 *
 * ```ts
 * import type { Agent, Source } from '@prompttrail/core';
 * export const meta = { id, name, description };
 * export const trigger = { channels?, startsWith?, regex? };
 * export const examples: string[];
 * export function behavior(agent: Agent, reply: Source<string>): Agent {
 *   return agent.system('...').assistant('reply', reply);
 * }
 * ```
 *
 * Design constraints that make the gate tractable in Phase 1:
 *
 *  - The trigger is **serializable data** (channels + startsWith/regex), NOT an
 *    arbitrary `when` predicate. An arbitrary predicate is itself code the gate
 *    would have to reason about (§11 "trigger expressiveness") — that is Phase 2.
 *  - `behavior` takes the reply `Source` as a **parameter**. In production claw
 *    injects its configured source (LLM in openai mode, echo otherwise); the
 *    verification gate injects a mock/echo source so the smoke harness never
 *    touches the network. Because the module imports core only as `type`, the
 *    compiled artifact has ZERO runtime import of `@prompttrail/core` — it is
 *    pure data + a builder over the caller-supplied `agent`/`reply`, which also
 *    removes any dual-package (src-vs-dist) hazard when the gate imports it.
 */

/** Identity block of a skill module. */
export interface SkillModuleMeta {
  id: string;
  name: string;
  description: string;
}

/**
 * Phase 1 serializable trigger. `channels` narrows which channels the skill
 * applies to (undefined = any). Exactly one of `startsWith`/`regex` selects the
 * match condition; if neither is present the skill matches every message in
 * scope. No arbitrary predicates (that is Phase 2 — see file header).
 */
export interface SkillModuleTrigger {
  channels?: string[];
  startsWith?: string;
  regex?: string;
}

/** The full module surface a `staging/<id>.ts` file must export. */
export interface SkillModule {
  meta: SkillModuleMeta;
  trigger: SkillModuleTrigger;
  examples: string[];
  behavior: (agent: Agent, reply: SkillReplySource) => Agent;
}

/** Skill ids must be stable graph ids (they become an `Agent.create` name). */
const STABLE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Structurally validate a dynamically imported module before the gate trusts
 * it. Runs on both freshly synthesized modules and modules reloaded from disk
 * on boot. Throws with a precise reason so the failure is reportable in-channel.
 */
export function assertSkillModule(
  candidate: unknown,
): asserts candidate is SkillModule {
  const mod = candidate as Partial<SkillModule> | null | undefined;
  if (!mod || typeof mod !== 'object') {
    throw new Error('skill module: default/namespace export is not an object');
  }
  const meta = mod.meta;
  if (!meta || typeof meta !== 'object') {
    throw new Error('skill module: missing `meta` export');
  }
  if (typeof meta.id !== 'string' || !STABLE_ID.test(meta.id)) {
    throw new Error(
      `skill module: meta.id must match ${STABLE_ID} (got ${JSON.stringify(
        meta.id,
      )})`,
    );
  }
  if (typeof meta.name !== 'string' || meta.name.length === 0) {
    throw new Error('skill module: meta.name must be a non-empty string');
  }
  if (typeof meta.description !== 'string') {
    throw new Error('skill module: meta.description must be a string');
  }
  const trigger = mod.trigger;
  if (!trigger || typeof trigger !== 'object') {
    throw new Error('skill module: missing `trigger` export');
  }
  if (
    trigger.channels !== undefined &&
    (!Array.isArray(trigger.channels) ||
      trigger.channels.some((c) => typeof c !== 'string'))
  ) {
    throw new Error('skill module: trigger.channels must be a string[]');
  }
  if (
    trigger.startsWith !== undefined &&
    typeof trigger.startsWith !== 'string'
  ) {
    throw new Error('skill module: trigger.startsWith must be a string');
  }
  if (trigger.regex !== undefined) {
    if (typeof trigger.regex !== 'string') {
      throw new Error('skill module: trigger.regex must be a string');
    }
    try {
      // Reject un-compilable patterns at load, not at first message.
      void new RegExp(trigger.regex);
    } catch (error) {
      throw new Error(
        `skill module: trigger.regex is not a valid RegExp: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (
    !Array.isArray(mod.examples) ||
    mod.examples.length === 0 ||
    mod.examples.some((e) => typeof e !== 'string')
  ) {
    throw new Error(
      'skill module: `examples` must be a non-empty string[] (the smoke harness runs each)',
    );
  }
  if (typeof mod.behavior !== 'function') {
    throw new Error('skill module: `behavior` must be a function');
  }
}

/** Serializable identity of a module trigger, persisted on the registry row. */
export function triggerPredicateKey(trigger: SkillModuleTrigger): string {
  if (typeof trigger.startsWith === 'string') {
    return `startsWith:${trigger.startsWith}`;
  }
  if (typeof trigger.regex === 'string') {
    return `regex:${trigger.regex}`;
  }
  return 'any';
}

/**
 * Compile a serializable {@link SkillModuleTrigger} into the runtime
 * {@link SkillTrigger} the dispatcher evaluates. The `when` predicate is
 * framework-owned (derived from data), never author code.
 */
export function triggerFromModule(trigger: SkillModuleTrigger): SkillTrigger {
  const startsWith = trigger.startsWith;
  const regex = trigger.regex ? new RegExp(trigger.regex) : undefined;
  return {
    channel: trigger.channels ?? undefined,
    predicateKey: triggerPredicateKey(trigger),
    when: (content: string) => {
      if (startsWith !== undefined) {
        return content
          .trimStart()
          .toLowerCase()
          .startsWith(startsWith.toLowerCase());
      }
      if (regex) {
        return regex.test(content);
      }
      return true;
    },
  };
}

/**
 * Bind a validated module into a runtime {@link Skill}: compile the trigger and
 * close `behavior` over the caller-supplied reply source (production uses the
 * configured LLM/echo source; the gate injects a mock).
 */
export function skillFromModule(
  module: SkillModule,
  options: { reply: SkillReplySource; provenance: SkillProvenance },
): Skill {
  return {
    id: module.meta.id,
    name: module.meta.name,
    trigger: triggerFromModule(module.trigger),
    behavior: (agent: Agent) => module.behavior(agent, options.reply),
    provenance: options.provenance,
  };
}
