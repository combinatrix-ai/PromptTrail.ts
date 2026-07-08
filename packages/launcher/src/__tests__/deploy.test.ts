import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, MemoryRunStore, PromptTrail, Source } from '@prompttrail/core';
import type { AcceptanceCase, ChangeScope } from '@prompttrail/core';
import { SqliteRunStore } from '@prompttrail/store-sqlite';
import { deploy } from '../deploy';
import { launchServer } from '../process';
import { serializeRunFixture } from '../fixtures';
import type { DeployTarget, LaunchedProcess, ProbeContext } from '../types';

const CHILD = join(
  dirname(fileURLToPath(import.meta.url)),
  'children',
  'server-child.mjs',
);

// ── fixtures + agents ───────────────────────────────────────────────────────

/** Baseline service agent: inbox → assistant('reply'). */
function serviceAgent() {
  return Agent.create('svc')
    .inbox('inbound')
    .assistant('reply', Source.llm().mock().mockResponse({ content: 'hello' }));
}

/**
 * A structurally DIVERGED candidate: an extra system node changes the executed
 * node path (control-flow), so replay against the fixture flags an out-of-scope
 * regression when the scope only permits `text`.
 */
function divergedAgent() {
  return Agent.create('svc')
    .inbox('inbound')
    .system('injected', 'extra node not present in the recording')
    .assistant('reply', Source.llm().mock().mockResponse({ content: 'hello' }));
}

async function writeFixture(runsDir: string): Promise<void> {
  const store = new MemoryRunStore();
  const app = PromptTrail.app({
    agents: { svc: serviceAgent() },
    store,
    recording: 'full',
  });
  await app.run({ agent: 'svc', runId: 'r1', input: 'hi', checkpoint: true });
  const run = await store.get('r1');
  if (!run) throw new Error('fixture run not stored');
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(join(runsDir, 'r1.json'), serializeRunFixture(run));
}

// scope: only the `text` dimension may change, only on the `reply` node.
const TEXT_ONLY_SCOPE: ChangeScope = {
  dimensions: ['text'],
  nodeIds: ['reply'],
};

const GREETS: AcceptanceCase = {
  name: 'greets',
  inbox: ['hi'],
  modelStubs: ['hello there'],
  assert: (trace) => {
    const text = trace.finalReply.map((m) => m.content).join('');
    if (!text.includes('hello')) {
      throw new Error(`expected a greeting, got: ${text}`);
    }
  },
};

// ── test harness (temp dir + child reaping) ─────────────────────────────────

interface Ctx {
  dir: string;
  dbPath: string;
  runsDir: string;
  store: SqliteRunStore;
  children: LaunchedProcess[];
  pids: number[];
}

let ctx: Ctx;

function readyFile(dir: string, name: string): string {
  return join(dir, `${name}.ready`);
}
function statusFile(dir: string, name: string): string {
  return join(dir, `${name}.status`);
}

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-test-'));
  const dbPath = join(dir, 'store.db');
  const runsDir = join(dir, 'runs');
  await writeFixture(runsDir);
  const store = new SqliteRunStore({ path: dbPath, agents: {} });
  ctx = { dir, dbPath, runsDir, store, children: [], pids: [] };
});

