import { Source } from '@prompttrail/core';
import type { Skill } from './types.js';

/** Runtime facts the status skill reports back to the channel. */
export interface StatusInfo {
  version: string;
  replyMode: string;
  /** Process/boot start time (ms epoch) used to compute uptime. */
  startedAt: number;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  now?: () => number;
}

/** The `!status` trigger prefix (case-insensitive, leading whitespace ok). */
const STATUS_PREFIX = '!status';

export function statusMessage(info: StatusInfo): string {
  const now = (info.now ?? Date.now)();
  const uptimeSec = Math.max(0, Math.floor((now - info.startedAt) / 1000));
  return `claw v${info.version} | reply-mode: ${info.replyMode} | uptime: ${uptimeSec}s`;
}

/**
 * Hand-written Phase 0 skill (design-docs/claw-self-authoring.md §10).
 *
 * Trigger: a message beginning with `!status` (any channel). Behavior: reply
 * with the bot's version, active reply mode, and uptime. Deterministic (given
 * an injected clock) so the dispatch path is testable without an LLM.
 */
export function createStatusSkill(info: StatusInfo): Skill {
  return {
    id: 'status',
    name: 'Status',
    trigger: {
      predicateKey: 'startsWith:!status',
      when: (content) =>
        content.trimStart().toLowerCase().startsWith(STATUS_PREFIX),
    },
    behavior: (agent) =>
      agent.assistant(Source.callback(async () => statusMessage(info))),
    provenance: {
      authoredBy: 'claw-maintainers',
      motivation:
        'Hand-written Phase 0 skill: report bot version, reply mode, and uptime on "!status".',
      createdAt: '2026-07-08T00:00:00.000Z',
    },
  };
}
