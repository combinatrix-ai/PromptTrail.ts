import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Agent,
  createAgentGraphManifest,
  Source,
  validateAgentGraph,
  type AgentGraph,
  type AgentGraphNode,
} from '@prompttrail/core';
import { assertSkillModule, type SkillModule } from './skill-module.js';

/**
 * The verification gate (design-docs/claw-self-authoring.md §5, §6).
 *
 * Self-authoring is arbitrary code execution by construction, so the gate is
 * MANDATORY and PRE-ACTIVATION. Stages run in order — cheapest/most
 * deterministic first — and ALL must pass:
 *
 *   a. typecheck      `tsc --noEmit` in a locked staging dir (SUBPROCESS,
 *                     timeout). Non-zero exit → failure with stderr captured.
 *   b. smoke          a FRAMEWORK-OWNED vitest harness (the author cannot weaken
 *                     it): imports the module, runs `behavior(Agent.create(...))`
 *                     against each declared example with a mock/echo reply source
 *                     (no network), asserts no-throw, wall-clock cap, non-empty
 *                     reply. Run as a SUBPROCESS (`vitest run`, timeout).
 *   c. graph-validate build the module (`tsc --outDir`) and import it IN-PROCESS,
 *                     call behavior, then validateAgentGraph +
 *                     createAgentGraphManifest; record the manifest hash.
 *   d. capability     walk the built graph; Phase 1 skills are READ-ONLY: reject
 *                     any tool registration at all, and any transform/tool
 *                     carrying an `idempotencyKey` (external-write) effect. This
 *                     is the Phase-1 capability ceiling, relaxed in Phase 2 with
 *                     an explicit elevation step.
 *
 * Where the gate runs (§11 decision): a sandboxed SUBPROCESS for the untrusted
 * stages (typecheck, smoke) — the trust boundary the design leans toward.
 * Full network/FS sandboxing of that subprocess is platform work tracked for
 * Phase 2; Phase 1 mitigates by injecting a mock reply source and stripping
 * provider API keys from the child environment so a stray `Source.llm()` fails
 * fast instead of reaching the network.
 */

/** Result of one gate stage (persisted as provenance with the skill row). */
export interface GateStageResult {
  name: 'typecheck' | 'smoke' | 'graph-validate' | 'capability';
  ok: boolean;
  /** Human-readable outcome / captured error output (truncated). */
  detail: string;
}

/** Aggregate gate outcome. `passed` iff all four stages ran and passed. */
export interface GateResult {
  passed: boolean;
  stages: GateStageResult[];
  manifestHash?: string;
  durationMs: number;
}

export interface GateOptions {
  /** claw package root (locates node_modules bins + packages/core for aliases). */
  clawRoot: string;
  /** Directory (under claw) where per-skill staging dirs are created. */
  stagingRoot: string;
  /** Timeout for each `tsc` subprocess. Default 30s. */
  tscTimeoutMs?: number;
  /** Timeout for the `vitest` smoke subprocess. Default 60s. */
  vitestTimeoutMs?: number;
}

export interface GateRunInput {
  /** The skill id (from meta.id) — names the staging files. */
  id: string;
  /** The TypeScript module source to verify. */
  source: string;
}

export interface GateRunOutput {
  result: GateResult;
  /** Present iff the gate passed: the validated, imported module. */
  module?: SkillModule;
  /** Present iff the gate passed: the promoted `.ts` source path. */
  sourcePath?: string;
  /** Present iff the gate passed: the built `.js` artifact path (for import). */
  builtPath?: string;
}

const DETAIL_CAP = 4000;

/** Truncate captured subprocess output so a gate row stays bounded. */
function truncate(text: string, cap = DETAIL_CAP): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) {
    return trimmed;
  }
  return `${trimmed.slice(0, cap)}\n…[truncated ${trimmed.length - cap} chars]`;
}

interface SubprocessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function runSubprocess(
  bin: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        env: options.env ?? process.env,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const err = error as
          | (Error & {
              code?: number | string;
              killed?: boolean;
              signal?: string;
            })
          | null;
        resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut: Boolean(err?.killed) || err?.signal === 'SIGKILL',
          spawnError:
            err && typeof err.code === 'string' ? String(err.code) : undefined,
        });
      },
    );
  });
}

/** Env for untrusted subprocesses: provider API keys stripped (no network). */
function sandboxedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GOOGLE_API_KEY',
    'AZURE_OPENAI_API_KEY',
  ]) {
    delete env[key];
  }
  return env;
}

/** Absolute path to `packages/core/src/index.ts` for the vitest alias. */
function coreSrcEntry(clawRoot: string, subpath = 'index'): string {
  return join(clawRoot, '..', 'packages', 'core', 'src', `${subpath}.ts`);
}

function tscBin(clawRoot: string): string {
  return join(clawRoot, 'node_modules', '.bin', 'tsc');
}

function vitestBin(clawRoot: string): string {
  return join(clawRoot, 'node_modules', '.bin', 'vitest');
}

