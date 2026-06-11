import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  ClaudeAgentClient,
  ClaudeAgentQueryParams,
} from '../../../claude_agent';
import type {
  CodexAppServerClient,
  CodexSkillListResult,
  CodexThreadStartParams,
  CodexThreadStartResult,
  CodexTurnStartParams,
} from '../../../codex_app_server';
import { PromptTrail, memoryStore } from '../../../durable';
import {
  AgentGraphVersionError,
  createAgentGraphManifest,
} from '../../../graph';
import {
  executeAgentGraph,
  GraphExecutionSuspended,
} from '../../../graph_executor';
import {
  Hook,
  Middleware,
  type ExecutionRuntimeState,
} from '../../../interceptors';
import { Message } from '../../../message';
import { Session } from '../../../session';
import { type ModelOutput, Source } from '../../../source';
import { Agent, Parallel, Structured } from '../../../templates';
import { Tool } from '../../../tool';

class GraphFakeCodexClient implements CodexAppServerClient {
  threadStarts: CodexThreadStartParams[] = [];
  turnStarts: CodexTurnStartParams[] = [];

  async listSkills(): Promise<CodexSkillListResult | unknown[]> {
    return { skills: [] };
  }

  async startThread(
    params: CodexThreadStartParams,
  ): Promise<CodexThreadStartResult> {
    this.threadStarts.push(params);
    return { threadId: 'thread-graph' };
  }

  async startTurn(params: CodexTurnStartParams) {
    this.turnStarts.push(params);
    return {
      threadId: params.threadId,
      turnId: 'turn-graph',
      status: 'completed',
      finalAnswer: 'Codex graph result',
    };
  }
}

class GraphFakeClaudeAgentClient implements ClaudeAgentClient {
  queries: ClaudeAgentQueryParams[] = [];

