import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delay, launchServer } from './process';
import { verifyCandidate } from './verify';
import type {
  DeployLogEvent,
  DeployOptions,
  DeployReport,
  DeployTarget,
  LaunchedProcess,
  ProbeContext,
} from './types';

const DEFAULTS = {
  ttlMs: 30_000,
  healthWindowMs: 3_000,
  drainTimeoutMs: 5_000,
  probeIntervalMs: 200,
  readyTimeoutMs: 10_000,
};

/**
 * Verify a candidate and, only if it passes, cut the single-writer lease over to
 * it — with a post-cutover health window and automatic rollback (design §5,
 * corrected). The launcher is the decision-maker: green (the candidate) only
 * ever supplies EVIDENCE (a loaded agent for verification, a live process for
 * probing); every irreversible step (handoff, rollback, promote) is executed
 * here, by the trusted root.
 *
 * Flow:
 *  a. VERIFY (sealed, in-process): replay-diff over the launcher-owned corpus +
 *     acceptance. Any regression / acceptance failure → 'rejected', blue
 *     untouched, no child ever launched.
 *  b. LAUNCH green: spawn `target.serve` as a canary child (its own store/lease
 *     config; the launcher injects only role + green holder id). It comes up
 *     WARM and polls the lease, but does not serve until it is handed the lease.
 *  c. CUTOVER: discover blue via `store.lease.current()`, then
 *     `store.lease.handoff({ from: blue, to: green })` — atomic; fencing makes a
 *     drained blue's late writes fail safely.
 *  d. HEALTH WINDOW: confirm green took over (probes pass) and stays healthy for
 *     `healthWindowMs`. A probe failure → handoff back to the still-warm blue,
 *     kill green → 'rolled-back'.
 *  e. PROMOTE: signal blue to drain + exit → 'promoted'.
 *
 * Any exception drives a SAFE STATE: blue keeps/regains the lease, green is
 * killed, verdict 'rejected'.
 */
export async function deploy(
  candidateDir: string,
  target: DeployTarget,
  opts: DeployOptions = {},
): Promise<DeployReport> {
  const ttlMs = opts.ttlMs ?? DEFAULTS.ttlMs;
  const healthWindowMs = opts.healthWindowMs ?? DEFAULTS.healthWindowMs;
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULTS.drainTimeoutMs;
  const probeIntervalMs = opts.probeIntervalMs ?? DEFAULTS.probeIntervalMs;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs;
  const now = opts.now ?? Date.now;
  const store = target.store;
  const probes = target.probes ?? [];
  const log = (
    stage: DeployLogEvent['stage'],
    message: string,
    data?: Record<string, unknown>,
  ) => opts.log?.({ stage, message, at: now(), data });

  const report: DeployReport = {
    verdict: 'rejected',
    target: target.name,
    stages: {},
  };

  // ── a. VERIFY (sealed, launcher process) ─────────────────────────────────
  let agent;
  try {
    agent = await target.loadAgent(candidateDir);
    const verify = await verifyCandidate(agent, target.corpus);
    report.stages.verify = {
      ok: verify.ok,
      fixtures: verify.diffs.length,
      regressions: verify.regressions,
      acceptanceOk: verify.acceptance?.ok,
    };
    report.diffs = verify.diffs;
    report.acceptance = verify.acceptance;
    if (!verify.ok) {
      log('verify', 'candidate rejected by verification; blue untouched', {
        regressions: verify.regressions,
        acceptanceOk: verify.acceptance?.ok,
      });
      report.verdict = 'rejected';
      return report;
    }
    log('verify', 'candidate passed verification', {
      fixtures: verify.diffs.length,
    });
  } catch (error) {
    report.stages.verify = {
      ok: false,
      fixtures: 0,
      regressions: 0,
      error: errMessage(error),
    };
    report.verdict = 'rejected';
    report.error = errMessage(error);
    log('verify', 'verification threw; blue untouched', {
      error: errMessage(error),
    });
    return report;
  }

  // ── b. LAUNCH green ──────────────────────────────────────────────────────
  const greenHolder = `${target.name}-green-${process.pid}-${now()}`;
  const readyFile = tempFile('ready');
  const statusFile = tempFile('status');
  const probeCtx: ProbeContext = { greenHolder, statusFile, store };
  let green: LaunchedProcess | undefined;
  try {
    green = launchServer(target, {
      holder: greenHolder,
      role: 'green',
      ttlMs,
      readyFile,
      statusFile,
    });
    await green.waitReady(readyTimeoutMs);
    report.stages.launch = { ok: true, holder: greenHolder, pid: green.pid };
    log('launch', 'green launched and ready (warm, not yet serving)', {
      holder: greenHolder,
      pid: green.pid,
    });
  } catch (error) {
    green?.kill();
    await cleanup([readyFile, statusFile]);
    report.stages.launch = { ok: false, error: errMessage(error) };
    report.verdict = 'rejected';
    report.error = errMessage(error);
    log('launch', 'green failed to launch; blue untouched', {
      error: errMessage(error),
    });
    return report;
  }

  // From here, cutover is possible, so every failure must reach a safe state.
  let blueHolder: string | undefined;
  let handedOff = false;
  try {
    // ── c. CUTOVER ─────────────────────────────────────────────────────────
    const current = await store.lease.current();
    if (!current) {
      throw new Error(
        'no live lease holder to hand off from (blue is not holding the lease)',
      );
    }
    blueHolder = current.holder;
    log(
      'drain',
      'draining blue via lease handoff (fencing seals late writes)',
      {
        blue: blueHolder,
      },
    );
    const handed = await store.lease.handoff({
      from: blueHolder,
      to: greenHolder,
      ttlMs,
    });
    if (!handed) {
      throw new Error(
        `handoff rejected: "${blueHolder}" is no longer the current holder`,
      );
    }
    handedOff = true;
    report.stages.cutover = {
      ok: true,
      from: blueHolder,
      to: greenHolder,
      token: handed.token,
    };
    log('cutover', 'lease handed off blue → green', {
      from: blueHolder,
      to: greenHolder,
      token: handed.token,
    });

    // ── d. HEALTH WINDOW ─────────────────────────────────────────────────────
    // Confirm green actually took over (probes must pass at least once), then
    // watch that it STAYS healthy for the window. Either failure rolls back.
    const tookOver = await waitUntilHealthy(
      probes,
      probeCtx,
      readyTimeoutMs,
      probeIntervalMs,
    );
    if (!tookOver.ok) {
      return await rollback(
        report,
        store,
        greenHolder,
        blueHolder,
        ttlMs,
        green,
        [readyFile, statusFile],
        `green did not become healthy after cutover: ${tookOver.error}`,
        log,
      );
    }
    const sustained = await sustainHealthy(
      probes,
      probeCtx,
      healthWindowMs,
      probeIntervalMs,
    );
    if (!sustained.ok) {
      return await rollback(
        report,
        store,
        greenHolder,
        blueHolder,
        ttlMs,
        green,
        [readyFile, statusFile],
        `green degraded during the health window: ${sustained.error}`,
        log,
      );
    }
    report.stages.health = { ok: true };
    log('health', 'green healthy through the window', {
      windowMs: healthWindowMs,
    });

    // ── e. PROMOTE ───────────────────────────────────────────────────────────
    let blueStopped = false;
    if (opts.current) {
      // Blue lost the lease at cutover; app.stop releases nothing — it just exits.
      await opts.current.stop(drainTimeoutMs);
      blueStopped = true;
    }
    report.stages.promote = { ok: true, blueStopped };
    report.verdict = 'promoted';
    log('promote', 'blue drained + exited; green is the live writer', {
      green: greenHolder,
      blueStopped,
    });
    await cleanup([readyFile, statusFile]);
    return report;
  } catch (error) {
    // ── SAFE STATE ───────────────────────────────────────────────────────────
    // Ensure blue holds the lease again (only meaningful if we handed off), and
    // kill green. Blue was left warm, so it re-takes the lease on the next tick.
    if (handedOff && blueHolder) {
      try {
        await store.lease.handoff({
          from: greenHolder,
          to: blueHolder,
          ttlMs,
        });
      } catch {
        // best-effort: if green already lost the lease, blue recovers via expiry
      }
    }
    green.kill();
    await cleanup([readyFile, statusFile]);
    report.stages.health = report.stages.health ?? {
      ok: false,
      error: errMessage(error),
    };
    report.verdict = 'rejected';
    report.error = errMessage(error);
    log('safe-state', 'exception during cutover; reverted to blue', {
      error: errMessage(error),
      revertedToBlue: handedOff && !!blueHolder,
    });
    return report;
  }
}