const STAGING_TSCONFIG = {
  compilerOptions: {
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    target: 'ES2022',
    lib: ['ES2022'],
    types: [] as string[],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
  include: ['skill.ts'],
};

const BUILD_TSCONFIG = {
  compilerOptions: {
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    target: 'ES2022',
    lib: ['ES2022'],
    types: [] as string[],
    strict: true,
    skipLibCheck: true,
    noEmit: false,
    outDir: 'out',
    declaration: false,
    sourceMap: false,
  },
  include: ['skill.ts'],
};

function smokeHarnessSource(id: string): string {
  return `import { Agent, Session, Source } from '@prompttrail/core';
import { describe, expect, it } from 'vitest';
import { behavior, examples } from './skill.ts';

// Framework-owned smoke harness — the author cannot weaken this file; it is
// regenerated by the gate on every run. Mock reply source: no network.
const WALL_CLOCK_CAP_MS = 10000;
const mockReply = Source.callback(async () => 'gate-smoke-ok');

describe('smoke: ${id}', () => {
  for (const [index, example] of examples.entries()) {
    it('example ' + index + ' ' + JSON.stringify(example), async () => {
      const session = Session.create().addMessage({
        type: 'user',
        content: example,
      });
      const agent = behavior(Agent.create('skill-under-test'), mockReply);
      const started = Date.now();
      const result = await agent.execute({ session });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThanOrEqual(WALL_CLOCK_CAP_MS);
      const reply = result.getLastMessage()?.content ?? '';
      expect(typeof reply).toBe('string');
      expect(reply.length).toBeGreaterThan(0);
    }, WALL_CLOCK_CAP_MS + 2000);
  }
});
`;
}

function smokeVitestConfig(clawRoot: string): string {
  const alias = (subpath: string, find: string) =>
    `      { find: ${JSON.stringify(find)}, replacement: ${JSON.stringify(
      coreSrcEntry(clawRoot, subpath),
    )} },`;
  return `import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
${alias('runtime_server', '@prompttrail/core/runtime_server')}
${alias('runtime_dispatch', '@prompttrail/core/runtime_dispatch')}
${alias('index', '@prompttrail/core')}
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['smoke.test.ts'],
    testTimeout: 12000,
    hookTimeout: 12000,
  },
});
`;
}

/** Recursively collect every node in a graph (including nested children). */
function walkNodes(nodes: readonly AgentGraphNode[]): AgentGraphNode[] {
  const out: AgentGraphNode[] = [];
  for (const node of nodes) {
    out.push(node);
    if (node.children && node.children.length > 0) {
      out.push(...walkNodes(node.children));
    }
  }
  return out;
}

/**
 * Phase 1 capability ceiling: skills are prompt-only and read-only. Returns the
 * list of violations (empty = within bounds).
 */
export function capabilityViolations(graph: AgentGraph): string[] {
  const violations: string[] = [];
  const toolNames = Object.keys(graph.tools ?? {});
  if (toolNames.length > 0) {
    violations.push(
      `registers tool(s) [${toolNames.join(
        ', ',
      )}]; Phase 1 skills are prompt-only (no tool registration is permitted until Phase 2 elevation)`,
    );
  }
  for (const node of walkNodes(graph.nodes)) {
    const effect = (node.data as { effect?: unknown } | undefined)?.effect;
    if (
      effect &&
      typeof effect === 'object' &&
      'idempotencyKey' in (effect as Record<string, unknown>)
    ) {
      violations.push(
        `node "${node.id}" (${node.type}) declares an idempotencyKey write effect; Phase 1 skills may not perform external writes`,
      );
    }
  }
  return violations;
}

/**
 * Run the full gate on a synthesized module source. Never throws for a *skill*
 * failure — those are recorded in the returned {@link GateResult}. Throws only
 * for gate infrastructure errors it cannot represent (e.g. staging dir unusable).
 */
export async function runGate(
  input: GateRunInput,
  options: GateOptions,
): Promise<GateRunOutput> {
  const started = Date.now();
  const stages: GateStageResult[] = [];
  const tscTimeout = options.tscTimeoutMs ?? 30_000;
  const vitestTimeout = options.vitestTimeoutMs ?? 60_000;

  mkdirSync(options.stagingRoot, { recursive: true });
  const dir = join(options.stagingRoot, input.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const finish = (): GateResult => ({
    passed: stages.length === 4 && stages.every((s) => s.ok),
    stages,
    manifestHash: stages.find((s) => s.name === 'graph-validate' && s.ok)
      ? manifestHashRef.value
      : undefined,
    durationMs: Date.now() - started,
  });
  const manifestHashRef = { value: undefined as string | undefined };

  try {
    writeFileSync(join(dir, 'skill.ts'), input.source, 'utf8');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify(STAGING_TSCONFIG, null, 2),
      'utf8',
    );

    // Stage a — typecheck.
    const tc = await runSubprocess(
      tscBin(options.clawRoot),
      ['--noEmit', '-p', 'tsconfig.json'],
      { cwd: dir, timeoutMs: tscTimeout, env: sandboxedEnv() },
    );
    if (tc.spawnError) {
      stages.push({
        name: 'typecheck',
        ok: false,
        detail: `could not run tsc (${tc.spawnError}); expected at ${tscBin(
          options.clawRoot,
        )}`,
      });
      return { result: finish() };
    }
    if (tc.timedOut || tc.code !== 0) {
      stages.push({
        name: 'typecheck',
        ok: false,
        detail: tc.timedOut
          ? `tsc timed out after ${tscTimeout}ms`
          : truncate(`${tc.stdout}\n${tc.stderr}`),
      });
      return { result: finish() };
    }
    stages.push({ name: 'typecheck', ok: true, detail: 'tsc --noEmit clean' });

    // Stage b — framework-owned smoke harness.
    writeFileSync(
      join(dir, 'smoke.test.ts'),
      smokeHarnessSource(input.id),
      'utf8',
    );
    writeFileSync(
      join(dir, 'vitest.gate.config.ts'),
      smokeVitestConfig(options.clawRoot),
      'utf8',
    );
    const smoke = await runSubprocess(
      vitestBin(options.clawRoot),
      ['run', '--config', 'vitest.gate.config.ts'],
      { cwd: dir, timeoutMs: vitestTimeout, env: sandboxedEnv() },
    );
    if (smoke.spawnError) {
      stages.push({
        name: 'smoke',
        ok: false,
        detail: `could not run vitest (${smoke.spawnError})`,
      });
      return { result: finish() };
    }
    if (smoke.timedOut || smoke.code !== 0) {
      stages.push({
        name: 'smoke',
        ok: false,
        detail: smoke.timedOut
          ? `smoke harness timed out after ${vitestTimeout}ms`
          : truncate(`${smoke.stdout}\n${smoke.stderr}`),
      });
      return { result: finish() };
    }
    stages.push({
      name: 'smoke',
      ok: true,
      detail: 'behavior ran on every example (no throw, non-empty reply)',
    });

    // Stage c — build + in-process graph validation.
    writeFileSync(
      join(dir, 'tsconfig.build.json'),
      JSON.stringify(BUILD_TSCONFIG, null, 2),
      'utf8',
    );
    const build = await runSubprocess(
      tscBin(options.clawRoot),
      ['-p', 'tsconfig.build.json'],
      { cwd: dir, timeoutMs: tscTimeout, env: sandboxedEnv() },
    );
    if (build.timedOut || build.code !== 0) {
      stages.push({
        name: 'graph-validate',
        ok: false,
        detail: build.timedOut
          ? `build (tsc --outDir) timed out after ${tscTimeout}ms`
          : truncate(`build failed:\n${build.stdout}\n${build.stderr}`),
      });
      return { result: finish() };
    }
    const builtPath = join(dir, 'out', 'skill.js');
    if (!existsSync(builtPath)) {
      stages.push({
        name: 'graph-validate',
        ok: false,
        detail: `build produced no artifact at ${builtPath}`,
      });
      return { result: finish() };
    }

    let module: SkillModule;
    let graph: AgentGraph;
    try {
      const imported = await import(
        `${pathToFileURL(builtPath).href}?t=${Date.now()}`
      );
      assertSkillModule(imported);
      module = imported;
      graph = module
        .behavior(
          Agent.create('gate-cap-check'),
          Source.callback(async () => 'x'),
        )
        .toGraph();
      validateAgentGraph(graph, { durable: true, app: true });
      const manifest = createAgentGraphManifest(graph);
      manifestHashRef.value = manifest.hash;
    } catch (error) {
      stages.push({
        name: 'graph-validate',
        ok: false,
        detail: truncate(
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        ),
      });
      return { result: finish() };
    }
    stages.push({
      name: 'graph-validate',
      ok: true,
      detail: `manifest hash ${manifestHashRef.value}`,
    });

    // Stage d — capability ceiling.
    const violations = capabilityViolations(graph);
    if (violations.length > 0) {
      stages.push({
        name: 'capability',
        ok: false,
        detail: `read-only ceiling violated: ${violations.join('; ')}`,
      });
      return { result: finish() };
    }
    stages.push({
      name: 'capability',
      ok: true,
      detail: 'within Phase 1 read-only, prompt-only ceiling',
    });

    return {
      result: finish(),
      module,
      sourcePath: join(dir, 'skill.ts'),
      builtPath,
    };
  } catch (error) {
    // Infrastructure failure (not a skill defect): surface as a failed gate so
    // the caller still gets a structured result instead of a thrown pipeline.
    stages.push({
      name: stages.length === 0 ? 'typecheck' : 'graph-validate',
      ok: false,
      detail: `gate infrastructure error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return { result: finish() };
  }
}

/** Resolve the claw package root by walking up from this module. */
export function findClawRoot(
  fromDir = dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = fromDir;
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: string;
        };
        if (pkg.name === '@prompttrail/claw') {
          return dir;
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('could not locate @prompttrail/claw package root');
}
