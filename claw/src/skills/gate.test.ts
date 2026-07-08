import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentGraph } from '@prompttrail/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  capabilityViolations,
  findClawRoot,
  runGate,
  templateSynthesizer,
  type GateOptions,
} from './index.js';

/**
 * Gate tests. The subprocess stages (tsc, vitest) MUST resolve `vitest` and
 * `@prompttrail/core` by walking up from their cwd, so the staging root has to
 * live UNDER claw (not in the OS tmpdir). We create it under claw/.data.
 */
const clawRoot = findClawRoot();
let stagingRoot: string;
let gateOptions: GateOptions;

beforeAll(() => {
  mkdirSync(join(clawRoot, '.data'), { recursive: true });
  stagingRoot = mkdtempSync(join(clawRoot, '.data', 'gate-test-'));
  gateOptions = { clawRoot, stagingRoot };
});

afterAll(() => {
  rmSync(stagingRoot, { recursive: true, force: true });
});

const HAPPY = `import type { Agent, Source } from '@prompttrail/core';
export const meta = { id: 'happy', name: 'Happy', description: 'ok' };
export const trigger = { startsWith: '!happy' };
export const examples: string[] = ['!happy', '!happy there'];
export function behavior(agent: Agent, reply: Source<string>): Agent {
  return agent.system('Be happy.').assistant('reply', reply);
}
`;

const BAD_TYPES = `import type { Agent, Source } from '@prompttrail/core';
export const meta = { id: 'badtypes', name: 'Bad', description: 'x' };
export const trigger = { startsWith: '!bad' };
export const examples: string[] = ['!bad'];
export function behavior(agent: Agent, reply: Source<string>): Agent {
  const n: number = 'not a number';
  return agent.system('x').assistant('reply', reply);
}
`;

const THROWS = `import type { Agent, Source } from '@prompttrail/core';
export const meta = { id: 'boomer', name: 'Boomer', description: 'x' };
export const trigger = { startsWith: '!boom' };
export const examples: string[] = ['!boom'];
export function behavior(agent: Agent, reply: Source<string>): Agent {
  return agent.transform('boom', () => {
    throw new Error('kaboom in behavior');
  });
}
`;

const WRITE_EFFECT = `import type { Agent, Source } from '@prompttrail/core';
export const meta = { id: 'writer', name: 'Writer', description: 'x' };
export const trigger = { startsWith: '!write' };
export const examples: string[] = ['!write'];
export function behavior(agent: Agent, reply: Source<string>): Agent {
  return agent
    .transform('persist', { effect: { idempotencyKey: 'k' } }, (session) => session)
    .system('x')
    .assistant('reply', reply);
}
`;

describe('gate: capability check (unit, no subprocess)', () => {
  it('flags a registered tool', () => {
    const graph = createAgentGraph({
      name: 'cap',
      nodes: [{ id: 'reply', type: 'assistant', data: { input: 'hi' } }],
      tools: {
        writer: {
          name: 'writer',
          description: 'w',
          parameters: {},
          effect: { repeatable: true },
          execute: async () => 'x',
        } as never,
      },
    });
    const violations = capabilityViolations(graph);
    expect(violations.join(' ')).toContain('registers tool');
  });

  it('passes a prompt-only graph', () => {
    const graph = createAgentGraph({
      name: 'clean',
      nodes: [{ id: 'reply', type: 'assistant', data: { input: 'hi' } }],
    });
    expect(capabilityViolations(graph)).toEqual([]);
  });
});

describe('gate: full pipeline (subprocess: tsc + vitest)', () => {
  it('passes the template-synthesized happy path with a manifest hash', async () => {
    const out = await runGate({ id: 'happy', source: HAPPY }, gateOptions);
    expect(out.result.stages.map((s) => [s.name, s.ok])).toEqual([
      ['typecheck', true],
      ['smoke', true],
      ['graph-validate', true],
      ['capability', true],
    ]);
    expect(out.result.passed).toBe(true);
    expect(out.result.manifestHash).toMatch(/^[0-9a-f]+$/);
    expect(out.module?.meta.id).toBe('happy');
  }, 120_000);

  it('rejects a module that does not typecheck', async () => {
    const out = await runGate(
      { id: 'badtypes', source: BAD_TYPES },
      gateOptions,
    );
    expect(out.result.passed).toBe(false);
    const stage = out.result.stages.at(-1);
    expect(stage?.name).toBe('typecheck');
    expect(stage?.ok).toBe(false);
    expect(out.module).toBeUndefined();
  }, 120_000);

  it('rejects a behavior that throws on an example (smoke)', async () => {
    const out = await runGate({ id: 'boomer', source: THROWS }, gateOptions);
    expect(out.result.passed).toBe(false);
    const stage = out.result.stages.at(-1);
    expect(stage?.name).toBe('smoke');
    expect(stage?.ok).toBe(false);
  }, 120_000);

  it('rejects an idempotencyKey (write) effect at the capability stage', async () => {
    const out = await runGate(
      { id: 'writer', source: WRITE_EFFECT },
      gateOptions,
    );
    expect(out.result.passed).toBe(false);
    const stage = out.result.stages.at(-1);
    expect(stage?.name).toBe('capability');
    expect(stage?.ok).toBe(false);
    expect(stage?.detail).toContain('idempotencyKey');
    // typecheck/smoke/graph-validate all ran and passed before capability.
    expect(out.result.stages.slice(0, 3).every((s) => s.ok)).toBe(true);
  }, 120_000);

  it('the deterministic synthesizer produces a gate-passing module', async () => {
    const source = await templateSynthesizer.synthesize(
      'when a message starts with "!pong" reply with pong',
    );
    const out = await runGate({ id: 'pong', source }, gateOptions);
    expect(out.result.passed).toBe(true);
  }, 120_000);
});
