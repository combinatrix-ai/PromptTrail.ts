import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  CodexAppServerClient,
  CodexSkillListResult,
  CodexThreadStartParams,
  CodexThreadStartResult,
  CodexTurnResult,
  CodexTurnStartParams,
} from '../../codex_app_server';
import { MemoryRunStore, PromptTrail } from '../../durable';
import type { RecordLevel, StoredRun } from '../../durable';
import { digest } from '../../recording';
import {
  ReplayMissError,
  buildCassette,
  replayRun,
  replaySelfCheck,
} from '../../replay';
import type { ReplayTrace } from '../../replay';
import { Source } from '../../source';
import { Agent } from '../../templates';
import { Tool } from '../../tool';
import { Validation } from '../../validators/validation';

class FakeCodexClient implements CodexAppServerClient {
  async listSkills(): Promise<CodexSkillListResult | unknown[]> {
    return { skills: [] };
  }
  async startThread(
    _params: CodexThreadStartParams,
  ): Promise<CodexThreadStartResult> {
    return { threadId: 'thread-1' };
  }
  async startTurn(params: CodexTurnStartParams): Promise<CodexTurnResult> {
    return {
      threadId: params.threadId,
      turnId: 'turn-1',
      status: 'completed',
      finalAnswer: 'Codex result',
    };
  }
}

const echoTool = Tool.create({
  name: 'echo',
  description: 'Echoes its input.',
  inputSchema: z.object({ x: z.number() }),
  effect: { idempotencyKey: 'echo:1' },
  execute: (input: { x: number }) => `echo:${input.x}`,
});

function toolCallingSource() {
  return Source.llm({ temperature: 0 })
    .mock()
    .mockResponse({
      content: 'calling echo',
      toolCalls: [{ id: 'call-1', name: 'echo', arguments: { x: 1 } }],
    });
}

// system + receive + assistant(tool call) + tools + conditional(then branch).
function recordingAgent(systemText = 'be helpful') {
  return Agent.create('rec')
    .system('sys', systemText)
    .inbox('inbound')
    .tool('echo', echoTool)
    .assistant('ask', toolCallingSource())
    .tools('run')
    .conditional(
      'branch',
      () => true,
      (a) => a.system('note', 'branch taken'),
    );
}

async function recordRun(
  agent: Agent<any>,
  options: {
    runId: string;
    agentName: string;
    recording?: RecordLevel;
    input?: string;
    services?: Record<string, unknown>;
  },
): Promise<{ store: MemoryRunStore; run: StoredRun<any> }> {
  const store = new MemoryRunStore();
  const app = PromptTrail.app({
    agents: { [options.agentName]: agent },
    store,
    recording: options.recording ?? 'decisions',
  });
  await app.run({
    agent: options.agentName,
    runId: options.runId,
    input: options.input,
    services: options.services,
    checkpoint: true,
  });
  const run = await store.get(options.runId);
  if (!run) {
    throw new Error('run not stored');
  }
  return { store, run };
}

function signature(trace: ReplayTrace): unknown {
  return {
    nodes: trace.nodes,
    modelCalls: trace.modelCalls.map((call) => ({
      nodePath: call.nodePath,
      output: call.output,
    })),
    toolCalls: trace.toolCalls,
    structured: trace.structured,
    finalReply: trace.finalReply.map((message) => message.content),
  };
}

describe('B1 buildCassette', () => {
  it('buckets the recording into positional per-kind queues', async () => {
    const { run } = await recordRun(recordingAgent(), {
      runId: 'c-1',
      agentName: 'rec',
      input: 'hello',
    });
    const cassette = buildCassette(run);
    expect(cassette.model).toHaveLength(1);
    expect(cassette.model[0].provider).toBe('assistant');
    expect(cassette.tools).toHaveLength(1);
    expect(cassette.tools[0].toolName).toBe('echo');
    expect(cassette.nodes.length).toBeGreaterThan(0);
  });

  it('errors when the run was not recorded', async () => {
    const store = new MemoryRunStore();
    const app = PromptTrail.app({
      agents: { rec: recordingAgent() },
      store,
      // recording defaults to 'off'
    });
    await app.run({
      agent: 'rec',
      runId: 'c-off',
      input: 'hello',
      checkpoint: true,
    });
    const run = await store.get('c-off');
    expect(() => buildCassette(run!)).toThrow(/not recorded/);
  });

  it('errors on byte/file content placeholders', async () => {
    const { run } = await recordRun(recordingAgent(), {
      runId: 'c-bytes',
      agentName: 'rec',
      input: 'hello',
    });
    // Inject an omitted-bytes placeholder into the initial session to simulate a
    // byte/file-content run (excluded from the v1 corpus).
    const poisoned: StoredRun<any> = {
      ...run,
      initial: run.initial.addMessage({
        type: 'user',
        content: 'see prompttrail://omitted-bytes/image.png',
      }),
    };
    expect(() => buildCassette(poisoned)).toThrow(/byte\/file content/);
  });
});

