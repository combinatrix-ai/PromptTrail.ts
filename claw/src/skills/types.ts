import type { Agent, Session } from '@prompttrail/core';

/**
 * Phase 0 skill model (design-docs/claw-self-authoring.md §2).
 *
 * A skill is a plain TypeScript value with three parts:
 *   - `trigger`  — a routing predicate (channel + `when`) the dispatcher reads.
 *   - `behavior` — a subroutine body: `(agent) => agent`, the reply logic.
 *   - `provenance` — who authored it and why, for audit/pruning.
 *
 * Types are intentionally local to claw for Phase 0; core stays untouched.
 */

/** Runtime context handed to a trigger predicate when routing a message. */
export interface SkillContext {
  /** Human-readable channel name of the inbound message, if known. */
  channel?: string;
  /** Stable channel id of the inbound message, if known. */
  channelId?: string;
  /** The inbound message content the predicate matches against. */
  content: string;
  /** The full session at dispatch time (read-only use in predicates). */
  session: Session;
}

/**
 * A skill's routing predicate.
 *
 * `predicateKey` is the *serializable* name of `when` — it is what a registry
 * row persists (Phase 0 has no code-gen, so the executable `when` always comes
 * from the in-process skill map, keyed by skill id). `channel` narrows which
 * channel(s) the skill applies to; `undefined` matches any channel.
 */
export interface SkillTrigger {
  channel?: string | string[];
  /** Named, serializable identity of the predicate (persisted on the row). */
  predicateKey: string;
  when: (content: string, ctx: SkillContext) => boolean;
}

/** Audit trail: who authored a skill, the motivating instruction, and when. */
export interface SkillProvenance {
  authoredBy: string;
  motivation: string;
  /** ISO-8601 timestamp of authoring (not of any single invocation). */
  createdAt: string;
}

/**
 * The unit of self-authored behavior. `behavior` is a subroutine body builder:
 * given a fresh `Agent`, it appends the reply logic and returns the agent.
 */
export interface Skill {
  id: string;
  name: string;
  trigger: SkillTrigger;
  behavior: (agent: Agent) => Agent;
  provenance: SkillProvenance;
}

/** Session var the dispatch transform writes the matched skill id into. */
export const MATCHED_SKILL_VAR = '__claw_matched_skill';
