import { describe, expect, it } from 'vitest';
import { createAgentGraph } from '../../graph';
import {
  executeAgentGraph,
  GraphExecutionSuspended,
} from '../../graph_executor';
import { Source } from '../../source';
import { Agent } from '../../templates';

describe('GraphExecutor', () => {
  it('executes basic system, inbox, and assistant graph nodes', async () => {
    const graph = createAgentGraph({
      name: 'assistant',
      nodes: [
        { id: 'system', type: 'system', data: { content: 'Be concise.' } },
        { id: 'inbound', type: 'inbox' },
        { id: 'reply', type: 'assistant', data: { input: 'ok' } },
      ],
    });

    const session = await executeAgentGraph(graph, { input: 'hello' });

    expect(session.messages.map((message) => message.type)).toEqual([
      'system',
      'user',
      'assistant',
    ]);
    expect(session.getLastMessage()?.content).toBe('ok');
  });

  it('executes turn repeat blocks with source-backed assistant nodes', async () => {
    let calls = 0;
    const graph = Agent.create('assistant')
      .turn('main', (turn) =>
        turn.repeat('loop', () => calls++ < 2, (loop) =>
          loop.assistant('reply', Source.literal('tick')),
        ),
      )
      .toGraph();

    const session = await executeAgentGraph(graph);

    expect(session.messages.map((message) => message.content)).toEqual([
      'tick',
      'tick',
    ]);
  });

  it('suspends awaitInput nodes with a typed signal and stable node path', async () => {
    const graph = createAgentGraph({
      name: 'assistant',
      nodes: [{ id: 'wait', type: 'awaitInput' }],
    });

    await expect(executeAgentGraph(graph)).rejects.toMatchObject({
      name: 'GraphExecutionSuspended',
      nodePath: 'assistant/wait',
    });
    await expect(executeAgentGraph(graph)).rejects.toBeInstanceOf(
      GraphExecutionSuspended,
    );
  });

  it('fails tools nodes that see pending tool calls before tool execution is implemented', async () => {
    const graph = createAgentGraph({
      name: 'assistant',
      nodes: [
        {
          id: 'reply',
          type: 'assistant',
          data: {
            input: () => ({
              type: 'assistant',
              content: '',
              toolCalls: [
                { id: 'call-1', name: 'lookup', arguments: { id: '1' } },
              ],
            }),
          },
        },
        { id: 'tools', type: 'tools' },
      ],
    });

    await expect(executeAgentGraph(graph)).rejects.toThrow(
      /assistant\/tools cannot execute tool calls yet/,
    );
  });

  it('fails goal nodes until attempts and satisfaction are executable', async () => {
    const graph = Agent.create('research')
      .goal('researchTopic', 'Research the topic', {
        model: Source.literal('done'),
      })
      .toGraph();

    await expect(
      executeAgentGraph(graph, { maxLoopIterations: 1 }),
    ).rejects.toThrow(/research\/researchTopic is not executable yet: goal/);
  });
});
