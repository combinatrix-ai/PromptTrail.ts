import {
  buildCassette,
  buildGoldenOutcome,
  DEFAULT_KEYING,
  diffReplay,
  replayRun,
  runAcceptance,
} from '@prompttrail/core';
import type { AcceptanceReport, Agent } from '@prompttrail/core';
import { readRunFixtures } from './fixtures';
import type { DeployTarget, FixtureDiff } from './types';

/**
 * The VERIFY stage (design §5 corrected — the TRUSTED RUNNER executes against
 * green as a target; green cannot grade itself). Runs entirely in the launcher
 * process, SEALED: the candidate agent is loaded and driven through the core
 * replay/diff/acceptance machinery over the LAUNCHER-OWNED corpus. No child
 * process, no lease, no network, no store writes — deliveries are captured and
 * discarded by the replay containment.
 *
 * 1. For each recorded fixture: build the cassette + golden outcome from the
 *    stored recording, replay the CANDIDATE agent against it (`miss: 'flag'` so
 *    a divergence is captured, not thrown), and `diffReplay` the result against
 *    the declared scope. Any `regression` (a difference outside scope) rejects.
 * 2. Then run the acceptance corpus against the candidate. Any failure rejects.
 */
export interface VerifyResult {
  ok: boolean;
  diffs: FixtureDiff[];
  regressions: number;
  acceptance?: AcceptanceReport;
  error?: string;
}

export async function verifyCandidate(
  agent: Agent,
  corpus: DeployTarget['corpus'],
): Promise<VerifyResult> {
  const diffs: FixtureDiff[] = [];

  if (corpus.runsDir) {
    const fixtures = await readRunFixtures(corpus.runsDir);
    for (const { name, run } of fixtures) {
      // Attach the candidate agent to the fixture so the run is fully formed;
      // replayRun is still given `agent` explicitly so keying stays candidate-side.
      const candidateRun = { ...run, agent: agent as typeof run.agent };
      const cassette = buildCassette(candidateRun);
      const golden = buildGoldenOutcome(candidateRun);
      const { trace } = await replayRun(candidateRun, {
        agent,
        cassette,
        keying: DEFAULT_KEYING,
        miss: 'flag',
      });
      const report = diffReplay(golden, trace, corpus.scope);
      diffs.push({
        fixture: name,
        kind: report.kind,
        outOfScope: report.outOfScope,
        misses: trace.misses.length,
      });
    }
  }

  const regressions = diffs.filter((d) => d.kind === 'regression').length;

  let acceptance: AcceptanceReport | undefined;
  if (corpus.acceptance && corpus.acceptance.length > 0) {
    acceptance = await runAcceptance(agent, corpus.acceptance);
  }

  const ok = regressions === 0 && (acceptance ? acceptance.ok : true);
  return { ok, diffs, regressions, acceptance };
}
