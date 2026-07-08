import { fileURLToPath } from 'node:url';
import { type AcceptanceReport, runAcceptance } from '@prompttrail/core';
import {
  buildAcceptanceTarget,
  builtinCorpus,
} from '../acceptance/builtin-corpus.js';

/**
 * B3 acceptance runner (design-docs/replay-and-self-deploy.md §4, §6, §8 B3).
 *
 * The TRUSTED runner: it constructs the target agent and executes the
 * trusted-root corpus against it through the core acceptance containment (sealed
 * side effects, captured deliveries, live model fall-through only). It is
 * deliberately thin — the corpus and its target live in `claw/acceptance/`, repo
 * source outside any self-authoring write path (see the corpus header for the
 * trust-boundary argument) — so a mutable build under test can never edit what
 * grades it.
 *
 * Exposed as {@link runClawAcceptance} for the vitest suite (invoked directly,
 * not as a subprocess) and runnable as `pnpm --filter @prompttrail/claw
 * acceptance`.
 */
export async function runClawAcceptance(): Promise<AcceptanceReport> {
  const target = buildAcceptanceTarget();
  return runAcceptance(target, builtinCorpus);
}

/** Print a human-readable summary of an acceptance report. */
export function formatAcceptanceReport(report: AcceptanceReport): string {
  const lines = report.cases.map((c) => {
    const mark = c.ok ? 'PASS' : 'FAIL';
    const detail = c.ok ? '' : ` — ${c.error ?? 'unknown error'}`;
    return `  [${mark}] ${c.name} (${c.durationMs}ms)${detail}`;
  });
  const failed = report.cases.filter((c) => !c.ok).length;
  const header = report.ok
    ? `Acceptance: all ${report.cases.length} cases passed.`
    : `Acceptance: ${failed}/${report.cases.length} cases FAILED.`;
  return [header, ...lines].join('\n');
}

async function main(): Promise<void> {
  const report = await runClawAcceptance();
  console.log(formatAcceptanceReport(report));
  process.exitCode = report.ok ? 0 : 1;
}

// Run as a script only when invoked directly (not when imported by the test).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
