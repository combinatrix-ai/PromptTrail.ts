import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentGraphManifest } from '../../../graph';
import { Source } from '../../../source';
import { Agent } from '../../../templates';
import { Tool } from '../../../tool';

describe('Agent graph authoring', () => {
  it('builds a named agent graph with explicit node ids', () => {
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Look up a value.',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => ({ id }),
    });

    const agent = Agent.create('assistant')
      .system('system', 'You are concise.')
      .tool('lookup', lookup)
      .turn('main', (turn) =>
        turn
          .inbox('inbound')
          .repeat('toolLoop', ({ session }) => session.messages.length > 0, (
            loop,
          ) =>
            loop
              .assistant('reply', Source.literal('ok'))
              .tools('tools'),
          )
          .awaitInput('next'),
      );

    const graph = agent.toGraph('v1');
    const manifest = createAgentGraphManifest(graph);

    expect(graph.name).toBe('assistant');
    expect(Object.keys(graph.tools)).toEqual(['lookup']);
    expect(manifest.nodes.map((node) => [node.path, node.type])).toEqual([
      ['assistant/system', 'system'],
      ['assistant/main', 'turn'],
      ['assistant/main/inbound', 'inbox'],
      ['assistant/main/toolLoop', 'loop'],
      ['assistant/main/toolLoop/reply', 'assistant'],
      ['assistant/main/toolLoop/tools', 'tools'],
      ['assistant/main/next', 'awaitInput'],
    ]);
  });

  it('requires a named agent before graph compilation', () => {
    expect(() => Agent.create().system('hello').toGraph()).toThrow(
      /Agent\.create\(name\)/,
    );
  });

  it('treats assistant(id) as a graph node for named agents', () => {
    const graph = Agent.create('assistant').assistant('reply').toGraph();

    expect(graph.nodes).toEqual([
      {
        id: 'reply',
        type: 'assistant',
        data: undefined,
      },
    ]);
  });

  it('does not execute graph-authored agents through the legacy template runtime', async () => {
    await expect(
      Agent.create('assistant')
        .system('system', 'You are concise.')
        .turn('main', (turn) => turn.assistant('reply'))
        .execute(),
    ).rejects.toThrow(/GraphExecutor/);
  });
});
