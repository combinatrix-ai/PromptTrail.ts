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

  it('executes graph-authored agents through GraphExecutor', async () => {
    const session = await Agent.create('assistant')
      .system('system', 'You are concise.')
      .turn('main', (turn) =>
        turn.inbox('inbound').assistant('reply', Source.literal('ok')),
      )
      .execute({ input: 'hello' });

    expect(session.messages.map((message) => message.content)).toEqual([
      'You are concise.',
      'hello',
      'ok',
    ]);
  });

  it('builds top-level graph messages and patch nodes', async () => {
    const agent = Agent.create('assistant')
      .messages('derived', () => [{ type: 'user', content: 'derived input' }])
      .patch('mark', (session) => session.withVar('marked', true));

    const graph = agent.toGraph('v1');
    const session = await agent.execute();

    expect(graph.nodes.map((node) => [node.id, node.type])).toEqual([
      ['derived', 'messages'],
      ['mark', 'patch'],
    ]);
    expect(session.messages.map((message) => message.content)).toEqual([
      'derived input',
    ]);
    expect(session.getVar('marked')).toBe(true);
  });

  it('requires explicit ids for named graph messages and patch nodes', () => {
    expect(() =>
      Agent.create('assistant').messages(() => [
        { type: 'user', content: 'missing id' },
      ]),
    ).toThrow(/messages\(id, handler\)/);
    expect(() =>
      Agent.create('assistant').patch((session) => session),
    ).toThrow(/patch\(id, handler\)/);
  });

  it('does not silently discard unsupported durable graph execution', async () => {
    const agent = Agent.create('assistant')
      .assistant('reply', Source.literal('ok'))
      .durable();

    await expect(agent.execute({ input: 'hello' })).rejects.toThrow(
      /durable execution yet/,
    );
  });

  it('compiles goal nodes into a stable subgraph', () => {
    const graph = Agent.create('research')
      .goal('researchTopic', 'Research the topic thoroughly', {
        interaction: 'required',
        maxAttempts: 3,
        isSatisfied: ({ session }) => session.messages.length > 2,
      })
      .toGraph('v1');

    const manifest = createAgentGraphManifest(graph);

    expect(manifest.nodes.map((node) => [node.path, node.type])).toEqual([
      ['research/researchTopic', 'goal'],
      ['research/researchTopic/prompt', 'user'],
      ['research/researchTopic/attempts', 'loop'],
      ['research/researchTopic/attempts/model', 'assistant'],
      ['research/researchTopic/attempts/tools', 'tools'],
      ['research/researchTopic/attempts/check', 'patch'],
      ['research/researchTopic/attempts/interaction', 'awaitInput'],
    ]);
    expect(manifest.nodes.find((node) => node.path.endsWith('/check'))?.data)
      .toMatchObject({
        kind: 'goalSatisfaction',
        durability: 'materialized',
      });
  });
});