describe('B1 replaySelfCheck', () => {
  it.each<RecordLevel>(['decisions', 'full'])(
    'replays a stored run to an identical trace at %s level',
    async (level) => {
      const { run } = await recordRun(recordingAgent(), {
        runId: `sc-${level}`,
        agentName: 'rec',
        input: 'hello',
        recording: level,
      });
      const result = await replaySelfCheck(run);
      expect(result.identical).toBe(true);
      expect(result.firstDivergence).toBeUndefined();
    },
  );

  it('replays a validator-retry assistant positionally (multiple model records)', async () => {
    // Node-level validator that fails the first mock response and passes the
    // second, so recording captures two model records at the same nodePath.
    const retrySource = Source.llm({ temperature: 0 })
      .mock()
      .mockResponses({ content: 'nope' }, { content: 'ok done' });
    const agent = Agent.create('retry')
      .user('u', 'go')
      .assistant(retrySource, {
        validator: Validation.custom((content) => content.includes('ok')),
        maxAttempts: 3,
      });
    const { run } = await recordRun(agent, {
      runId: 'retry-1',
      agentName: 'retry',
    });
    const cassette = buildCassette(run);
    expect(cassette.model.length).toBe(2);

    const check = await replaySelfCheck(run);
    expect(check.identical).toBe(true);
    const { trace } = await replayRun(run);
    expect(trace.modelCalls).toHaveLength(2);
    expect(new Set(trace.modelCalls.map((c) => c.nodePath)).size).toBe(1);
  });

  it('replays a loop with two iterations under one nodePath', async () => {
    const agent = Agent.create('looping').loop(
      'body',
      (a) =>
        a.assistant(
          'step',
          Source.llm({ temperature: 0 })
            .mock()
            .mockResponse({ content: 'tick' }),
        ),
      ({ session }) =>
        session.messages.filter((m) => m.type === 'assistant').length < 2,
    );
    const { run } = await recordRun(agent, {
      runId: 'loop-1',
      agentName: 'looping',
    });
    const cassette = buildCassette(run);
    expect(cassette.model).toHaveLength(2);

    const check = await replaySelfCheck(run);
    expect(check.identical).toBe(true);
    const { trace } = await replayRun(run);
    expect(trace.modelCalls).toHaveLength(2);
    expect(new Set(trace.modelCalls.map((c) => c.nodePath)).size).toBe(1);
  });
});

describe('B1 miss policy', () => {
  it('throws ReplayMissError with position info on an exhausted cassette', async () => {
    const { run } = await recordRun(recordingAgent(), {
      runId: 'miss-1',
      agentName: 'rec',
      input: 'hello',
    });
    const cassette = buildCassette(run);
    // Truncate the model queue so the assistant node's model call misses.
    const truncated = { ...cassette, model: [] };
    await expect(replayRun(run, { cassette: truncated })).rejects.toMatchObject(
      {
        name: 'ReplayMissError',
        kind: 'model',
        position: 0,
      },
    );
    await expect(
      replayRun(run, { cassette: truncated }),
    ).rejects.toBeInstanceOf(ReplayMissError);
  });

  it('rejects an unsupported miss policy', async () => {
    const { run } = await recordRun(recordingAgent(), {
      runId: 'miss-2',
      agentName: 'rec',
      input: 'hello',
    });
    await expect(
      replayRun(run, { miss: 'flag' as unknown as 'error' }),
    ).rejects.toThrow(/not supported in B1/);
  });
});

describe('B1 positional keying is agent-agnostic', () => {
  it('replays a changed agent (different prompt text) without a miss', async () => {
    const { run } = await recordRun(recordingAgent('be helpful'), {
      runId: 'changed-1',
      agentName: 'rec',
      input: 'hello',
    });
    // A structurally identical agent with different system text still replays
    // positionally (divergence detection is B2, not B1).
    const changed = recordingAgent('be extremely terse');
    const { trace } = await replayRun(run, { agent: changed });
    expect(trace.modelCalls).toHaveLength(1);
    expect(trace.toolCalls).toHaveLength(1);
    expect(trace.misses).toEqual([]);
  });
});