/** Hand the lease back to the warm blue, kill green, and mark 'rolled-back'. */
async function rollback(
  report: DeployReport,
  store: DeployTarget['store'],
  greenHolder: string,
  blueHolder: string,
  ttlMs: number,
  green: LaunchedProcess,
  tempFiles: string[],
  reason: string,
  log: (
    stage: DeployLogEvent['stage'],
    message: string,
    data?: Record<string, unknown>,
  ) => void,
): Promise<DeployReport> {
  const back = await store.lease.handoff({
    from: greenHolder,
    to: blueHolder,
    ttlMs,
  });
  green.kill();
  await cleanup(tempFiles);
  report.stages.health = {
    ok: false,
    error: reason,
    rolledBack: Boolean(back),
  };
  report.verdict = 'rolled-back';
  log('rollback', 'health window failed; lease handed back green → blue', {
    reason,
    to: blueHolder,
    token: back?.token,
  });
  return report;
}

/** Poll the probes until they ALL pass once, or the deadline elapses. */
async function waitUntilHealthy(
  probes: NonNullable<DeployTarget['probes']>,
  ctx: ProbeContext,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown';
  for (;;) {
    const result = await runProbes(probes, ctx);
    if (result.ok) {
      return { ok: true };
    }
    lastError = result.error ?? 'unknown';
    if (Date.now() >= deadline) {
      return { ok: false, error: lastError };
    }
    await delay(intervalMs);
  }
}

/** Run the probes repeatedly for `windowMs`; ANY failure ends unhealthy. */
async function sustainHealthy(
  probes: NonNullable<DeployTarget['probes']>,
  ctx: ProbeContext,
  windowMs: number,
  intervalMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const result = await runProbes(probes, ctx);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    if (Date.now() >= deadline) {
      return { ok: true };
    }
    await delay(intervalMs);
  }
}

async function runProbes(
  probes: NonNullable<DeployTarget['probes']>,
  ctx: ProbeContext,
): Promise<{ ok: boolean; error?: string }> {
  for (const probe of probes) {
    try {
      await probe(ctx);
    } catch (error) {
      return { ok: false, error: errMessage(error) };
    }
  }
  return { ok: true };
}

function tempFile(kind: string): string {
  return join(
    tmpdir(),
    `prompttrail-launcher-${kind}-${randomBytes(8).toString('hex')}`,
  );
}

async function cleanup(files: string[]): Promise<void> {
  await Promise.all(
    files.map((file) => fs.rm(file, { force: true }).catch(() => undefined)),
  );
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