  async *query(params: ClaudeAgentQueryParams): AsyncIterable<unknown> {
    this.queries.push(params);
    yield {
      type: 'result',
      id: 'result-graph',
      status: 'completed',
      session_id: 'session-graph',
      result: 'Claude graph result',
    };
  }
}

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
      .inbox('inbound')
      .loop(
        'toolLoop',
        (loop) => loop.assistant('reply', Source.literal('ok')).tools('tools'),
        ({ session }) => session.messages.length > 0,
      )
      .awaitInput('next');

    const graph = agent.toGraph('v1');
    const manifest = createAgentGraphManifest(graph);

    expect(graph.name).toBe('assistant');
    expect(Object.keys(graph.tools)).toEqual(['lookup']);
    expect(manifest.nodes.map((node) => [node.path, node.type])).toEqual([
      ['assistant/system', 'system'],
      ['assistant/inbound', 'inbox'],
      ['assistant/toolLoop', 'loop'],
      ['assistant/toolLoop/reply', 'assistant'],
      ['assistant/toolLoop/tools', 'tools'],
      ['assistant/next', 'awaitInput'],
    ]);
  });

  it('requires a named agent before graph compilation', () => {
    expect(() =>
      (Agent.create as unknown as () => Agent)().system('hello').toGraph(),
    ).toThrow(/Agent\.create\(name\)/);
  });

  it('rejects Agent.create without a stable name', () => {
    expect(() => (Agent.create as unknown as () => Agent)()).toThrow(
      /Agent\.create\(name\)/,
    );
  });

  it('requires system graph nodes to include content', () => {
    expect(() => Agent.create('assistant').system('system')).toThrow(
      /Graph Agent\.system/,
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
    expect(() => Agent.quick().checkpoint()).toThrow(/Agent\.quick/);
    await expect(Agent.quick().execute({ checkpoint: true })).rejects.toThrow(
      /Agent\.quick/,
    );
  });

  it('requires a store for direct durable graph execution', async () => {
    const store = memoryStore();
    const graph = Agent.create('assistant').assistant('reply', () => 'ok');

    await expect(
      graph.execute({ checkpoint: true, input: 'hello' }),
    ).rejects.toThrow(/requires checkpoint: store/);
    await expect(
      graph.execute({ runId: 'graph-run', input: 'hello' }),
    ).rejects.toThrow(/requires checkpoint execution/);
    await expect(
      (graph.execute as (options: unknown) => Promise<unknown>)({
        store,
        input: 'hello',
      }),
    ).rejects.toThrow(
      /Agent\.execute option store has been removed. Use checkpoint: store/,
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
      .inbox('inbound')
      .assistant('reply', Source.literal('ok'))
      .execute({ input: 'hello' });

    expect(session.messages.map((message) => message.content)).toEqual([
      'You are concise.',
      'hello',
      'ok',
    ]);
  });

  it('materializes direct graph input when no node consumes the inbox', async () => {
    const session = await Agent.create('assistant')
      .system('system', 'You are concise.')
      .assistant(
        'reply',
        (current) => `reply:${current.getLastMessage()?.content ?? 'none'}`,
      )
      .execute({ input: 'hello' });

    expect(session.messages.map((message) => message.content)).toEqual([
      'You are concise.',
      'hello',
      'reply:hello',
    ]);
  });

  it('materializes direct durable graph input without requiring inbox nodes', async () => {
    const store = memoryStore();
    const session = await Agent.create('assistant')
      .system('system', 'You are concise.')
      .assistant(
        'reply',
        (current) => `reply:${current.getLastMessage()?.content ?? 'none'}`,
      )
      .execute({
        checkpoint: store,
        runId: 'direct-no-inbox',
        input: 'hello',
      });

    expect(session.messages.map((message) => message.content)).toEqual([
      'You are concise.',
      'hello',
      'reply:hello',
    ]);
    expect(store.get('direct-no-inbox')?.inbox).toEqual([
      { offset: 0, kind: 'user', content: 'hello' },
    ]);
    expect(store.get('direct-no-inbox')?.graphCursor).toBe(1);
  });

  it('rejects follow-up input for completed direct durable graph runs', async () => {
    const store = memoryStore();
    const agent = Agent.create('assistant')
      .patch('countRun', (session) =>
        session.withVar(
          'runCount',
          ((session.getVar('runCount') as number) ?? 0) + 1,
        ),
      )
      .assistant('reply', 'done');

    await agent.execute({
      checkpoint: store,
      runId: 'direct-completed',
      input: 'hello',
    });

    await expect(
      agent.execute({
        checkpoint: store,
        runId: 'direct-completed',
        input: 'again',
      }),
    ).rejects.toThrow(/Cannot send input to completed graph run/);
    expect(store.get('direct-completed')?.inbox).toEqual([
      { offset: 0, kind: 'user', content: 'hello' },
    ]);
    expect(store.get('direct-completed')?.result?.getVar('runCount')).toBe(1);
  });

  it('continues completed graph runs without replaying pre-inbox leaf nodes', async () => {
    const store = memoryStore();
    const agent = Agent.create('assistant')
      .assistant('prelude', 'ready')
      .inbox('input')
      .patch('countInput', (session) =>
        session.withVar(
          'inputCount',
          ((session.getVar('inputCount') as number) ?? 0) + 1,
        ),
      )
      .assistant('reply', (session) => {
        return `reply:${session.getLastMessage()?.content ?? 'none'}`;
      });

    const first = await agent.execute({
      checkpoint: store,
      runId: 'direct-completed-continuation',
      input: 'hello',
    });
    const second = await agent.execute({
      checkpoint: store,
      runId: 'direct-completed-continuation',
      input: 'again',
    });

    expect(first.messages.map((message) => message.content)).toEqual([
      'ready',
      'hello',
      'reply:hello',
    ]);
    expect(second.messages.map((message) => message.content)).toEqual([
      'ready',
      'hello',
      'reply:hello',
      'again',
      'reply:again',
    ]);
    expect(second.getVar('inputCount')).toBe(2);
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
      '1:model.started:model:undefined',
      '2:model.completed:model:undefined',
      '3:run.completed:graph:1',
    ]);
    expect(callEvents).toEqual([
      '0:run.started',
      '1:model.started',
      '2:model.completed',
      '3:run.completed',
    ]);
  });

  it('emits graph suspension observer events', async () => {
    const events: string[] = [];
    const agent = Agent.create('assistant')
      .observe((event) => {
        events.push(`${event.seq}:${event.type}:${event.stepId ?? '-'}`);
      })
      .awaitInput('next');

    await expect(agent.execute()).rejects.toThrow(GraphExecutionSuspended);

    expect(events).toEqual([
      '0:run.started:-',
      '1:run.suspended:assistant/next',
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
      '1:model.started:undefined:-',
      '2:model.failed:undefined:model failed',
      '3:run.failed:0:model failed',
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
      .assistant('reply', (modelSession) => {
        calls.push(`handler:${modelSession.getLastMessage()?.content ?? '-'}`);
        return 'raw model';
      })
      .tools('tools')
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

  it('executes graph structured and parallel template nodes', async () => {
    const calls: string[] = [];
    const events: string[] = [];
    const structuredSource = new (class extends Source<ModelOutput> {
      async getContent(session: Session): Promise<ModelOutput> {
        calls.push(`source:${String(session.getVar('beforeModel'))}`);
        return {
          content: 'structured reply',
          structuredOutput: { ok: true },
        };
      }
    })();
    const structured = Structured.withSource(
      structuredSource,
      z.object({ ok: z.boolean() }),
    );
    structured.execute = async () => {
      throw new Error('structured template adapter should not execute');
    };
    const parallelSource = {
      getContent: async (session: Session): Promise<ModelOutput> => {
        calls.push(
          `parallelSource:${session.messages.length}:${String(
            session.getVar('beforeModel'),
          )}`,
        );
        return {
          content: 'parallel reply',
          metadata: { branch: 'parallel' },
          structuredOutput: { parallel: true },
          toolCalls: [{ id: 'p1', name: 'noop', arguments: {} }],
        };
      },
    };
    const parallel = new Parallel().addSource(
      parallelSource as Parameters<Parallel['addSource']>[0],
    );
    parallel.execute = async () => {
      throw new Error('parallel template adapter should not execute');
    };

    const agent = Agent.create('assistant')
      .use(
        Middleware.create({
          name: 'structuredRuntime',
          beforeModel: ({ session }) => {
            calls.push(`beforeModel:${String(session.getVar('beforeAgent'))}`);
            return { session: { vars: { beforeModel: true } } };
          },
          wrapModelCall: async (_context, next) => {
            calls.push('wrapModelCall');
            return next();
          },
          afterModel: ({ result }) => {
            calls.push('afterModel');
            const output = result as ModelOutput;
            return {
              result: {
                ...output,
                content: `${output.content} afterModel`,
              },
            };
          },
        }),
      )
      .observe((event) => {
        events.push(event.type);
      })
      .structured('structuredReply', structured)
      .parallel('parallelReply', parallel);

    const graph = agent.toGraph('v1');
    const manifest = createAgentGraphManifest(graph);
    const session = await agent.execute();

    expect(manifest.nodes.map((node) => [node.path, node.type])).toEqual([
      ['assistant/structuredReply', 'structured'],
      ['assistant/parallelReply', 'parallel'],
    ]);
    expect(session.messages.at(-2)).toMatchObject({
      type: 'assistant',
      content: 'structured reply afterModel',
      structuredContent: { ok: true },
    });
    expect(session.getLastMessage()).toMatchObject({
      type: 'assistant',
      content: 'parallel reply afterModel',
      attrs: { branch: 'parallel' },
      structuredContent: { parallel: true },
      toolCalls: [{ id: 'p1', name: 'noop', arguments: {} }],
    });
    expect(calls).toEqual([
      'beforeModel:undefined',
      'wrapModelCall',
      'source:true',
      'afterModel',
      'beforeModel:undefined',
      'wrapModelCall',
      'parallelSource:1:true',
      'afterModel',
    ]);
    expect(events).toContain('model.started');
    expect(events).toContain('model.completed');
  });

  it('executes empty graph parallel nodes as no-ops without template adapter', async () => {
    const parallel = new Parallel();
    parallel.execute = async () => {
      throw new Error('parallel template adapter should not execute');
    };
    const agent = Agent.create('assistant')
      .assistant('before', 'before')
      .parallel('emptyParallel', parallel)
      .assistant('after', 'after');

    const session = await agent.execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'before',
      'after',
    ]);
  });

  it('executes graph transform template nodes', async () => {
    const session = await Agent.create('assistant')
      .user('input', 'hello')
      .transform('mark', (current) => current.withVar('marked', true))
      .assistant(
        'reply',
        (current) => `marked:${String(current.getVar('marked'))}`,
      )
      .execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'hello',
      'marked:true',
    ]);
    expect(session.getVar('marked')).toBe(true);
  });

  it('compiles graph Codex and Claude turn template nodes', () => {
    const graph = Agent.create('assistant')
      .codex('codex', {} as never)
      .claude('claude', {} as never)
      .toGraph('v1');
    const manifest = createAgentGraphManifest(graph);

    expect(manifest.nodes.map((node) => [node.path, node.type])).toEqual([
      ['assistant/codex', 'codexTurn'],
      ['assistant/claude', 'claudeTurn'],
    ]);
  });

  it('changes the manifest when CodexTurn options change', () => {
    const build = (model = 'gpt-test') =>
      Agent.create('assistant')
        .codex('codex', {
          client: new GraphFakeCodexClient(),
          model,
          cwd: '/workspace',
          sandboxPolicy: { mode: 'workspace-write' },
          threadStart: { effort: 'medium' },
          turnStart: { approval: 'never' },
          onUnresumable: 'restart',
          restartNotice: 'Restart from checkpoint.',
          maxRestarts: 2,
        })
        .toGraph('v1');

    const manifest = createAgentGraphManifest(build());

    expect(manifest.hash).toBe(createAgentGraphManifest(build()).hash);
    expect(manifest.hash).not.toBe(
      createAgentGraphManifest(build('gpt-other')).hash,
    );
  });

  it('changes the manifest when ClaudeTurn options change', () => {
    const build = (model = 'claude-test') =>
      Agent.create('assistant')
        .claude('claude', {
          client: new GraphFakeClaudeAgentClient(),
          model,
          cwd: '/workspace',
          allowedTools: ['Read'],
          disallowedTools: ['Write'],
          permissionMode: 'acceptEdits',
          settingSources: ['project'],
          skills: ['planner'],
          retainMessages: false,
          attrsKey: 'claude',
          onUnresumable: 'restart',
          restartNotice: 'Restart from checkpoint.',
          maxRestarts: 2,
          sdkOptions: { maxTurns: 3 },
        })
        .toGraph('v1');

    const manifest = createAgentGraphManifest(build());

    expect(manifest.hash).toBe(createAgentGraphManifest(build()).hash);
    expect(manifest.hash).not.toBe(
      createAgentGraphManifest(build('claude-other')).hash,
    );
  });

  it('digests secret-bearing config bags instead of persisting plaintext', () => {
    const codexHash = (env: Record<string, string>) =>
      createAgentGraphManifest(
        Agent.create('assistant')
          .codex('codex', {
            client: new GraphFakeCodexClient(),
            transport: {
              kind: 'stdio',
              command: 'codex',
              env,
            },
          })
          .toGraph('v1'),
      );
    const claudeHash = (sdkOptions: Record<string, unknown>) =>
      createAgentGraphManifest(
        Agent.create('assistant')
          .claude('claude', {
            client: new GraphFakeClaudeAgentClient(),
            sdkOptions,
          })
          .toGraph('v1'),
      );

    const codexManifest = codexHash({ OPENAI_API_KEY: 'sk-super-secret' });
    const claudeManifest = claudeHash({ apiKey: 'sk-ant-super-secret' });

    expect(JSON.stringify(codexManifest)).not.toContain('sk-super-secret');
    expect(JSON.stringify(claudeManifest)).not.toContain('sk-ant-super-secret');
    expect(codexManifest.hash).not.toBe(
      codexHash({ OPENAI_API_KEY: 'sk-rotated' }).hash,
    );
    expect(claudeManifest.hash).not.toBe(
      claudeHash({ apiKey: 'sk-ant-rotated' }).hash,
    );
  });

  it('changes the manifest when graph content or structured schemas change', () => {
    const systemHash = (content: string) =>
      createAgentGraphManifest(
        Agent.create('assistant')
          .system('system', content)
          .assistant('reply', 'ok')
          .toGraph('v1'),
      ).hash;
    const structuredHash = (schema: z.ZodType) =>
      createAgentGraphManifest(
        Agent.create('assistant')
          .structured('reply', Structured.withSchema(schema))
          .toGraph('v1'),
      ).hash;

    expect(systemHash('Be concise.')).not.toBe(systemHash('Be detailed.'));
    expect(structuredHash(z.object({ ok: z.boolean() }))).not.toBe(
      structuredHash(z.object({ ok: z.boolean(), reason: z.string() })),
    );
  });

  it('does not detect closure body edits when function names are unchanged', () => {
    const namedHandler = (content: string) =>
      Object.defineProperty(() => content, 'name', {
        value: 'sameHandler',
      }) as () => string;
    const hash = (content: string) =>
      createAgentGraphManifest(
        Agent.create('assistant')
          .assistant('reply', namedHandler(content))
          .toGraph('v1'),
      ).hash;

    expect(hash('old body result')).toBe(hash('new body result'));
  });

  it('does not change the manifest when only provider client instances change', () => {
    const codexHash = (client: GraphFakeCodexClient) =>
      createAgentGraphManifest(
        Agent.create('assistant')
          .codex('codex', { client, model: 'gpt-test' })
          .toGraph('v1'),
      ).hash;
    const claudeHash = (client: GraphFakeClaudeAgentClient) =>
      createAgentGraphManifest(
        Agent.create('assistant')
          .claude('claude', { client, model: 'claude-test' })
          .toGraph('v1'),
      ).hash;

    expect(codexHash(new GraphFakeCodexClient())).toBe(
      codexHash(new GraphFakeCodexClient()),
    );
    expect(claudeHash(new GraphFakeClaudeAgentClient())).toBe(
      claudeHash(new GraphFakeClaudeAgentClient()),
    );
  });

  it('fails app checkpoint resume when a provider option edit changes the manifest', async () => {
    const store = memoryStore();
    const app = PromptTrail.app({ store });
    const runId = 'app-provider-version';

    await app.executeCheckpointRun({
      agent: Agent.create('assistant')
        .codex('codex', {
          client: new GraphFakeCodexClient(),
          model: 'gpt-test',
        })
        .assistant('reply', 'done'),
      runId,
    });

    await expect(
      app.executeCheckpointRun({
        agent: Agent.create('assistant')
          .codex('codex', {
            client: new GraphFakeCodexClient(),
            model: 'gpt-other',
          })
          .assistant('reply', 'done'),
        runId,
      }),
    ).rejects.toThrow(AgentGraphVersionError);
  });

  it('executes graph Codex and Claude turn nodes without template adapter entrypoints', async () => {
    const codexClient = new GraphFakeCodexClient();
    const claudeClient = new GraphFakeClaudeAgentClient();
    const graph = Agent.create('assistant')
      .user('prompt', 'Review this')
      .codex('codex', { client: codexClient })
      .claude('claude', { client: claudeClient })
      .toGraph('v1');

    for (const node of graph.nodes) {
      if (node.type === 'codexTurn' || node.type === 'claudeTurn') {
        const template = (node.data as { template?: { execute?: unknown } })
          .template;
        if (template) {
          template.execute = async () => {
            throw new Error('turn template adapter should not execute');
          };
        }
      }
    }

    const session = await executeAgentGraph(graph);

    expect(session.messages.map((message) => message.content)).toEqual([
      'Review this',
      'Codex graph result',
      'Claude graph result',
    ]);
    expect(codexClient.turnStarts[0]).toMatchObject({
      threadId: 'thread-graph',
      input: [{ type: 'text', text: 'Review this' }],
    });
    expect(claudeClient.queries[0]).toMatchObject({
      prompt: 'Codex graph result',
    });
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

  it('executes direct durable graph agents through the app runtime', async () => {
    const store = memoryStore();
    const agent = Agent.create('assistant')
      .inbox('inbound')
      .assistant('reply', Source.literal('ok'))
      .checkpoint({ store });

    const session = await agent.execute({
      input: 'hello',
      runId: 'direct-graph',
    });
    const run = store.get('direct-graph');

    expect(session.messages.map((message) => message.content)).toEqual([
      'hello',
      'ok',
    ]);
    expect(run?.agentName).toBe('assistant');
    expect(run?.graphManifest?.name).toBe('assistant');
    expect(run?.graphManifest?.hash).toBe(
      createAgentGraphManifest(agent.toGraph()).hash,
    );
  });

  it('memoizes graph checkpoint tool activity and nested once effects', async () => {
    const store = memoryStore();
    let memoCalls = 0;
    let toolCalls = 0;
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Look up a value.',
      inputSchema: z.object({ id: z.string() }),
      activity: { kind: 'external-read' },
      execute: async ({ id }, context) => {
        toolCalls++;
        const memo = await context.durable?.once(
          'stable-value',
          id,
          () => {
            memoCalls++;
            return `memo:${id}:${memoCalls}`;
          },
          { scope: 'run' },
        );
        return `${memo}:${context.activity?.kind ?? 'none'}`;
      },
    });
    const agent = Agent.create('assistant')
      .tool('lookup', lookup)
      .assistant('reply', () => ({
        content: 'need lookup',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { id: 'one' } }],
      }))
      .tools('tools')
      .checkpoint({ store });

    const session = await agent.execute({
      runId: 'direct-graph-tool-effects',
    });
    const run = store.get('direct-graph-tool-effects');

    expect(session.messages.map((message) => message.content)).toEqual([
      'need lookup',
      'memo:one:1:external-read',
    ]);
    expect(toolCalls).toBe(1);
    expect(memoCalls).toBe(1);
    expect(run?.once.run.size).toBe(2);
  });

  it('resumes direct durable graph agents from suspended input nodes', async () => {
    const store = memoryStore();
    const agent = Agent.create('assistant')
      .inbox('first')
      .awaitInput('next')
      .assistant('reply', (session) => {
        const last = session.getLastMessage()?.content ?? '';
        return `reply:${last}`;
      })
      .checkpoint({ store });

    const suspended = await agent.execute({
      input: 'hello',
      runId: 'direct-resume',
    });
    const resumed = await agent.execute({
      input: 'again',
      runId: 'direct-resume',
    });

    expect(suspended.messages.map((message) => message.content)).toEqual([
      'hello',
    ]);
    expect(resumed.messages.map((message) => message.content)).toEqual([
      'hello',
      'again',
      'reply:again',
    ]);
  });

  it('resumes direct durable graph loops from suspended input nodes', async () => {
    const store = memoryStore();
    const agent = Agent.create('assistant')
      .inbox('first')
      .loop(
        'waitLoop',
        (loop) =>
          loop
            .patch('count', (session) =>
              session.withVar(
                'count',
                ((session.getVar('count') as number) ?? 0) + 1,
              ),
            )
            .awaitInput('next')
            .assistant(
              'reply',
              (session) => `reply:${session.getLastMessage()?.content ?? ''}`,
            ),
        ({ session }) => ((session.getVar('count') as number) ?? 0) < 1,
      )
      .assistant('done', (session) => `done:${String(session.getVar('count'))}`)
      .checkpoint({ store });

    const suspended = await agent.execute({
      input: 'hello',
      runId: 'direct-loop-resume',
    });
    const resumed = await agent.execute({
      input: 'again',
      runId: 'direct-loop-resume',
    });

    expect(suspended.messages.map((message) => message.content)).toEqual([
      'hello',
    ]);
    expect(suspended.getVar('count')).toBe(1);
    expect(resumed.messages.map((message) => message.content)).toEqual([
      'hello',
      'again',
      'reply:again',
      'done:1',
    ]);
    expect(resumed.getVar('count')).toBe(1);
  });

  it('clears graph resume targets after consuming resumed input in nested loops', async () => {
    const store = memoryStore();
    const agent = Agent.create('assistant')
      .inbox('first')
      .loop(
        'outer',
        (outer) =>
          outer
            .patch('count', (session) =>
              session.withVar(
                'count',
                ((session.getVar('count') as number) ?? 0) + 1,
              ),
            )
            .loop(
              'inner',
              (inner) =>
                inner
                  .awaitInput('next')
                  .patch('inputDone', (session) =>
                    session.withVar('needInput', false),
                  ),
              ({ session }) => session.getVar('needInput') !== false,
            )
            .assistant(
              'reply',
              (session) => `outer:${String(session.getVar('count'))}`,
            ),
        ({ session }) => ((session.getVar('count') as number) ?? 0) < 2,
      )
      .checkpoint({ store });

    const suspended = await agent.execute({
      input: 'hello',
      runId: 'direct-nested-loop-resume',
    });
    const resumed = await agent.execute({
      input: 'again',
      runId: 'direct-nested-loop-resume',
    });

    expect(suspended.messages.map((message) => message.content)).toEqual([
      'hello',
    ]);
    expect(suspended.getVar('count')).toBe(1);
    expect(resumed.messages.map((message) => message.content)).toEqual([
      'hello',
      'again',
      'outer:1',
      'outer:2',
    ]);
    expect(resumed.getVar('count')).toBe(2);
    expect(resumed.getVar('needInput')).toBe(false);
  });

  it('fails direct durable graph resume when the graph manifest changes', async () => {
    const store = memoryStore();

    await Agent.create('assistant')
      .assistant('reply', Source.literal('ok'))
      .execute({ checkpoint: store, runId: 'graph-version' });

    const changed = Agent.create('assistant')
      .system('system', 'Changed.')
      .assistant('reply', Source.literal('ok'));

    await expect(
      changed.execute({ checkpoint: store, runId: 'graph-version' }),
    ).rejects.toThrow(AgentGraphVersionError);
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
    const checkData = manifest.nodes.find((node) =>
      node.path.endsWith('/check'),
    )?.data;
    expect(checkData).toMatchObject({ kind: 'goalSatisfaction' });
    expect(checkData).not.toHaveProperty('durability');
  });

  it('compiles named graph subroutines into a stable subgraph', () => {
    const graph = Agent.create('assistant')
      .subroutine('draft', (sub) =>
        sub.user('prompt', 'Draft a reply').assistant('reply', 'ok'),
      )
      .toGraph('v1');
    const manifest = createAgentGraphManifest(graph);

    expect(manifest.nodes.map((node) => [node.path, node.type])).toEqual([
      ['assistant/draft', 'scope'],
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
      ['assistant/branch/thenReply', 'assistant'],
      ['assistant/branch/elseReply', 'assistant'],
      ['assistant/retry', 'loop'],
      ['assistant/retry/tick', 'assistant'],
    ]);
  });

  it('compiles implicit graph sequences into stable sequential nodes', () => {
    const graph = Agent.create('assistant')
      .user('prompt', 'Draft')
      .assistant('reply', 'ok')
      .toGraph('v1');
    const manifest = createAgentGraphManifest(graph);

    expect(manifest.nodes.map((node) => [node.path, node.type])).toEqual([
      ['assistant/prompt', 'user'],
      ['assistant/reply', 'assistant'],
    ]);
    expect(graph.nodes[0]?.id).toBe('prompt');
  });

  it('rejects mixing legacy control-flow after graph authoring starts', () => {
    const graphStarted = () => Agent.quick().assistant('reply', () => 'ok');

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
  });

  it('rejects mixing legacy leaf methods after graph authoring starts', () => {
    const graphStarted = () => Agent.quick().assistant('reply', () => 'ok');

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
    expect(() =>
      graphStarted().structured(Structured.withSchema(z.object({}))),
    ).toThrow(/Graph Agent\.structured/);
    expect(() => graphStarted().parallel(new Parallel())).toThrow(
      /Graph Agent\.parallel/,
    );
    expect(() => graphStarted().codex({} as never)).toThrow(
      /Graph Agent\.codex/,
    );
    expect(() => graphStarted().claude({} as never)).toThrow(
      /Graph Agent\.claude/,
    );
    expect(() => graphStarted().transform((session) => session)).toThrow(
      /Graph Agent\.transform/,
    );
    expect(() => graphStarted().add(Agent.quick().build())).toThrow(
      /Graph Agent\.add/,
    );
  });
});

