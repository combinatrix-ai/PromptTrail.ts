import { describe, expect, it } from 'vitest';
import {
  MemoryDurableRuntime,
  NondeterminismError,
  PromptTrail,
  agent,
  manualSource,
  memoryStore,
} from '../../durable';

describe('durable agent runtime', () => {
  it('runs durable agents through the app runtime', async () => {
    let modelCalls = 0;
    const assistant = agent('assistant')
      .system('You are helpful.')
      .turn('main', (turn) =>
        turn
          .steer('inbox')
          .assistant('reply', () => {
            modelCalls++;
            return `turn ${modelCalls}`;
          })
          .awaitUser('next'),
      );
    const app = PromptTrail.app({
      agents: { assistant },
      store: memoryStore(),
    });

    const first = await app.run({
      agent: 'assistant',
      runId: 'run-1',
      input: 'hello',
      durable: true,
    });

    expect(first.status).toBe('suspended');
    expect(first.awaiting).toBe('main/next/input');
    expect(first.session.messages.map((message) => message.content)).toEqual([
      'You are helpful.',
      'hello',
      'turn 1',
    ]);
    expect(modelCalls).toBe(1);

    const second = await app.send({
      runId: 'run-1',
      input: 'next message',
    });

    expect(second.status).toBe('done');
    expect(second.session.messages.map((message) => message.content)).toEqual([
      'You are helpful.',
      'hello',
      'turn 1',
      'next message',
    ]);
    expect(modelCalls).toBe(1);
  });

  it('journals model and tool effects for durable replay', async () => {
    let modelCalls = 0;
    let toolCalls = 0;
    const assistant = agent('tool-agent')
      .system('Use tools.')
      .tool('lookup', {
        execute: async ({ query }) => {
          toolCalls++;
          return `result:${query}`;
        },
      })
      .turn('main', (turn) =>
        turn
          .steer('inbox')
          .assistant('reply', (session) => {
            modelCalls++;
            const hasToolResult = session
              .getMessagesByType('tool_result')
              .some((message) => message.content === 'result:hello');
            if (hasToolResult) {
              return 'done';
            }
            return {
              content: 'need tool',
              toolCalls: [
                {
                  id: 'call-1',
                  name: 'lookup',
                  arguments: { query: 'hello' },
                },
              ],
            };
          })
          .runTools('tools')
          .untilNoToolCalls()
          .awaitUser('next'),
      );
    const app = PromptTrail.app({
      agents: { assistant },
      store: memoryStore(),
    });

    const first = await app.run({
      agent: assistant,
      runId: 'run-2',
      input: 'hello',
      durable: true,
    });
    const replay = await app.resume('run-2');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(modelCalls).toBe(2);
    expect(toolCalls).toBe(1);
    expect(app.journal('run-2')).toEqual([
      'main#0/inbox/peek',
      'main#0/reply/model',
      'main#0/tools/call-1',
      'main#1/inbox/peek',
      'main#1/reply/model',
    ]);
  });

  it('journals resolved session transitions without re-running patch handlers', async () => {
    let patchCalls = 0;
    const assistant = agent('patch-agent')
      .patch('stamp', () => {
        patchCalls++;
        return {
          session: {
            vars: {
              stamp: patchCalls,
            },
          },
        };
      })
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { assistant },
      store: memoryStore(),
    });

    const first = await app.run({
      agent: assistant,
      runId: 'run-patch',
      durable: true,
    });
    const replay = await app.resume('run-patch');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(first.session.getVarsObject()).toEqual({ stamp: 1 });
    expect(replay.session.getVarsObject()).toEqual({ stamp: 1 });
    expect(patchCalls).toBe(1);
    expect(app.journal('run-patch')).toEqual(['stamp/transition']);
  });

  it('rejects unsupported commands from durable patch transitions', async () => {
    const assistant = agent('patch-command').patch('pause', () => ({
      command: { type: 'suspend', reason: 'manual' },
    }));
    const app = PromptTrail.app({ store: memoryStore() });

    await expect(
      app.run({
        agent: assistant,
        runId: 'run-patch-command',
        durable: true,
      }),
    ).rejects.toThrow(
      'Durable patch pause returned unsupported command suspend.',
    );
    expect(app.journal('run-patch-command')).toEqual([]);
  });

  it('rejects middlewareState writes from durable patch transitions', async () => {
    const assistant = agent('patch-middleware-state').patch('state', () => ({
      session: {
        middlewareState: {
          local: true,
        },
      },
    }));
    const app = PromptTrail.app({ store: memoryStore() });

    await expect(
      app.run({
        agent: assistant,
        runId: 'run-patch-middleware-state',
        durable: true,
      }),
    ).rejects.toThrow('Durable patch state cannot write middlewareState yet.');
    expect(app.journal('run-patch-middleware-state')).toEqual([]);
  });

  it('can run ephemeral executions without persisting them', async () => {
    const assistant = agent('ephemeral').assistant('reply', () => 'hello');
    const app = PromptTrail.app({ agents: { assistant } });

    const result = await app.run({
      agent: 'assistant',
      input: 'ignored',
    });

    expect(result.status).toBe('done');
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'hello',
    ]);
    expect(() => app.journal(result.runId)).toThrow('Unknown durable run');
  });

  it('throws NondeterminismError for mismatched journal order', async () => {
    const store = memoryStore();
    const app = PromptTrail.app({ store });
    const stable = agent('stable')
      .system('System')
      .assistant('a', () => 'A');

    await app.run({
      agent: stable,
      runId: 'run-5',
      durable: true,
    });

    const run = store.get('run-5')!;
    run.agent = agent('changed')
      .system('System')
      .assistant('b', () => 'B');
    run.status = 'open';
    run.result = undefined;

    await expect(app.resume('run-5')).rejects.toBeInstanceOf(
      NondeterminismError,
    );
  });

  it('routes events from app sources into durable runs', async () => {
    const source = manualSource();
    const assistant = agent('assistant')
      .system('System')
      .turn('main', (turn) =>
        turn
          .steer()
          .assistant(
            'reply',
            (session) => `seen:${session.getMessagesByType('user').length}`,
          )
          .awaitUser(),
      );
    const app = PromptTrail.app({
      agents: { assistant },
      sources: { manual: source },
      store: memoryStore(),
    });

    await app.start();
    await source.emit({
      source: 'manual',
      agent: 'assistant',
      runId: 'run-6',
      input: 'hello',
      durable: true,
    });

    const result = await app.resume('run-6');

    expect(result.status).toBe('suspended');
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'System',
      'hello',
      'seen:1',
    ]);
  });

  it('keeps MemoryDurableRuntime as a compatibility wrapper', async () => {
    const runtime = new MemoryDurableRuntime();
    const assistant = agent('assistant')
      .assistant('reply', () => 'hello')
      .turn('wait', (turn) => turn.awaitUser());

    const result = await runtime.start(assistant, {
      runId: 'compat',
    });

    expect(result.status).toBe('suspended');
    expect(runtime.journal('compat')).toEqual(['reply/model']);
  });
});
