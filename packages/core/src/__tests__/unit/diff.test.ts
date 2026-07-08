import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChangeScopeSchema, buildGoldenOutcome, diffReplay } from '../../diff';
import { MemoryRunStore, PromptTrail } from '../../durable';
import type { StoredRun } from '../../durable';
import { replayRun } from '../../replay';
import { Source } from '../../source';
import { Agent } from '../../templates';
import { Tool } from '../../tool';

const echoTool = Tool.create({
  name: 'echo',
  description: 'Echoes its input.',
  inputSchema: z.object({ x: z.number() }),
  effect: { idempotencyKey: 'echo:1' },
  execute: (input: { x: number }) => `echo:${input.x}`,
});

// system + inbox + assistant(tool call with a parameterized literal arg) +
// tools + conditional(parameterized predicate). Structurally identical across
// variants so leaves key by request-hash / node-path.
function differAgent(options?: { toolArg?: number; branch?: boolean }) {
  const toolArg = options?.toolArg ?? 1;
  const branch = options?.branch ?? true;
  return Agent.create('diff')
    .system('sys', 'be helpful')
    .inbox('inbound')
    .tool('echo', echoTool)
    .assistant(
      'ask',
      Source.llm({ temperature: 0 })
        .mock()
        .mockResponse({
          content: 'calling echo',
          toolCalls: [
            { id: 'call-1', name: 'echo', arguments: { x: toolArg } },
          ],
        }),
    )
    .tools('run')
    .conditional(
      'branch',
      () => branch,
      (a) => a.system('note', 'branch taken'),
    );
}

async function recordRun(
  agent: Agent<any>,
  runId: string,
): Promise<StoredRun<any>> {
  const store = new MemoryRunStore();
  const app = PromptTrail.app({
    agents: { diff: agent },
    store,
    recording: 'decisions',
  });
  await app.run({ agent: 'diff', runId, input: 'hello', checkpoint: true });
  const run = await store.get(runId);
  if (!run) {
    throw new Error('run not stored');
  }
  return run;
}

describe('B2 diffReplay', () => {
  it('classifies an identical replay as same (GoldenOutcome round-trip)', async () => {
    const run = await recordRun(differAgent(), 'same-1');
    const golden = buildGoldenOutcome(run);
    const { trace } = await replayRun(run);
    const report = diffReplay(golden, trace, {});
    expect(report.kind).toBe('same');
    expect(report.differences).toEqual([]);
  });

  it('flags a tool-args difference and scopes it to intended', async () => {
    const goldenRun = await recordRun(differAgent({ toolArg: 1 }), 'ta-golden');
    const candidateRun = await recordRun(
      differAgent({ toolArg: 2 }),
      'ta-candidate',
    );
    const golden = buildGoldenOutcome(goldenRun);
    const { trace } = await replayRun(candidateRun);

    // Only the tool argument literal changed: text (assistant reply) and routing
    // and control-flow are identical, so the sole difference is tool-args.
    const openReport = diffReplay(golden, trace, {});
    expect(openReport.differences.map((d) => d.dimension)).toEqual([
      'tool-args',
    ]);
    const toolNodeId = openReport.differences[0].at;
    expect(toolNodeId).toBeDefined();

    // Empty scope: nothing is permitted → regression.
    expect(openReport.kind).toBe('regression');

    // Scope that names the tool node + dimension → intended.
    const intended = diffReplay(golden, trace, {
      dimensions: ['tool-args'],
      nodeIds: [toolNodeId as string],
    });
    expect(intended.kind).toBe('intended');
    expect(intended.outOfScope).toEqual([]);

    // Dimension listed but wrong node id → out of scope → regression.
    const wrongNode = diffReplay(golden, trace, {
      dimensions: ['tool-args'],
      nodeIds: ['some-other-node'],
    });
    expect(wrongNode.kind).toBe('regression');
  });

  it('detects routing + control-flow differences on a flipped conditional', async () => {
    const goldenRun = await recordRun(
      differAgent({ branch: true }),
      'cf-golden',
    );
    const golden = buildGoldenOutcome(goldenRun);
    // Replay the golden run through an agent whose conditional predicate is
    // flipped: the branch decision runs live, so it diverges from the recording.
    const { trace } = await replayRun(goldenRun, {
      agent: differAgent({ branch: false }),
    });

    const report = diffReplay(golden, trace, {});
    const dimensions = report.differences.map((d) => d.dimension).sort();
    expect(dimensions).toEqual(['control-flow', 'routing']);

    // The conditional (branch) node id shows up on the routing difference.
    const conditionalNodeId = golden.routing[0]?.at;
    expect(conditionalNodeId).toBeDefined();
    expect(report.differences.some((d) => d.at === conditionalNodeId)).toBe(
      true,
    );
    expect(report.kind).toBe('regression');

    // A scope listing both dimensions with no node restriction permits every
    // difference → intended.
    const scoped = diffReplay(golden, trace, {
      dimensions: ['routing', 'control-flow'],
    });
    expect(scoped.kind).toBe('intended');

    // Restrict node ids to just the branch node: routing is in-scope but the
    // control-flow difference anchors on the child node → out of scope →
    // regression.
    const nodeRestricted = diffReplay(golden, trace, {
      dimensions: ['routing', 'control-flow'],
      nodeIds: [conditionalNodeId as string],
    });
    expect(nodeRestricted.kind).toBe('regression');
  });
});

describe('B2 ChangeScope schema', () => {
  it('accepts well-formed scopes', () => {
    expect(ChangeScopeSchema.parse({})).toEqual({});
    expect(
      ChangeScopeSchema.parse({
        nodeIds: ['a', 'b'],
        dimensions: ['tool-args', 'routing'],
      }),
    ).toEqual({ nodeIds: ['a', 'b'], dimensions: ['tool-args', 'routing'] });
  });

  it('rejects unknown dimensions and extra keys', () => {
    expect(() =>
      ChangeScopeSchema.parse({ dimensions: ['not-a-dimension'] }),
    ).toThrow();
    expect(() => ChangeScopeSchema.parse({ nodeIds: [1, 2] })).toThrow();
    expect(() => ChangeScopeSchema.parse({ unexpected: true })).toThrow();
  });
});