describe('Legacy agent compilation through GraphExecutor', () => {
  it('executes a legacy system/user/assistant sequence via graph', async () => {
    const session = await Agent.quick()
      .system('You are concise.')
      .user('Hello')
      .assistant('Hi there')
      .execute();

    expect(session.messages.map((m) => [m.type, m.content])).toEqual([
      ['system', 'You are concise.'],
      ['user', 'Hello'],
      ['assistant', 'Hi there'],
    ]);
  });

  it('executes a legacy assistant with a Source-based content source', async () => {
    const session = await Agent.quick()
      .user('ping')
      .assistant(Source.literal('pong'))
      .execute();

    expect(session.getLastMessage()?.content).toBe('pong');
  });

  it('executes a legacy loop that warns on max-iterations instead of throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const session = await Agent.quick()
        .loop(
          (body) => body.user('tick'),
          () => true, // never-ending condition
          { maxIterations: 3 },
        )
        .execute();

      // Legacy behaviour: warn and stop at max rather than throwing
      expect(session.messages.length).toBeGreaterThanOrEqual(3);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('maximum iterations'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('executes a legacy loop without a condition as a one-shot sequence with a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const session = await Agent.quick()
        .loop((body) => body.user('once'))
        .execute();

      expect(session.messages.map((m) => m.content)).toEqual(['once']);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('loop condition'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('fires beforeTemplate and afterTemplate hooks around each legacy child', async () => {
    const calls: string[] = [];

    const session = await Agent.quick()
      .hook(
        Hook.create({
          name: 'lifecycleHook',
          onBeforeTemplate: ({ request }) => {
            const req = request as {
              templateIndex: number;
              templateName: string;
            };
            calls.push(`before:${req.templateIndex}:${req.templateName}`);
          },
          onAfterTemplate: ({ request }) => {
            const req = request as {
              templateIndex: number;
              templateName: string;
            };
            calls.push(`after:${req.templateIndex}:${req.templateName}`);
          },
        }),
      )
      .user('first')
      .assistant('second')
      .execute();

    expect(session.messages.map((m) => m.content)).toEqual(['first', 'second']);
    // Two children at index 0 and 1; template names match class names
    expect(calls).toEqual([
      'before:0:User',
      'after:0:User',
      'before:1:Assistant',
      'after:1:Assistant',
    ]);
  });

  it('halts sibling execution when beforeTemplate hook returns halt', async () => {
    const session = await Agent.quick()
      .hook(
        Hook.create({
          name: 'haltHook',
          onBeforeTemplate: ({ request }) => {
            const req = request as { templateIndex: number };
            if (req.templateIndex === 1) {
              return { command: { type: 'halt' as const } };
            }
          },
        }),
      )
      .user('first')
      .user('second') // should be skipped
      .user('third') // should be skipped
      .execute();

    // Only the first user message should be added
    expect(session.messages.map((m) => m.content)).toEqual(['first']);
  });

  it('fires beforeTemplate and afterTemplate inside a legacy loop body', async () => {
    const calls: string[] = [];
    let iterations = 0;

    await Agent.quick()
      .hook(
        Hook.create({
          name: 'loopLifecycleHook',
          onBeforeTemplate: ({ request }) => {
            const req = request as {
              templateIndex: number;
              templateName: string;
            };
            calls.push(`before:${req.templateIndex}:${req.templateName}`);
          },
          onAfterTemplate: ({ request }) => {
            const req = request as {
              templateIndex: number;
              templateName: string;
            };
            calls.push(`after:${req.templateIndex}:${req.templateName}`);
          },
        }),
      )
      .loop(
        (body) => body.user('tick'),
        () => iterations++ < 2,
      )
      .execute();

    // Loop body builder wraps children in a Sequence (body template), so the
    // graph hierarchy is: Loop → Sequence → User.  Each level gets lifecycle
    // events.  Root fires before/after for the Loop node (index 0).  Each
    // iteration fires before/after for the Sequence (index 0) and User
    // (index 0) inside it.
    expect(calls).toEqual([
      'before:0:Loop',
      'before:0:Sequence',
      'before:0:User',
      'after:0:User',
      'after:0:Sequence', // iter 1
      'before:0:Sequence',
      'before:0:User',
      'after:0:User',
      'after:0:Sequence', // iter 2
      'after:0:Loop',
    ]);
  });

  it('executes a legacy conditional through the graph compiler', async () => {
    const runAgent = async (condition: boolean) => {
      const session = await Agent.quick()
        .user('setup')
        .conditional(
          () => condition,
          (then) => then.assistant('yes'),
          (otherwise) => otherwise.assistant('no'),
        )
        .execute();
      return session.messages.map((m) => m.content);
    };

    expect(await runAgent(true)).toEqual(['setup', 'yes']);
    expect(await runAgent(false)).toEqual(['setup', 'no']);
  });

  it('passes middleware runtime through nested legacy agents', async () => {
    const modelCalls: string[] = [];

    const session = await Agent.quick()
      .use(
        Middleware.create({
          name: 'trackMiddleware',
          beforeModel: () => {
            modelCalls.push('beforeModel');
            return { session: { vars: { fromMiddleware: true } } };
          },
        }),
      )
      .assistant(Source.literal('ok'))
      .execute();

    // The middleware's beforeModel fires and injects the var; the assistant
    // executes correctly through the legacy compilation graph path.
    expect(session.getLastMessage()?.content).toBe('ok');
    expect(modelCalls).toEqual(['beforeModel']);
    expect(session.getVar('fromMiddleware')).toBe(true);
  });

  it('executes a legacy subroutine with isolated context through the graph compiler', async () => {
    const session = await Agent.quick()
      .user('outer')
      .subroutine((sub) =>
        sub
          .transform((s) => s.withVar('inSub', true))
          .assistant(Source.literal('sub-result')),
      )
      .execute();

    // Subroutine messages are appended to the parent session by default
    expect(session.messages.map((m) => m.content)).toContain('sub-result');
  });
});
