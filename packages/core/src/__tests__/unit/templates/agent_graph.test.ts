import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { memoryStore } from '../../../durable';
import { createAgentGraphManifest } from '../../../graph';
import { GraphExecutionSuspended } from '../../../graph_executor';
import {
  Hook,
  Middleware,
  type ExecutionRuntimeState,
} from '../../../interceptors';
import { Message } from '../../../message';
import { Session } from '../../../session';
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
          .repeat(
            'toolLoop',
            ({ session }) => session.messages.length > 0,
            (loop) =>
              loop.assistant('reply', Source.literal('ok')).tools('tools'),
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

  it('supports quick ephemeral content-first agents', async () => {
    const session = await Agent.quick()
      .system('You are concise.')
      .user('Hello')
      .assistant('Hi')
      .execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'You are concise.',
      'Hello',
      'Hi',
    ]);
  });

  it('rejects durable execution for quick agents', async () => {
    expect(() => Agent.quick().durable()).toThrow(/Agent\.quick/);
    await expect(Agent.quick().execute({ durable: true })).rejects.toThrow(
      /Agent\.quick/,
    );
  });

  it('rejects durable run metadata that graph execution does not support yet', async () => {
    const store = memoryStore();
    const graph = Agent.create('assistant').assistant('reply', () => 'ok');

    await expect(
      graph.execute({ durable: true, input: 'hello' }),
    ).rejects.toThrow(/option durable/);
    await expect(
      graph.execute({ runId: 'graph-run', input: 'hello' }),
    ).rejects.toThrow(/option runId/);
    await expect(graph.execute({ store, input: 'hello' })).rejects.toThrow(
      /option store/,
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

  it('emits graph execution observer events', async () => {
    const builderEvents: string[] = [];
    const callEvents: string[] = [];
    const session = await Agent.create('assistant')
      .observe((event) => {
        builderEvents.push(
          `${event.seq}:${event.type}:${event.source}:${event.sessionVersion}`,
        );
      })
      .assistant('reply', 'ok')
      .execute({
        observers: [
          (event) => {
            callEvents.push(`${event.seq}:${event.type}`);
          },
        ],
      });

    expect(session.getLastMessage()?.content).toBe('ok');
    expect(builderEvents).toEqual([
      '0:run.started:graph:0',
      '1:run.completed:graph:1',
    ]);
    expect(callEvents).toEqual(['0:run.started', '1:run.completed']);
  });

  it('emits graph suspension observer events', async () => {
    const events: string[] = [];
    const agent = Agent.create('assistant')
      .observe((event) => {
        events.push(`${event.seq}:${event.type}:${event.stepId ?? '-'}`);
      })
      .turn('main', (turn) => turn.awaitInput('next'));

    await expect(agent.execute()).rejects.toThrow(GraphExecutionSuspended);

    expect(events).toEqual([
      '0:run.started:-',
      '1:run.suspended:assistant/main/next',
    ]);
  });

  it('emits graph failure observer events', async () => {
    const events: string[] = [];
    const agent = Agent.create('assistant')
      .observe((event) => {
        const error = event.error as Error | undefined;
        events.push(
          `${event.seq}:${event.type}:${event.sessionVersion}:${error?.message ?? '-'}`,
        );
      })
      .assistant('reply', () => {
        throw new Error('model failed');
      });

    await expect(agent.execute()).rejects.toThrow('model failed');

    expect(events).toEqual([
      '0:run.started:0:-',
      '1:run.failed:0:model failed',
    ]);
  });

  it('runs graph middleware and hooks around agent, model, and tool phases', async () => {
    const calls: string[] = [];
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Look up a value.',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => `value:${id}`,
    });

    const session = await Agent.create('assistant')
      .tool('lookup', lookup)
      .use(
        Middleware.create({
          name: 'graphMiddleware',
          beforeAgent: () => {
            calls.push('beforeAgent');
            return { session: { vars: { beforeAgent: true } } };
          },
          beforeModel: ({ session }) => {
            calls.push(`beforeModel:${String(session.getVar('beforeAgent'))}`);
            return { session: { vars: { beforeModel: true } } };
          },
          prepareModelInput: ({ request }) => {
            calls.push('prepareModelInput');
            const modelRequest = request as { session: Session };
            return {
              request: {
                session: modelRequest.session.addMessage(
                  Message.system('prepared'),
                ),
              },
            };
          },
          wrapModelCall: async (_context, next) => {
            calls.push('wrapModelCall');
            return next();
          },
          afterModel: ({ result }) => {
            calls.push(`afterModel:${String(result)}`);
            return {
              result: {
                content: 'needs lookup',
                toolCalls: [
                  { id: 'call-1', name: 'lookup', arguments: { id: 'one' } },
                ],
              },
            };
          },
          beforeTool: ({ request }) => {
            const call = request as {
              id: string;
              name: string;
              arguments: Record<string, unknown>;
            };
            calls.push(`beforeTool:${call.name}:${String(call.arguments.id)}`);
            return {
              request: {
                ...call,
                arguments: { id: 'two' },
              },
            };
          },
          wrapToolCall: async (_context, next) => {
            calls.push('wrapToolCall');
            return next();
          },
          afterTool: ({ result }) => {
            const message = result as { content: string };
            calls.push(`afterTool:${message.content}`);
            return { result };
          },
          afterAgent: ({ session }) => {
            calls.push('afterAgent');
            return {
              session: {
                vars: { afterAgentMessages: session.messages.length },
              },
            };
          },
        }),
      )
      .hook(
        Hook.create({
          name: 'graphHook',
          onRunStart: () => {
            calls.push('hookStart');
          },
          onRunEnd: () => {
            calls.push('hookEnd');
          },
        }),
      )
      .turn('main', (turn) =>
        turn
          .assistant('reply', (modelSession) => {
            calls.push(
              `handler:${modelSession.getLastMessage()?.content ?? '-'}`,
            );
            return 'raw model';
          })
          .tools('tools'),
      )
      .execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'needs lookup',
      'value:two',
    ]);
    expect(session.getVarsObject()).toMatchObject({
      beforeAgent: true,
      beforeModel: true,
      afterAgentMessages: 2,
    });
    expect(calls).toEqual([
      'beforeAgent',
      'hookStart',
      'beforeModel:true',
      'prepareModelInput',
      'wrapModelCall',
      'handler:prepared',
      'afterModel:raw model',
      'beforeTool:lookup:one',
      'wrapToolCall',
      'afterTool:value:two',
      'afterAgent',
      'hookEnd',
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
    expect(() => Agent.create('assistant').patch((session) => session)).toThrow(
      /patch\(id, handler\)/,
    );
  });

  it('does not silently discard unsupported durable graph execution', async () => {
    const agent = Agent.create('assistant')
      .assistant('reply', Source.literal('ok'))
      .durable();

    await expect(agent.execute({ input: 'hello' })).rejects.toThrow(
      /durable execution yet/,
    );
  });

  it('passes context and signal to graph handlers', async () => {
    const controller = new AbortController();
    const session = await Agent.create('assistant')
      .assistant('reply', (_session, runtime) => {
        expect(runtime?.context?.channel).toBe('docs');
        expect(runtime?.signal).toBe(controller.signal);
        return 'ok';
      })
      .execute({
        context: { channel: 'docs' },
        signal: controller.signal,
      });

    expect(session.getLastMessage()?.content).toBe('ok');
  });

  it('passes context and signal to graph Source inputs', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const source = new (class extends Source<string> {
      async getContent(
        _session: Session,
        runtime?: ExecutionRuntimeState,
      ): Promise<string> {
        seenSignal = runtime?.signal;
        return String(runtime?.context?.channel);
      }
    })();

    const session = await Agent.create('assistant')
      .assistant('reply', source)
      .execute({
        context: { channel: 'docs' },
        signal: controller.signal,
      });

    expect(seenSignal).toBe(controller.signal);
    expect(session.getLastMessage()?.content).toBe('docs');
  });

  it('aborts graph execution before running nodes', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    await expect(
      Agent.create('assistant')
        .assistant('reply', () => 'unreachable')
        .execute({ signal: controller.signal }),
    ).rejects.toThrow(/stop/);
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
    expect(
      manifest.nodes.find((node) => node.path.endsWith('/check'))?.data,
    ).toMatchObject({
      kind: 'goalSatisfaction',
      durability: 'materialized',
    });
  });

  it('compiles named graph subroutines into a stable subgraph', () => {
    const graph = Agent.create('assistant')
      .subroutine('draft', (sub) =>
        sub.user('prompt', 'Draft a reply').assistant('reply', 'ok'),
      )
      .toGraph('v1');
    const manifest = createAgentGraphManifest(graph);

    expect(manifest.nodes.map((node) => [node.path, node.type])).toEqual([
      ['assistant/draft', 'subroutine'],
      ['assistant/draft/prompt', 'user'],
      ['assistant/draft/reply', 'assistant'],
    ]);
  });

  it('uses graph-mode authoring inside named graph subroutines', () => {
    const graph = Agent.create('assistant')
      .subroutine('draft', (sub) => sub.assistant('reply'))
      .toGraph('v1');

    expect(graph.nodes[0]?.children).toEqual([
      {
        id: 'reply',
        type: 'assistant',
        data: undefined,
      },
    ]);
  });

  it('compiles named graph conditionals and loops into stable subgraphs', () => {
    const graph = Agent.create('assistant')
      .conditional(
        'branch',
        ({ session }) => session.getVar('ready') === true,
        (then) => then.assistant('thenReply', 'ready'),
        (otherwise) => otherwise.assistant('elseReply', 'not ready'),
      )
      .loop(
        'retry',
        (body) => body.assistant('tick', 'tick'),
        ({ session }) => session.messages.length < 2,
        { maxIterations: 3 },
      )
      .toGraph('v1');
    const manifest = createAgentGraphManifest(graph);

    expect(manifest.nodes.map((node) => [node.path, node.type])).toEqual([
      ['assistant/branch', 'conditional'],
      ['assistant/branch/then', 'turn'],
      ['assistant/branch/then/thenReply', 'assistant'],
      ['assistant/branch/else', 'turn'],
      ['assistant/branch/else/elseReply', 'assistant'],
      ['assistant/retry', 'loop'],
      ['assistant/retry/tick', 'assistant'],
    ]);
  });

  it('compiles named graph sequences into stable sequential subgraphs', () => {
    const graph = Agent.create('assistant')
      .sequence('draft', (step) =>
        step.user('prompt', 'Draft').assistant('reply', 'ok'),
      )
      .toGraph('v1');
    const manifest = createAgentGraphManifest(graph);

    expect(manifest.nodes.map((node) => [node.path, node.type])).toEqual([
      ['assistant/draft', 'turn'],
      ['assistant/draft/prompt', 'user'],
      ['assistant/draft/reply', 'assistant'],
    ]);
    expect(graph.nodes[0]?.data).toEqual({ kind: 'sequence' });
  });

  it('rejects mixing legacy control-flow after graph authoring starts', () => {
    const graphStarted = () => Agent.create().assistant('reply', () => 'ok');

    expect(() =>
      graphStarted().loop((body) => body.assistant('legacy'), false),
    ).toThrow(/Graph Agent\.loop/);
    expect(() =>
      graphStarted().conditional(
        () => true,
        (then) => then.assistant('legacy'),
      ),
    ).toThrow(/Graph Agent\.conditional/);
    expect(() =>
      graphStarted().subroutine((sub) => sub.assistant('legacy')),
    ).toThrow(/Graph Agent\.subroutine/);
    expect(() =>
      graphStarted().sequence((step) => step.assistant('legacy')),
    ).toThrow(/Graph Agent\.sequence/);
  });

  it('rejects mixing legacy leaf methods after graph authoring starts', () => {
    const graphStarted = () => Agent.create().assistant('reply', () => 'ok');

    expect(() => graphStarted().system('legacy')).toThrow(
      /Graph Agent\.system/,
    );
    expect(() => graphStarted().user('legacy')).toThrow(/Graph Agent\.user/);
    expect(() => graphStarted().assistant()).toThrow(/Graph Agent\.assistant/);
    expect(() => graphStarted().messages(() => [])).toThrow(
      /Graph Agent\.messages/,
    );
    expect(() => graphStarted().patch((session) => session)).toThrow(
      /Graph Agent\.patch/,
    );
    expect(() => graphStarted().transform((session) => session)).toThrow(
      /Graph Agent\.transform/,
    );
    expect(() => graphStarted().add(Agent.create().build())).toThrow(
      /Graph Agent\.add/,
    );
  });
});
