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
import type { RunRecordEntry, StoredRun } from '../../durable';
import {
  createRunRecorder,
  digest,
  maxRecordSeq,
  stableStringify,
} from '../../recording';
import { Session } from '../../session';
import { Source } from '../../source';
import { Agent } from '../../templates';
import { Tool } from '../../tool';

// Minimal fake Codex App Server client, mirroring codex_turn.test.ts.
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

// A mocked LlmSource that emits a tool call, so the assistant node produces a
// ModelCallRecord and the following tools node produces a ToolCallRecord.
function toolCallingSource() {
  return Source.llm({ temperature: 0 })
    .mock()
    .mockResponse({
      content: 'calling echo',
      toolCalls: [{ id: 'call-1', name: 'echo', arguments: { x: 1 } }],
    });
}

const echoTool = Tool.create({
  name: 'echo',
  description: 'Echoes its input.',
  inputSchema: z.object({ x: z.number() }),
  effect: { idempotencyKey: 'echo:1' },
  execute: (input: { x: number }) => `echo:${input.x}`,
});

// system + receive + assistant(tool call) + tools + conditional(then branch).
function recordingAgent() {
  return Agent.create('rec')
    .system('sys', 'be helpful')
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

function sortedRecording(run: StoredRun<any> | undefined): RunRecordEntry[] {
  return [...(run?.recording ?? [])].sort(
    (a, b) => a.record.seq - b.record.seq,
  );
}

describe('B0 recording — pure helpers', () => {
  it('stableStringify sorts object keys deterministically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(
      stableStringify({ a: 2, b: 1 }),
    );
    expect(stableStringify({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    // Nested + arrays keep array order but sort keys recursively.
    expect(stableStringify({ z: [{ q: 1, p: 2 }] })).toBe(
      '{"z":[{"p":2,"q":1}]}',
    );
    expect(stableStringify(undefined)).toBe('null');
  });

  it('digest is stable and order-independent', () => {
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
  });

  it('maxRecordSeq returns -1 for an empty stream', () => {
    expect(maxRecordSeq(undefined)).toBe(-1);
    expect(maxRecordSeq([])).toBe(-1);
  });
});

describe('B0 recording — capture', () => {
  it("'decisions' produces the expected ordered stream", async () => {
    const store = new MemoryRunStore();
    const app = PromptTrail.app({
      agents: { rec: recordingAgent() },
      store,
      recording: 'decisions',
    });

    const result = await app.run({
      agent: 'rec',
      runId: 'rec-1',
      input: 'hello',
      checkpoint: true,
    });
    expect(result.status).toBe('done');

    const entries = sortedRecording(await store.get('rec-1'));
    const shape = entries.map((entry) => {
      if (entry.kind === 'node') {
        return {
          kind: 'node',
          nodeType: entry.record.nodeType,
          branch: entry.record.branch,
        };
      }
      if (entry.kind === 'model') {
        return { kind: 'model', provider: entry.record.provider };
      }
      return { kind: 'tool', toolName: entry.record.toolName };
    });

    expect(shape).toEqual([
      { kind: 'node', nodeType: 'system', branch: undefined },
      { kind: 'node', nodeType: 'inbox', branch: undefined },
      { kind: 'node', nodeType: 'assistant', branch: undefined },
      { kind: 'model', provider: 'assistant' },
      { kind: 'node', nodeType: 'tools', branch: undefined },
      { kind: 'tool', toolName: 'echo' },
      { kind: 'node', nodeType: 'conditional', branch: undefined },
      { kind: 'node', nodeType: 'conditional', branch: 'then' },
      { kind: 'node', nodeType: 'system', branch: undefined },
    ]);

    // seq is a dense monotonic 0..N stream.
    expect(entries.map((entry) => entry.record.seq)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);

    const model = entries.find((entry) => entry.kind === 'model');
    expect(model?.kind).toBe('model');
    if (model?.kind === 'model') {
      expect(model.record.requestDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(model.record.response).toBeDefined();
      // 'decisions' drops the normalized request.
      expect(model.record.request).toBeUndefined();
      expect(model.record.nodePath).toBe('rec/ask');
      expect(model.record.callIndex).toBe(0);
    }

    const tool = entries.find((entry) => entry.kind === 'tool');
    expect(tool?.kind).toBe('tool');
    if (tool?.kind === 'tool') {
      expect(tool.record.argsDigest).toBe(digest({ x: 1 }));
      expect(tool.record.input).toBeUndefined(); // dropped at 'decisions'
      expect(tool.record.result).toBeDefined();
      expect(tool.record.effect).toEqual({ idempotencyKey: 'echo:1' });
      expect(tool.record.nodePath).toBe('rec/run');
    }
  });

  it("'full' stores the normalized request and parsed tool input", async () => {
    const store = new MemoryRunStore();
    const app = PromptTrail.app({
      agents: { rec: recordingAgent() },
      store,
      recording: 'full',
    });

    await app.run({
      agent: 'rec',
      runId: 'rec-full',
      input: 'hello',
      checkpoint: true,
    });

    const entries = sortedRecording(await store.get('rec-full'));
    const model = entries.find((entry) => entry.kind === 'model');
    if (model?.kind === 'model') {
      expect(model.record.request).toBeDefined();
      expect(
        (model.record.request as { messages: unknown }).messages,
      ).toBeDefined();
      // requestMeta = the source manifest descriptor (resolved LLMOptions).
      expect((model.record.request as { meta: unknown }).meta).toBeTruthy();
    }
    const tool = entries.find((entry) => entry.kind === 'tool');
    if (tool?.kind === 'tool') {
      expect(tool.record.input).toEqual({ x: 1 });
    }
  });

  it("'off' records nothing", async () => {
    const store = new MemoryRunStore();
    const app = PromptTrail.app({
      agents: { rec: recordingAgent() },
      store,
      // recording defaults to 'off'
    });

    await app.run({
      agent: 'rec',
      runId: 'rec-off',
      input: 'hello',
      checkpoint: true,
    });

    const run = await store.get('rec-off');
    expect(run?.recording ?? []).toEqual([]);
  });

  it('seq continues monotonically across suspend/resume', async () => {
    const store = new MemoryRunStore();
    const suspendable = Agent.create('susp')
      .assistant(
        'a1',
        Source.llm({ temperature: 0 })
          .mock()
          .mockResponse({ content: 'first' }),
      )
      .awaitInput('gate')
      .assistant(
        'a2',
        Source.llm({ temperature: 0 })
          .mock()
          .mockResponse({ content: 'second' }),
      );
    const app = PromptTrail.app({
      agents: { susp: suspendable },
      store,
      recording: 'decisions',
    });

    const first = await app.run({
      agent: 'susp',
      runId: 'susp-1',
      checkpoint: true,
    });
    expect(first.status).toBe('suspended');
    const afterSuspend = sortedRecording(await store.get('susp-1'));
    const suspendMaxSeq = maxRecordSeq(afterSuspend);
    expect(suspendMaxSeq).toBeGreaterThanOrEqual(1);

    const resumed = await app.send({ runId: 'susp-1', input: 'go' });
    expect(resumed.status).toBe('done');

    const all = sortedRecording(await store.get('susp-1'));
    const seqs = all.map((entry) => entry.record.seq);
    // Strictly increasing, no collisions across the resume boundary.
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.max(...seqs)).toBeGreaterThan(suspendMaxSeq);
    // Two assistant model calls total, across the two resumes.
    expect(all.filter((entry) => entry.kind === 'model')).toHaveLength(2);
  });

  it('produces identical requestDigests for two identical runs', async () => {
    const runOnce = async (runId: string) => {
      const store = new MemoryRunStore();
      const app = PromptTrail.app({
        agents: { rec: recordingAgent() },
        store,
        recording: 'decisions',
      });
      await app.run({ agent: 'rec', runId, input: 'hello', checkpoint: true });
      const entries = sortedRecording(await store.get(runId));
      const model = entries.find((entry) => entry.kind === 'model');
      return model?.kind === 'model' ? model.record.requestDigest : undefined;
    };

    const a = await runOnce('rec-a');
    const b = await runOnce('rec-b');
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('records under lease mode via the fenced store', async () => {
    const store = new MemoryRunStore();
    const app = PromptTrail.app({
      agents: { rec: recordingAgent() },
      store,
      recording: 'decisions',
      lease: { holder: 'solo', ttlMs: 10_000 },
    });
    await app.start();
    try {
      await app.run({
        agent: 'rec',
        runId: 'rec-lease',
        input: 'hello',
        checkpoint: true,
      });
    } finally {
      await app.stop();
    }

    const entries = sortedRecording(await store.get('rec-lease'));
    expect(entries.some((entry) => entry.kind === 'model')).toBe(true);
    expect(entries.some((entry) => entry.kind === 'tool')).toBe(true);
  });

  it('captures a codex turn model record with provider "codex"', async () => {
    const store = new MemoryRunStore();
    const client = new FakeCodexClient();
    const agent = Agent.create('codexAgent')
      .user('do it')
      .codex({ client, model: 'gpt-5.4-nano' });
    const app = PromptTrail.app({
      agents: { codexAgent: agent },
      store,
      recording: 'decisions',
    });

    await app.run({
      agent: 'codexAgent',
      runId: 'codex-1',
      checkpoint: true,
    });

    const entries = sortedRecording(await store.get('codex-1'));
    const model = entries.find((entry) => entry.kind === 'model');
    expect(model?.kind).toBe('model');
    if (model?.kind === 'model') {
      expect(model.record.provider).toBe('codex');
      expect(model.record.requestDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(model.record.response).toBeDefined();
    }
  });
});

describe('B0 recording — recorder unit', () => {
  it('assigns per-nodePath callIndex and fire-ordered seq', async () => {
    const appended: RunRecordEntry[] = [];
    const recorder = createRunRecorder({
      level: 'full',
      initialSeq: -1,
      append: async (entry) => {
        appended.push(entry);
      },
      now: () => 123,
    });

    const session = Session.create().addMessage({
      type: 'user',
      content: 'hi',
    });
    recorder.node({ nodePath: 'g/a', nodeType: 'assistant' });
    recorder.model({
      nodePath: 'g/a',
      provider: 'assistant',
      requestSession: session,
      response: { content: 'x' },
    });
    recorder.model({
      nodePath: 'g/a',
      provider: 'assistant',
      requestSession: session,
      response: { content: 'y' },
    });
    await recorder.drain();

    expect(appended.map((entry) => entry.record.seq)).toEqual([0, 1, 2]);
    const models = appended.filter((entry) => entry.kind === 'model');
    expect(
      models.map(
        (entry) =>
          (entry as { record: { callIndex: number } }).record.callIndex,
      ),
    ).toEqual([0, 1]);
    expect(appended[0].record.at).toBe(123);
  });
});
