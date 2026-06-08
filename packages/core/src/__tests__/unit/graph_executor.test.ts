import { describe, expect, it } from 'vitest';
import { createAgentGraph } from '../../graph';
import { executeAgentGraph } from '../../graph_executor';
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

  it('executes the stable goal prompt and model skeleton', async () => {
    const graph = Agent.create('research')
      .goal('researchTopic', 'Research the topic', {
        model: Source.literal('done'),
      })
      .toGraph();

    const session = await executeAgentGraph(graph, { maxLoopIterations: 1 });

    expect(session.messages.map((message) => message.content)).toEqual([
      'Research the topic',
    ]);
  });
});
