import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ChangeScope, DurableRunStore } from '@prompttrail/core';
import {
  deploy,
  type DeployTarget,
  type ProbeContext,
} from '@prompttrail/launcher';
import { SqliteRunStore } from '@prompttrail/store-sqlite';
import {
  buildAcceptanceTarget,
  builtinCorpus,
} from '../acceptance/builtin-corpus.js';

/**
 * Example: deploying claw with the immutable launcher (design-docs
 * replay-and-self-deploy.md §5, B5). Illustrative wiring — NOT load-bearing in
 * tests; the launcher's own suite exercises the full promote/rollback flow.
 *
 * The launcher is the TRUST ROOT: it never imports the candidate into its own
 * decision logic. Verification runs over LAUNCHER-OWNED inputs:
 *   - `corpus.acceptance` = claw's trusted-root acceptance corpus (`builtinCorpus`,
 *     which lives in `claw/acceptance/`, outside any self-authoring write path);
 *   - `corpus.runsDir`   = a launcher-owned directory of recorded run fixtures
 *     (`serializeRunFixture`) to replay-diff against `corpus.scope`;
 *   - `corpus.scope`     = the declared, trusted-root-authored blast radius.
 *
 * The candidate only ever appears as the agent returned by `loadAgent` (a dynamic
 * import of the candidate's built dist) and as the served child process — it can
 * never grade itself or seize the lease.
 */
export function buildClawDeployTarget(store: DurableRunStore): DeployTarget {
  // The intended blast radius of THIS deploy, authored by the trusted root. Here:
  // "only the reply text of the `reply` node may change; routing / tool-args /
  // control-flow must stay identical." Any diff outside this is a regression.
  const scope: ChangeScope = {
    dimensions: ['text'],
    nodeIds: ['reply'],
  };

  const clawEntry = join(
    dirname(fileURLToPath(import.meta.url)),
    'index.js', // built dist entry (claw/dist/src/index.js)
  );

  return {
    name: 'claw',
    corpus: {
      // A launcher-owned corpus of recorded StoredRun fixtures. Populate it by
      // recording production runs with `recording: 'full'` and serializing each
      // via `serializeRunFixture`. Absent = replay-diff is skipped.
      runsDir: process.env.CLAW_REPLAY_RUNS_DIR,
      scope,
      // Trusted-root acceptance corpus — the SAME cases the acceptance runner
      // uses, owned outside the mutable build under test.
      acceptance: builtinCorpus,
    },
    // In a real deploy this dynamically imports the CANDIDATE's built dist and
    // returns its main agent. For this example we reuse the corpus target
    // builder as a stand-in candidate agent.
    loadAgent: async (_candidateDir: string) => buildAcceptanceTarget(),
    // How the launcher serves the green candidate: run claw in lease mode with a
    // green role. `LAUNCHER_LEASE_HOLDER` + `LAUNCHER_ROLE` are injected by the
    // launcher; claw's index.ts reads them (CLAW_LEASE opt-in) and WAITS for the
    // handoff before starting to serve.
    serve: {
      command: process.execPath,
      args: [clawEntry],
      env: {
        CLAW_LEASE: '1',
        CLAW_DB_PATH:
          process.env.CLAW_DB_PATH ?? join(process.cwd(), '.data', 'claw.db'),
      },
    },
    store,
    // An independent, launcher-owned health probe: green must hold the lease.
    probes: [
      async (ctx: ProbeContext) => {
        const current = await ctx.store.lease.current();
        if (current?.holder !== ctx.greenHolder) {
          throw new Error('green candidate is not the lease holder');
        }
      },
    ],
  };
}

async function main(): Promise<void> {
  const candidateDir = process.argv[2] ?? process.cwd();
  const store = new SqliteRunStore({
    // The shared store whose lease arbitrates serving. The launcher owns this
    // handle; the served children open their own connections to the same file.
    path: process.env.CLAW_DB_PATH ?? join(process.cwd(), '.data', 'claw.db'),
    agents: { main: buildAcceptanceTarget() },
  });
  const target = buildClawDeployTarget(store);
  const report = await deploy(candidateDir, target, {
    healthWindowMs: 5_000,
    log: (event) => console.log(`[launcher:${event.stage}] ${event.message}`),
  });
  console.log(`\nverdict: ${report.verdict}`);
  process.exitCode = report.verdict === 'promoted' ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