afterEach(async () => {
  // Reap EVERY spawned child so no dangling processes/handles leak.
  for (const child of ctx.children) {
    child.kill();
  }
  for (const pid of ctx.pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  // Give SIGKILL a beat to land before removing the db file.
  await new Promise((r) => setTimeout(r, 50));
  rmSync(ctx.dir, { recursive: true, force: true });
});

function buildTarget(overrides: Partial<DeployTarget> = {}): DeployTarget {
  return {
    name: 'svc',
    corpus: {
      runsDir: ctx.runsDir,
      scope: TEXT_ONLY_SCOPE,
      acceptance: [GREETS],
    },
    loadAgent: async () => serviceAgent(),
    serve: {
      command: process.execPath,
      args: [CHILD],
      env: { LAUNCHER_DB_PATH: ctx.dbPath, LAUNCHER_POLL_MS: '40' },
    },
    store: ctx.store,
    ...overrides,
  };
}

/** Launch the blue (current) deployment and wait until it holds the lease. */
async function startBlue(target: DeployTarget): Promise<LaunchedProcess> {
  const blue = launchServer(target, {
    holder: 'svc-blue',
    role: 'blue',
    ttlMs: 30_000,
    readyFile: readyFile(ctx.dir, 'blue'),
    statusFile: statusFile(ctx.dir, 'blue'),
  });
  ctx.children.push(blue);
  await blue.waitReady(5_000);
  await waitFor(async () => {
    const cur = await ctx.store.lease.current();
    return cur?.holder === 'svc-blue';
  }, 5_000);
  return blue;
}

async function readStatus(file: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// A launcher-owned probe: green must be serving AND actually hold the lease.
const servingProbe = async (probeCtx: ProbeContext): Promise<void> => {
  const st = await readStatus(probeCtx.statusFile);
  if (st.serving !== true) throw new Error('green not serving yet');
  const cur = await probeCtx.store.lease.current();
  if (cur?.holder !== probeCtx.greenHolder) {
    throw new Error('green does not hold the lease');
  }
};

// ── tests ───────────────────────────────────────────────────────────────────

describe('deploy() — B5 launcher', () => {
  it('promotes a clean candidate: handoff, health passes, blue fenced + exits', async () => {
    const target = buildTarget();
    const blue = await startBlue(target);

    const report = await deploy(ctx.dir, target, {
      current: blue,
      ttlMs: 30_000,
      healthWindowMs: 200,
      probeIntervalMs: 40,
      readyTimeoutMs: 5_000,
      probes: [servingProbe],
    });
    if (report.stages.launch?.pid) ctx.pids.push(report.stages.launch.pid);

    expect(report.verdict).toBe('promoted');
    expect(report.stages.verify?.ok).toBe(true);
    expect(report.stages.cutover?.ok).toBe(true);

    const greenHolder = report.stages.cutover?.to;
    const cur = await ctx.store.lease.current();
    expect(cur?.holder).toBe(greenHolder);

    // Blue lost the lease at cutover; its stale-token write was fenced (B4).
    const blueStatus = await readStatus(statusFile(ctx.dir, 'blue'));
    expect(blueStatus.lateWriteRejected).toBe(true);

    // Blue was signaled to drain + exit.
    await waitFor(async () => blue.exited, 5_000);
    expect(blue.exited).toBe(true);
  });

  it('rejects a regression before touching blue (no green launched)', async () => {
    const target = buildTarget({ loadAgent: async () => divergedAgent() });
    const blue = await startBlue(target);

    const report = await deploy(ctx.dir, target, {
      current: blue,
      probes: [servingProbe],
    });

    expect(report.verdict).toBe('rejected');
    expect(report.stages.verify?.ok).toBe(false);
    expect(report.stages.verify?.regressions).toBeGreaterThan(0);
    expect(report.diffs?.some((d) => d.kind === 'regression')).toBe(true);
    // No green process was ever spawned.
    expect(report.stages.launch).toBeUndefined();
    // Blue is untouched and still holds the lease.
    expect(blue.exited).toBe(false);
    const cur = await ctx.store.lease.current();
    expect(cur?.holder).toBe('svc-blue');
  });

  it('rejects on acceptance failure before touching blue', async () => {
    const failing: AcceptanceCase = {
      name: 'unmet-expectation',
      inbox: ['hi'],
      modelStubs: ['hello'],
      assert: () => {
        throw new Error('forced acceptance failure');
      },
    };
    const target = buildTarget({
      corpus: {
        runsDir: ctx.runsDir,
        scope: TEXT_ONLY_SCOPE,
        acceptance: [failing],
      },
    });
    const blue = await startBlue(target);

    const report = await deploy(ctx.dir, target, {
      current: blue,
      probes: [servingProbe],
    });

    expect(report.verdict).toBe('rejected');
    expect(report.stages.verify?.acceptanceOk).toBe(false);
    expect(report.acceptance?.ok).toBe(false);
    expect(report.stages.launch).toBeUndefined();
    expect(blue.exited).toBe(false);
    const cur = await ctx.store.lease.current();
    expect(cur?.holder).toBe('svc-blue');
  });

  it('rolls back when the health window fails: lease handed back to warm blue', async () => {
    const target = buildTarget({
      // An independent launcher probe that always reports green unhealthy.
      probes: [
        async () => {
          throw new Error('simulated degradation');
        },
      ],
    });
    const blue = await startBlue(target);

    const report = await deploy(ctx.dir, target, {
      current: blue,
      ttlMs: 30_000,
      healthWindowMs: 200,
      probeIntervalMs: 40,
      // Short confirm window so the failing probe rolls back quickly.
      readyTimeoutMs: 700,
    });
    if (report.stages.launch?.pid) ctx.pids.push(report.stages.launch.pid);

    expect(report.verdict).toBe('rolled-back');
    expect(report.stages.cutover?.ok).toBe(true);
    expect(report.stages.health?.ok).toBe(false);
    expect(report.stages.health?.rolledBack).toBe(true);

    // Blue holds the lease again and never exited (stayed warm).
    const cur = await ctx.store.lease.current();
    expect(cur?.holder).toBe('svc-blue');
    expect(blue.exited).toBe(false);
    // Blue resumes serving after the rollback handoff.
    await waitFor(async () => {
      const st = await readStatus(statusFile(ctx.dir, 'blue'));
      return st.serving === true;
    }, 5_000);
  });
});