describe('B1 sealed side effects', () => {
  it('serves tool results from the cassette without executing the tool', async () => {
    let sideEffectCount = 0;
    const countingTool = Tool.create({
      name: 'bump',
      description: 'Increments a counter as a side effect.',
      inputSchema: z.object({ n: z.number() }),
      effect: { idempotencyKey: 'bump:1' },
      execute: (input: { n: number }) => {
        sideEffectCount += 1;
        return `bumped:${input.n}`;
      },
    });
    const agent = Agent.create('sfx')
      .user('u', 'go')
      .tool('bump', countingTool)
      .assistant(
        'ask',
        Source.llm({ temperature: 0 })
          .mock()
          .mockResponse({
            content: 'bumping',
            toolCalls: [{ id: 'c1', name: 'bump', arguments: { n: 7 } }],
          }),
      )
      .tools('run');
    const { run } = await recordRun(agent, {
      runId: 'sfx-1',
      agentName: 'sfx',
    });
    expect(sideEffectCount).toBe(1); // executed once while recording

    const { trace, session } = await replayRun(run);
    expect(sideEffectCount).toBe(1); // NOT incremented during replay
    expect(trace.toolCalls).toEqual([
      { name: 'bump', argsDigest: digest({ n: 7 }), hit: true },
    ]);
    const toolResult = session.messages.find((m) => m.type === 'tool_result');
    expect(toolResult?.content).toContain('bumped:7');
  });

  it('captures deliveries into wouldDeliver instead of sending them', async () => {
    const { run } = await recordRun(recordingAgent(), {
      runId: 'deliver-1',
      agentName: 'rec',
      input: 'hello',
      services: { delivery: { platform: 'test-platform', channel: 'c1' } },
    });
    const { trace } = await replayRun(run);
    expect(trace.wouldDeliver.length).toBeGreaterThan(0);
    for (const delivery of trace.wouldDeliver) {
      expect(delivery.target).toMatchObject({ platform: 'test-platform' });
      expect(delivery.message.type).toBe('assistant');
    }
  });
});

describe('B1 determinism', () => {
  it('produces identical traces across two replays of the same cassette', async () => {
    const { run } = await recordRun(recordingAgent(), {
      runId: 'det-1',
      agentName: 'rec',
      input: 'hello',
    });
    const a = await replayRun(run);
    const b = await replayRun(run);
    expect(signature(a.trace)).toEqual(signature(b.trace));
  });

  it('pins Source.random so two replays stay identical', async () => {
    const agent = Agent.create('rnd')
      .user('pick', Source.random(['alpha', 'beta', 'gamma', 'delta']))
      .assistant(
        'ask',
        Source.llm({ temperature: 0 })
          .mock()
          .mockResponse({ content: 'noted' }),
      );
    const { run } = await recordRun(agent, {
      runId: 'rnd-1',
      agentName: 'rnd',
    });
    const a = await replayRun(run);
    const b = await replayRun(run);
    // The pinned rng makes the random pick deterministic across replays.
    const pickA = a.session.messages.find((m) => m.type === 'user')?.content;
    const pickB = b.session.messages.find((m) => m.type === 'user')?.content;
    expect(pickA).toBe(pickB);
    expect(signature(a.trace)).toEqual(signature(b.trace));
  });
});

describe('B1 provider turn replay', () => {
  it('short-circuits a Codex turn with the recorded output', async () => {
    const agent = Agent.create('codexAgent').user('u', 'do it').codex({
      client: new FakeCodexClient(),
      model: 'gpt-5.4-nano',
      retain: 'full',
    });
    const { run } = await recordRun(agent, {
      runId: 'codex-replay',
      agentName: 'codexAgent',
    });
    const cassette = buildCassette(run);
    expect(cassette.model).toHaveLength(1);
    expect(cassette.model[0].provider).toBe('codex');

    const check = await replaySelfCheck(run);
    expect(check.identical).toBe(true);
    const { trace, session } = await replayRun(run);
    expect(trace.modelCalls).toHaveLength(1);
    expect(trace.modelCalls[0].nodePath).toContain('codex');
    expect(
      session.messages.some((m) => m.content.includes('Codex result')),
    ).toBe(true);
  });
});
