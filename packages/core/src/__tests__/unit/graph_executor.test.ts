import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentGraph } from '../../graph';
import {
  executeAgentGraph,
  GraphExecutionSuspended,
} from '../../graph_executor';
import { Session } from '../../session';
import { Source } from '../../source';
import { Agent } from '../../templates';
import { Tool } from '../../tool';

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

  it('fails assistant nodes that return invalid results', async () => {
    const graph = createAgentGraph({
      name: 'assistant',
      nodes: [
        { id: 'reply', type: 'assistant', data: { input: () => 123 } },
      ],
    });

    await expect(executeAgentGraph(graph)).rejects.toThrow(
      /assistant\/reply returned an invalid assistant result/,
    );
  });

  it('fails assistant messages without string content', async () => {
    const graph = createAgentGraph({
      name: 'assistant',
      nodes: [
        {
          id: 'reply',
          type: 'assistant',
          data: { input: () => ({ type: 'assistant' }) },
        },
      ],
    });

    await expect(executeAgentGraph(graph)).rejects.toThrow(
      /assistant\/reply returned an invalid assistant result/,
    );
  });

  it('preserves assistant messages returned by assistant handlers', async () => {
    const graph = createAgentGraph({
      name: 'assistant',
      nodes: [
        {
          id: 'reply',
          type: 'assistant',
          data: {
            input: () => ({
              type: 'assistant',
              content: 'ok',
              attrs: { traceId: 'trace-1' },
              structuredContent: { ok: true },
            }),
          },
        },
      ],
    });

    const session = await executeAgentGraph(graph);

    expect(session.getLastMessage()).toMatchObject({
      type: 'assistant',
      content: 'ok',
      attrs: { traceId: 'trace-1' },
      structuredContent: { ok: true },
    });
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

  it('executes named graph conditional branches', async () => {
    const graph = Agent.create('assistant')
      .conditional(
        'branch',
        ({ context }) => context?.ready === true,
        (then) => then.assistant('reply', 'ready'),
        (otherwise) => otherwise.assistant('reply', 'not ready'),
      )
      .toGraph();

    const thenSession = await executeAgentGraph(graph, {
      context: { ready: true },
    });
    const elseSession = await executeAgentGraph(graph, {
      context: { ready: false },
    });

    expect(thenSession.getLastMessage()?.content).toBe('ready');
    expect(elseSession.getLastMessage()?.content).toBe('not ready');
  });

  it('executes named graph loops with node-local max iterations', async () => {
    const graph = Agent.create('assistant')
      .patch('init', (session) => session.withVar('count', 0))
      .loop(
        'retry',
        (body) =>
          body.patch('increment', (session) =>
            session.withVar('count', Number(session.getVar('count')) + 1),
          ),
        ({ session }) => Number(session.getVar('count')) < 3,
        { maxIterations: 3 },
      )
      .toGraph();

    const session = await executeAgentGraph(graph, { maxLoopIterations: 1 });

    expect(session.getVar('count')).toBe(3);
  });

  it('executes named graph sequences in child order', async () => {
    const graph = Agent.create('assistant')
      .sequence('draft', (step) =>
        step.user('prompt', 'Draft').assistant('reply', 'ok'),
      )
      .assistant('after', 'done')
      .toGraph();

    const session = await executeAgentGraph(graph);

    expect(session.messages.map((message) => message.content)).toEqual([
      'Draft',
      'ok',
      'done',
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

  it('executes registered tools from assistant tool calls', async () => {
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Look up a value.',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => `value:${id}`,
    });
    const graph = createAgentGraph({
      name: 'assistant',
      tools: { lookup },
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

    const session = await executeAgentGraph(graph);

    expect(session.messages.map((message) => message.type)).toEqual([
      'assistant',
      'tool_result',
    ]);
    expect(session.getLastMessage()).toMatchObject({
      type: 'tool_result',
      content: 'value:1',
      attrs: {
        toolCallId: 'call-1',
        toolName: 'lookup',
      },
    });
  });

  it('threads graph context and activity metadata into tools', async () => {
    const seen: unknown[] = [];
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Look up a value.',
      inputSchema: z.object({ id: z.string() }),
      activity: { kind: 'external-read' },
      execute: ({ id }, context) => {
        seen.push({
          id,
          context: context.context,
          activity: context.activity,
          capability: context.capability,
        });
        return `value:${id}`;
      },
    });
    const graph = createAgentGraph({
      name: 'assistant',
      tools: { lookup },
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

    await executeAgentGraph(graph, {
      context: { runId: 'graph-run' },
    });

    expect(seen).toEqual([
      {
        id: '1',
        context: { runId: 'graph-run' },
        activity: { kind: 'external-read' },
        capability: 'lookup',
      },
    ]);
  });

  it('supports pre-condition model/tool loops with Session.hasToolCalls', async () => {
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Look up a value.',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => `value:${id}`,
    });

    const graph = Agent.create('assistant')
      .tool('lookup', lookup)
      .turn('main', (turn) =>
        turn
          .assistant('model', (session) =>
            session.getMessagesByType('tool_result').length === 0
              ? {
                  content: '',
                  toolCalls: [
                    { id: 'call-1', name: 'lookup', arguments: { id: '1' } },
                  ],
                }
              : 'final',
          )
          .repeat('toolLoop', ({ session }) => session.hasToolCalls(), (loop) =>
            loop.tools('tools').assistant('model', (session) =>
              session.getMessagesByType('tool_result').length > 0
                ? 'final'
                : '',
            ),
          ),
      )
      .toGraph();

    const session = await executeAgentGraph(graph);

    expect(session.messages.map((message) => message.type)).toEqual([
      'assistant',
      'tool_result',
      'assistant',
    ]);
    expect(session.getLastMessage()?.content).toBe('final');
  });

  it('fails tools nodes when a tool call cannot be resolved', async () => {
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
      /assistant\/tools cannot resolve tool lookup/,
    );
  });

  it('fails tools nodes when an allow-list references an unknown tool', async () => {
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
        { id: 'tools', type: 'tools', data: { tools: ['lookup'] } },
      ],
    });

    await expect(executeAgentGraph(graph)).rejects.toThrow(
      /assistant\/tools allows unknown tool lookup/,
    );
  });

  it('executes graph subroutines and merges new messages and vars', async () => {
    const graph = Agent.create('assistant')
      .user('before', 'before')
      .patch('parentVar', (session) => session.withVar('parent', true))
      .subroutine('draft', (sub) =>
        sub
          .user('prompt', 'inside')
          .patch('subVar', (session) => session.withVar('sub', true))
          .assistant('reply', 'ok'),
      )
      .assistant('after', 'after')
      .toGraph();

    const session = await executeAgentGraph(graph);

    expect(session.messages.map((message) => message.content)).toEqual([
      'before',
      'inside',
      'ok',
      'after',
    ]);
    expect(session.getVarsObject()).toEqual({ parent: true, sub: true });
  });

  it('supports isolated graph subroutines without retaining messages', async () => {
    const graph = Agent.create('assistant')
      .user('before', 'before')
      .patch('parentVar', (session) => session.withVar('parent', true))
      .subroutine(
        'draft',
        (sub) =>
          sub
            .user('prompt', 'inside')
            .patch('subVar', (session) => session.withVar('sub', true)),
        { isolatedContext: true, retainMessages: false },
      )
      .assistant('after', 'after')
      .toGraph();

    const session = await executeAgentGraph(graph);

    expect(session.messages.map((message) => message.content)).toEqual([
      'before',
      'after',
    ]);
    expect(session.getVarsObject()).toEqual({ parent: true });
  });

  it('supports custom graph subroutine init and squash handlers', async () => {
    const graph = Agent.create('assistant')
      .patch('parentVar', (session) => session.withVar('parent', 'kept'))
      .subroutine(
        'draft',
        (sub) => sub.patch('subVar', (session) => session.withVar('sub', true)),
        {
          initWith: () => Session.create({ vars: { seed: 'custom' } }),
          squashWith: (parent, subroutine) =>
            parent.withVar('summary', subroutine.getVar('seed')),
        },
      )
      .toGraph();

    const session = await executeAgentGraph(graph);

    expect(session.getVarsObject()).toEqual({
      parent: 'kept',
      summary: 'custom',
    });
  });

  it('squashes graph subroutine sessions when execution suspends', async () => {
    const graph = createAgentGraph({
      name: 'assistant',
      nodes: [
        { id: 'before', type: 'user', data: { content: 'before' } },
        {
          id: 'draft',
          type: 'subroutine',
          data: { isolatedContext: true, retainMessages: false },
          children: [
            { id: 'inbound', type: 'inbox' },
            { id: 'wait', type: 'awaitInput' },
          ],
        },
      ],
    });

    await expect(executeAgentGraph(graph, { input: 'inside' })).rejects.toMatchObject(
      {
        nodePath: 'assistant/draft/wait',
        session: {
          messages: [expect.objectContaining({ content: 'before' })],
        },
      },
    );
  });

  it('executes goal nodes with model and satisfaction checks', async () => {
    const graph = Agent.create('research')
      .goal('researchTopic', 'Research the topic', {
        model: Source.literal('done'),
        isSatisfied: ({ session, goal, attempt }) => {
          expect(goal).toBe('Research the topic');
          expect(attempt).toBe(1);
          return session.getLastMessage()?.content === 'done';
        },
      })
      .toGraph();

    const session = await executeAgentGraph(graph);

    expect(session.messages.map((message) => message.content)).toEqual([
      'Research the topic',
      'done',
    ]);
  });

  it('retries goals until the satisfaction check passes', async () => {
    const graph = Agent.create('research')
      .goal('researchTopic', 'Research the topic', {
        model: ({ messages }) => `attempt:${messages.length}`,
        maxAttempts: 3,
        isSatisfied: ({ attempt }) => attempt === 2,
      })
      .toGraph();

    const session = await executeAgentGraph(graph);

    expect(session.messages.map((message) => message.content)).toEqual([
      'Research the topic',
      'attempt:1',
      'attempt:2',
    ]);
  });

  it('suspends required interactive goals until input is provided', async () => {
    const graph = Agent.create('research')
      .goal('collectQuestion', 'Get the user question', {
        interaction: 'required',
        model: ({ messages }) =>
          messages.some((message) => message.content === 'What is TypeScript?')
            ? 'done'
            : 'question?',
      })
      .toGraph();

    await expect(executeAgentGraph(graph)).rejects.toMatchObject({
      nodePath: 'research/collectQuestion/attempts/interaction',
    });

    const session = await executeAgentGraph(graph, {
      input: 'What is TypeScript?',
    });

    expect(session.messages.map((message) => message.content)).toEqual([
      'Get the user question',
      'question?',
      'What is TypeScript?',
      'done',
    ]);
  });

  it('does not satisfy required interactive goals with control input', async () => {
    const graph = Agent.create('research')
      .goal('collectQuestion', 'Get the user question', {
        interaction: 'required',
        model: Source.literal('question?'),
      })
      .toGraph();

    await expect(
      executeAgentGraph(graph, {
        input: { kind: 'control', content: 'internal signal' },
      }),
    ).rejects.toMatchObject({
      nodePath: 'research/collectQuestion/attempts/interaction',
    });
  });

  it('does not count required interaction prompts against maxAttempts', async () => {
    const graph = Agent.create('research')
      .goal('collectQuestion', 'Get the user question', {
        interaction: 'required',
        maxAttempts: 1,
        model: ({ messages }) =>
          messages.some((message) => message.content === 'What is TypeScript?')
            ? 'done'
            : 'question?',
        isSatisfied: ({ attempt, session }) =>
          attempt === 1 && session.getLastMessage()?.content === 'done',
      })
      .toGraph();

    const session = await executeAgentGraph(graph, {
      input: 'What is TypeScript?',
    });

    expect(session.messages.map((message) => message.content)).toEqual([
      'Get the user question',
      'question?',
      'What is TypeScript?',
      'done',
    ]);
  });

  it('fails retrying goals after maxAttempts is exhausted', async () => {
    const graph = Agent.create('research')
      .goal('researchTopic', 'Research the topic', {
        model: Source.literal('not enough'),
        maxAttempts: 2,
        isSatisfied: () => false,
      })
      .toGraph();

    await expect(executeAgentGraph(graph)).rejects.toThrow(
      /research\/researchTopic exceeded max attempts/,
    );
  });
});
