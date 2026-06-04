import { describe, expect, it } from 'vitest';
import {
  MemoryDurableRuntime,
  agent,
  NondeterminismError,
} from '../../durable';

describe('durable agent runtime', () => {
  it('suspends at awaitUser and resumes from the inbox', async () => {
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
    const runtime = new MemoryDurableRuntime();

    const first = await runtime.start(assistant, {
      runId: 'run-1',
      input: 'hello',
    });

    expect(first.status).toBe('suspended');
    expect(first.awaiting).toBe('main/next/input');
    expect(first.session.messages.map((message) => message.content)).toEqual([
      'You are helpful.',
      'hello',
      'turn 1',
    ]);
    expect(modelCalls).toBe(1);

    const second = await runtime.send('run-1', 'next message');

    expect(second.status).toBe('done');
    expect(second.session.messages.map((message) => message.content)).toEqual([
      'You are helpful.',
      'hello',
      'turn 1',
      'next message',
    ]);
    expect(modelCalls).toBe(1);
  });

  it('journals model and tool effects so resume does not re-execute them', async () => {
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
    const runtime = new MemoryDurableRuntime();

    const first = await runtime.start(assistant, {
      runId: 'run-2',
      input: 'hello',
    });
    const replay = await runtime.resume('run-2');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(modelCalls).toBe(2);
    expect(toolCalls).toBe(1);
    expect(runtime.journal('run-2')).toEqual([
      'main#0/inbox/peek',
      'main#0/reply/model',
      'main#0/tools/call-1',
      'main#1/inbox/peek',
      'main#1/reply/model',
    ]);
  });

  it('detects replay divergence when the graph changes under an existing run', async () => {
    const runtime = new MemoryDurableRuntime();
    const firstAgent = agent('first')
      .system('System')
      .assistant('a', () => 'A');

    await runtime.start(firstAgent, { runId: 'run-3' });

    const changedAgent = agent('changed')
      .system('System')
      .assistant('b', () => 'B');

    await runtime.start(changedAgent, { runId: 'run-4' });
    expect(runtime.journal('run-4')).toEqual(['b/model']);
  });

  it('throws NondeterminismError for mismatched journal order', async () => {
    const runtime = new MemoryDurableRuntime();
    const stable = agent('stable')
      .system('System')
      .assistant('a', () => 'A');

    await runtime.start(stable, { runId: 'run-5' });

    const run = (runtime as any).runs.get('run-5');
    run.agent = agent('changed')
      .system('System')
      .assistant('b', () => 'B');
    run.status = 'open';
    run.result = undefined;

    await expect(runtime.resume('run-5')).rejects.toBeInstanceOf(
      NondeterminismError,
    );
  });
});
