import { describe, expect, it } from 'vitest';
import { DELETE_VALUE, type ObserverDeliveryBinding } from '../../../execution';
import { Hook, Middleware } from '../../../interceptors';
import { Message } from '../../../message';
import type { Session } from '../../../session';
import { Source } from '../../../source';
import { Agent } from '../../../templates';
import { memoryStore } from '../../../durable';

describe('Agent interceptors', () => {
  it('runs beforeAgent and afterAgent middleware and hooks', async () => {
    const agent = Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'middleware',
          beforeAgent: () => ({
            session: {
              vars: { beforeMiddleware: true },
              middlewareState: {
                token: 'kept',
              },
            },
          }),
          afterAgent: ({ session, middlewareState }) => ({
            session: {
              vars: {
                messageCount: session.messages.length,
                token: middlewareState.token,
              },
            },
          }),
        }),
      )
      .hook(
        Hook.create({
          name: 'hook',
          onBeforeAgent: ({ session }) => ({
            session: session.addMessage(Message.system('hooked')),
          }),
          onAfterAgent: () => ({
            session: {
              vars: { afterHook: true },
            },
          }),
        }),
      )
      .user('hello');

    const session = await agent.execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'hooked',
      'hello',
    ]);
    expect(session.getVarsObject()).toEqual({
      beforeMiddleware: true,
      messageCount: 2,
      token: 'kept',
      afterHook: true,
    });
  });

  it('runs onRunStart and onRunEnd hook aliases', async () => {
    const session = await Agent.create('agent-interceptors')
      .hook(
        Hook.create({
          name: 'runLifecycle',
          onRunStart: () => ({
            session: { vars: { started: true } },
          }),
          onRunEnd: ({ session }) => ({
            session: {
              vars: {
                endedWithMessages: session.messages.length,
              },
            },
          }),
        }),
      )
      .user('hello')
      .execute();

    expect(session.getVarsObject()).toEqual({
      started: true,
      endedWithMessages: 1,
    });
  });

  it('runs beforeTemplate and afterTemplate hooks around child templates', async () => {
    const session = await Agent.create('agent-interceptors')
      .hook(
        Hook.create({
          name: 'templateLifecycle',
          onBeforeTemplate: ({ session, request }) => {
            const vars = session.getVarsObject();
            const template = request as { templateName?: string };
            return {
              session: {
                vars: {
                  beforeTemplates: [
                    ...((vars.beforeTemplates as string[] | undefined) ?? []),
                    template.templateName,
                  ],
                },
              },
            };
          },
          onAfterTemplate: ({ session, request }) => {
            const vars = session.getVarsObject();
            const template = request as { templateName?: string };
            return {
              session: {
                vars: {
                  afterTemplates: [
                    ...((vars.afterTemplates as string[] | undefined) ?? []),
                    template.templateName,
                  ],
                },
              },
            };
          },
        }),
      )
      .user('hello')
      .assistant('reply')
      .execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'hello',
      'reply',
    ]);
    expect(session.getVarsObject()).toEqual({
      beforeTemplates: ['User', 'Assistant'],
      afterTemplates: ['User', 'Assistant'],
    });
  });

  it('halts remaining child templates from template lifecycle hooks', async () => {
    const session = await Agent.create('agent-interceptors')
      .hook(
        Hook.create({
          name: 'templateControl',
          onAfterTemplate: () => ({
            session: { vars: { haltedAfterTemplate: true } },
            command: { type: 'halt' },
          }),
        }),
      )
      .user('hello')
      .assistant('should not run')
      .execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'hello',
    ]);
    expect(session.getVarsObject()).toEqual({ haltedAfterTemplate: true });
  });

  it('applies subroutine squash after template lifecycle halt', async () => {
    const session = await Agent.create('agent-interceptors')
      .hook(
        Hook.create({
          name: 'subroutineLifecycle',
          onAfterTemplate: ({ request }) => {
            const template = request as { templateName?: string };
            if (template.templateName !== 'User') {
              return undefined;
            }
            return {
              session: { vars: { innerHalted: true } },
              command: { type: 'halt' },
            };
          },
        }),
      )
      .subroutine((agent) => agent.user('hidden').assistant('should not run'), {
        squash: (parent, subroutine) =>
          parent.withVars(subroutine.getVarsObject()),
      })
      .assistant('outer')
      .execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'outer',
    ]);
    expect(session.getVarsObject()).toEqual({ innerHalted: true });
  });

  it('rejects ambiguous run lifecycle hook aliases', () => {
    expect(() =>
      Hook.create({
        name: 'ambiguousStart',
        onRunStart: () => undefined,
        onBeforeAgent: () => undefined,
      }),
    ).toThrow(
      'Hook ambiguousStart cannot define both onRunStart and onBeforeAgent.',
    );
    expect(() =>
      Hook.create({
        name: 'ambiguousEnd',
        onRunEnd: () => undefined,
        onAfterAgent: () => undefined,
      }),
    ).toThrow(
      'Hook ambiguousEnd cannot define both onRunEnd and onAfterAgent.',
    );
  });

  it('rejects ambiguous raw hook definitions during execution', async () => {
    await expect(
      Agent.create('agent-interceptors')
        .hook({
          name: 'rawAmbiguousStart',
          onRunStart: () => undefined,
          onBeforeAgent: () => undefined,
        })
        .user('hello')
        .execute(),
    ).rejects.toThrow(
      'Hook rawAmbiguousStart cannot define both onRunStart and onBeforeAgent.',
    );
  });

  it('emits direct execution observer events', async () => {
    const events: string[] = [];
    const eventKeys: string[] = [];
    const session = await Agent.create('agent-interceptors')
      .observe((event) => {
        eventKeys.push(String(event.idempotencyKey));
        events.push(
          `${event.seq}:${event.type}:${event.source}:${event.sessionVersion}:${event.idempotencyKey}`,
        );
      })
      .user('hello')
      .execute();

    expect(session.getLastMessage()?.content).toBe('hello');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(
      /^0:run\.started:graph:0:graph-agent:.+:agent:0:run\.started$/,
    );
    expect(events[1]).toMatch(
      /^1:run\.completed:graph:1:graph-agent:.+:agent:1:run\.completed$/,
    );
    expect(eventKeys[0]?.split(':').slice(0, 2).join(':')).toBe(
      eventKeys[1]?.split(':').slice(0, 2).join(':'),
    );
  });

  it('accepts per-call observers in direct execution options', async () => {
    const events: string[] = [];
    const session = await Agent.create('agent-interceptors')
      .user('hello')
      .execute({
        observers: [
          (event) => {
            events.push(`${event.seq}:${event.type}`);
          },
        ],
      });

    expect(session.getLastMessage()?.content).toBe('hello');
    expect(events).toEqual(['0:run.started', '1:run.completed']);
  });

  it('merges builder and per-call observers in direct execution', async () => {
    const builderEvents: string[] = [];
    const callEvents: string[] = [];
    await Agent.create('agent-interceptors')
      .observe((event) => {
        builderEvents.push(event.type);
      })
      .user('hello')
      .execute({
        observers: [
          (event) => {
            callEvents.push(event.type);
          },
        ],
      });

    expect(builderEvents).toEqual(['run.started', 'run.completed']);
    expect(callEvents).toEqual(['run.started', 'run.completed']);
  });

  it('scopes direct execution observer event keys per execute call', async () => {
    const keys: string[] = [];
    const agent = Agent.create('agent-interceptors')
      .observe((event) => {
        keys.push(String(event.idempotencyKey));
      })
      .user('hello');

    await agent.execute();
    await agent.execute();

    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
  });

  it('threads observer delivery binding options into direct execution observers', async () => {
    const claimed: string[] = [];
    const completed: string[] = [];
    const session = await Agent.create('agent-interceptors')
      .observe({
        name: 'writer',
        async handle(event, context) {
          await context.deliveryBindings?.checkWrite(
            event.idempotencyKey ?? event.id,
            () => `sent:${event.type}`,
          );
        },
      })
      .user('hello')
      .execute({
        observerDeliveryBindings: {
          deliveryBindingStore: {
            claim(idempotencyKey) {
              claimed.push(idempotencyKey);
              return true;
            },
            complete(idempotencyKey, binding: ObserverDeliveryBinding) {
              completed.push(`${idempotencyKey}:${binding.value}`);
            },
            delete() {},
          },
        },
      });

    expect(session.getLastMessage()?.content).toBe('hello');
    expect(claimed).toHaveLength(2);
    expect(completed).toHaveLength(2);
    expect(claimed[0]).toContain('writer');
    expect(completed[0]).toContain('sent:run.started');
  });

  it('can surface direct execution observer failures in strict mode', async () => {
    const agent = Agent.create('agent-interceptors')
      .observe({
        name: 'failing',
        handle(event) {
          if (event.type === 'run.started') {
            throw new Error('observer broke');
          }
        },
      })
      .user('hello');

    await expect(agent.execute({ strictObservers: true })).rejects.toThrow(
      'observer broke',
    );
  });

  it('threads direct execution context into middleware', async () => {
    const session = await Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'context',
          beforeModel: ({ context }) => ({
            session: {
              vars: {
                channel: context?.channel,
              },
            },
          }),
        }),
      )
      .assistant('reply')
      .execute({ context: { channel: 'claw-test' } });

    expect(session.getVarsObject()).toEqual({ channel: 'claw-test' });
  });

  it('threads direct execution context into nested agents', async () => {
    const session = await Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'nestedContext',
          beforeModel: ({ context }) => ({
            session: {
              vars: {
                userId: context?.userId,
              },
            },
          }),
        }),
      )
      .assistant('reply')
      .execute({ context: { userId: 'U1' } });

    expect(session.getVarsObject()).toEqual({ userId: 'U1' });
  });

  it('journals direct durable Agent.execute results by runId', async () => {
    const store = memoryStore();
    const eventKeys: string[] = [];
    let calls = 0;
    const source = Source.callback(async () => {
      calls++;
      return `reply:${calls}`;
    });
    const agent = Agent.create('direct-agent-run')
      .observe((event) => {
        eventKeys.push(String(event.idempotencyKey));
      })
      .assistant('reply', source);

    const first = await agent.execute({
      checkpoint: { store },
      runId: 'direct-agent-run',
    });
    const second = await agent.execute({
      checkpoint: { store },
      runId: 'direct-agent-run',
    });

    expect(first.getLastMessage()?.content).toBe('reply:1');
    expect(second.getLastMessage()?.content).toBe('reply:1');
    expect(calls).toBe(1);
    expect(eventKeys).toEqual([
      'direct-agent-run:agent:0:run.started',
      'direct-agent-run:model:1:model.started',
      'direct-agent-run:model:2:model.completed',
      'direct-agent-run:agent:3:run.completed',
    ]);
  });

  it('accepts top-level runId and checkpoint store shorthand', async () => {
    const store = memoryStore();
    let calls = 0;
    const source = Source.callback(async () => {
      calls++;
      return `reply:${calls}`;
    });
    const agent = Agent.create('direct-agent-top-level-options').assistant(
      'reply',
      source,
    );

    const first = await agent.execute({
      checkpoint: store,
      runId: 'direct-agent-top-level-options',
    });
    const second = await agent.execute({
      checkpoint: store,
      runId: 'direct-agent-top-level-options',
    });

    expect(first.getLastMessage()?.content).toBe('reply:1');
    expect(second.getLastMessage()?.content).toBe('reply:1');
    expect(calls).toBe(1);
  });

  it('threads per-call observers through direct durable execution', async () => {
    const store = memoryStore();
    const events: string[] = [];
    await Agent.create('direct-agent-durable-call-observers')
      .user('message', 'hello')
      .execute({
        checkpoint: store,
        runId: 'direct-agent-durable-call-observers',
        observers: [
          (event) => {
            events.push(`${event.seq}:${event.type}`);
          },
        ],
      });

    expect(events).toEqual(['0:run.started', '1:run.completed']);
  });

  it('uses fluent durable defaults for direct Agent.execute', async () => {
    const store = memoryStore();
    let calls = 0;
    const source = Source.callback(async () => {
      calls++;
      return `fluent:${calls}`;
    });
    const agent = Agent.create('fluent-direct-agent')
      .checkpoint({ store })
      .assistant('reply', source);

    await agent.execute();
    const replayed = await agent.execute();

    expect(replayed.getLastMessage()?.content).toBe('fluent:1');
    expect(calls).toBe(1);
  });

  it('lets direct execution options set checkpoint run identity', async () => {
    const store = memoryStore();
    let calls = 0;
    const source = Source.callback(async () => {
      calls++;
      return `override:${calls}`;
    });
    const agent = Agent.create('disabled-fluent-direct-agent')
      .checkpoint({ store })
      .assistant('reply', source);

    await agent.execute({
      checkpoint: store,
      runId: 'direct-agent-checkpoint-run',
    });
    const replayed = await agent.execute({
      checkpoint: store,
      runId: 'direct-agent-checkpoint-run',
    });

    expect(replayed.getLastMessage()?.content).toBe('override:1');
    expect(calls).toBe(1);
  });

  it('emits session.patched events for materialized phase patches', async () => {
    const events: Array<{
      seq: number;
      type: string;
      phase: string;
      key: string | undefined;
    }> = [];
    const session = await Agent.create('agent-interceptors')
      .observe((event) => {
        events.push({
          seq: event.seq,
          type: event.type,
          phase: event.phase ?? '-',
          key: event.idempotencyKey,
        });
      })
      .use(
        Middleware.create({
          name: 'patchEvents',
          beforeAgent: () => ({
            session: {
              vars: { before: true },
            },
          }),
          afterModel: () => ({
            session: {
              vars: { afterModel: true },
            },
          }),
        }),
      )
      .assistant('hello')
      .execute();

    expect(session.getVarsObject()).toEqual({
      before: true,
      afterModel: true,
    });
    const runScope = events[0].key?.replace(':agent:0:run.started', '');
    expect(events).toEqual([
      {
        seq: 0,
        type: 'run.started',
        phase: '-',
        key: `${runScope}:agent:0:run.started`,
      },
      {
        seq: 1,
        type: 'session.patched',
        phase: 'beforeAgent',
        key: `${runScope}:phase:1:session.patched:beforeAgent:middleware:0:patchEvents`,
      },
      {
        seq: 2,
        type: 'model.started',
        phase: 'model',
        key: `${runScope}:model:2:model.started`,
      },
      {
        seq: 3,
        type: 'model.completed',
        phase: 'model',
        key: `${runScope}:model:3:model.completed`,
      },
      {
        seq: 4,
        type: 'session.patched',
        phase: 'afterModel',
        key: `${runScope}:phase:4:session.patched:afterModel:middleware:0:patchEvents`,
      },
      {
        seq: 5,
        type: 'run.completed',
        phase: '-',
        key: `${runScope}:agent:5:run.completed`,
      },
    ]);
  });

  it('emits chained agent events to observers under a runtime', async () => {
    const parentEvents: string[] = [];
    const childEvents: string[] = [];

    const session = await Agent.create('agent-interceptors')
      .observe((event) => {
        parentEvents.push(`${event.seq}:${event.type}`);
      })
      .observe((event) => {
        childEvents.push(`${event.seq}:${event.type}`);
      })
      .user('nested hello')
      .execute();

    expect(session.getLastMessage()?.content).toBe('nested hello');
    expect(parentEvents).toEqual(['0:run.started', '1:run.completed']);
    expect(childEvents).toEqual(['0:run.started', '1:run.completed']);
  });

  it('rejects unsupported direct execution commands', async () => {
    const agent = Agent.create('agent-interceptors').hook(
      Hook.create({
        name: 'control',
        onBeforeAgent: () => ({
          command: { type: 'suspend', reason: 'manual' },
        }),
      }),
    );

    await expect(agent.execute()).rejects.toThrow(
      'Agent.execute does not support execution command suspend yet.',
    );
  });

  it('halts direct execution from beforeAgent commands', async () => {
    const events: string[] = [];
    const agent = Agent.create('agent-interceptors')
      .observe((event) => {
        events.push(`${event.seq}:${event.type}`);
      })
      .hook(
        Hook.create({
          name: 'control',
          onBeforeAgent: () => ({
            session: { vars: { halted: true } },
            command: { type: 'halt', reason: 'manual' },
          }),
        }),
      )
      .assistant('should not run');

    const session = await agent.execute();

    expect(session.messages).toEqual([]);
    expect(session.getVarsObject()).toEqual({ halted: true });
    expect(events).toEqual([
      '0:run.started',
      '1:session.patched',
      '2:run.completed',
    ]);
  });

  it('halts direct execution from afterAgent commands', async () => {
    const events: string[] = [];
    const agent = Agent.create('agent-interceptors')
      .observe((event) => {
        events.push(`${event.seq}:${event.type}`);
      })
      .assistant('reply')
      .hook(
        Hook.create({
          name: 'control',
          onAfterAgent: () => ({
            session: { vars: { haltedAfter: true } },
            command: { type: 'halt', reason: 'manual' },
          }),
        }),
      );

    const session = await agent.execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'reply',
    ]);
    expect(session.getVarsObject()).toEqual({ haltedAfter: true });
    expect(events).toEqual([
      '0:run.started',
      '1:model.started',
      '2:model.completed',
      '3:session.patched',
      '4:run.completed',
    ]);
  });

  it('applies beforeModel and afterModel middleware around assistant output', async () => {
    const session = await Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'modelPolicy',
          beforeModel: ({ session }) => ({
            session: session.addMessage(Message.system('before model')),
          }),
          afterModel: () => ({
            result: { content: 'rewritten' },
            session: {
              vars: { afterModel: true },
            },
          }),
        }),
      )
      .assistant('original')
      .execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'before model',
      'rewritten',
    ]);
    expect(session.getVarsObject()).toEqual({ afterModel: true });
  });

  it('preserves interceptors in implicit sequence order', async () => {
    const session = await Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'nested',
          beforeAgent: () => ({
            session: {
              vars: { nestedMiddleware: true },
            },
          }),
        }),
      )
      .user('nested hello')
      .execute();

    expect(session.getVarsObject()).toEqual({ nestedMiddleware: true });
    expect(session.getLastMessage()?.content).toBe('nested hello');
  });

  it('passes parent model middleware into nested assistants', async () => {
    const session = await Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'parentModelPolicy',
          afterModel: () => ({
            result: { content: 'parent rewritten' },
          }),
        }),
      )
      .assistant('nested original')
      .execute();

    expect(session.getLastMessage()?.content).toBe('parent rewritten');
  });

  it('passes parent model middleware into conditional branches', async () => {
    const session = await Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'conditionalModelPolicy',
          afterModel: () => ({
            result: { content: 'conditional rewritten' },
          }),
        }),
      )
      .conditional(
        () => true,
        (agent) => agent.assistant('then original'),
        (agent) => agent.assistant('else original'),
      )
      .execute();

    expect(session.getLastMessage()?.content).toBe('conditional rewritten');
  });

  it('passes parent model middleware into conditional else branches', async () => {
    const session = await Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'conditionalElseModelPolicy',
          afterModel: () => ({
            result: { content: 'conditional else rewritten' },
          }),
        }),
      )
      .conditional(
        () => false,
        (agent) => agent.assistant('then original'),
        (agent) => agent.assistant('else original'),
      )
      .execute();

    expect(session.getLastMessage()?.content).toBe(
      'conditional else rewritten',
    );
  });

  it('applies prepareModelInput as a transient model request', async () => {
    const source = Source.callback(async ({ context }) => {
      return `saw:${context?.temporary}`;
    });

    const session = await Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'prepare',
          prepareModelInput: ({ request }) => ({
            request: {
              session: (request as { session: Session }).session.withVar(
                'temporary',
                'yes',
              ),
            },
          }),
        }),
      )
      .assistant(source)
      .execute();

    expect(session.getLastMessage()?.content).toBe('saw:yes');
    expect(session.getVarsObject()).toEqual({});
  });

  it('wraps assistant model calls with middleware', async () => {
    const source = Source.callback(async ({ context }) => {
      return `model:${context?.prompt}`;
    });

    const session = await Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'modelWrapper',
          wrapModelCall: async ({ request }, next) => {
            const result = await next({
              request: {
                session: (request as { session: Session }).session.withVar(
                  'prompt',
                  'wrapped',
                ),
              },
            });
            return {
              result: `${result}:patched`,
              session: {
                vars: { wrapped: true },
              },
            };
          },
        }),
      )
      .assistant(source)
      .execute();

    expect(session.getLastMessage()?.content).toBe('model:wrapped:patched');
    expect(session.getVarsObject()).toEqual({ wrapped: true });
  });

  it('does not emit model boundary events when wrapModelCall short-circuits', async () => {
    const events: string[] = [];
    const source = Source.callback(async () => {
      throw new Error('source should not run');
    });

    const session = await Agent.create('agent-interceptors')
      .observe((event) => {
        events.push(`${event.seq}:${event.type}`);
      })
      .use(
        Middleware.create({
          name: 'shortCircuit',
          wrapModelCall: () => ({
            result: { content: 'from wrapper' },
          }),
        }),
      )
      .assistant(source)
      .execute();

    expect(session.getLastMessage()?.content).toBe('from wrapper');
    expect(events).toEqual(['0:run.started', '1:run.completed']);
  });

  it('emits a terminal model event when the model call fails', async () => {
    const events: string[] = [];
    const source = Source.callback(async () => {
      throw new Error('model unavailable');
    });

    await expect(
      Agent.create('agent-interceptors')
        .observe((event) => {
          events.push(`${event.seq}:${event.type}`);
        })
        .assistant(source)
        .execute(),
    ).rejects.toThrow('model unavailable');

    expect(events).toEqual([
      '0:run.started',
      '1:model.started',
      '2:model.failed',
      '3:run.failed',
    ]);
  });

  it('emits model.completed when wrapModelCall recovers from a source error', async () => {
    const events: string[] = [];
    const source = Source.callback(async () => {
      throw new Error('transient model error');
    });

    const session = await Agent.create('agent-interceptors')
      .observe((event) => {
        events.push(`${event.seq}:${event.type}`);
      })
      .use(
        Middleware.create({
          name: 'recover',
          wrapModelCall: async (_context, next) => {
            try {
              return await next();
            } catch {
              return { result: { content: 'fallback' } };
            }
          },
        }),
      )
      .assistant(source)
      .execute();

    expect(session.getLastMessage()?.content).toBe('fallback');
    expect(events).toEqual([
      '0:run.started',
      '1:model.started',
      '2:model.completed',
      '3:run.completed',
    ]);
  });

  it('applies transient prepareModelInput messages only to the model request', async () => {
    class MessageReadingSource extends Source<string> {
      async getContent(session: Session): Promise<string> {
        return `saw:${session.messages.map((message) => message.content).join('|')}`;
      }
    }

    const session = await Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'prepareMessage',
          prepareModelInput: ({ request }) => ({
            request: {
              session: (request as { session: Session }).session.addMessage(
                Message.system('transient system'),
              ),
            },
          }),
        }),
      )
      .assistant(new MessageReadingSource())
      .execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'saw:transient system',
    ]);
  });

  it('persists prepareModelInput middlewareState into later model phases', async () => {
    const session = await Agent.create('agent-interceptors')
      .use(
        Middleware.create({
          name: 'prepareState',
          prepareModelInput: () => ({
            session: {
              middlewareState: {
                prepared: 'yes',
              },
            },
          }),
          afterModel: ({ middlewareState }) => ({
            result: { content: `state:${middlewareState.prepared}` },
          }),
        }),
      )
      .assistant('original')
      .execute();

    expect(session.getLastMessage()?.content).toBe('state:yes');
  });

  it('rejects unsupported commands from prepareModelInput', async () => {
    await expect(
      Agent.create('agent-interceptors')
        .use(
          Middleware.create({
            name: 'prepareCommand',
            prepareModelInput: () => ({
              command: { type: 'suspend', reason: 'manual' },
            }),
          }),
        )
        .assistant('original')
        .execute(),
    ).rejects.toThrow(
      'Graph node agent-interceptors/assistant-1 model execution does not support execution command suspend yet.',
    );
  });

  it('rejects persistent session patches from prepareModelInput', async () => {
    await expect(
      Agent.create('agent-interceptors')
        .use(
          Middleware.create({
            name: 'badPrepare',
            prepareModelInput: () => ({
              session: {
                vars: { persistent: true },
              },
            }),
          }),
        )
        .assistant('original')
        .execute(),
    ).rejects.toThrow(
      'prepareModelInput cannot return persistent session patches.',
    );
  });

  it('rejects persistent message patches from prepareModelInput', async () => {
    await expect(
      Agent.create('agent-interceptors')
        .use(
          Middleware.create({
            name: 'badPrepareMessage',
            prepareModelInput: ({ session }) => ({
              session: session.addMessage(Message.system('persistent')),
            }),
          }),
        )
        .assistant('original')
        .execute(),
    ).rejects.toThrow(
      'prepareModelInput cannot return persistent session patches.',
    );
  });

  it('rejects persistent var deletes from prepareModelInput', async () => {
    await expect(
      Agent.create('agent-interceptors')
        .use(
          Middleware.create({
            name: 'badPrepareDelete',
            prepareModelInput: () => ({
              session: {
                vars: { persistent: DELETE_VALUE },
              },
            }),
          }),
        )
        .assistant('original')
        .execute(),
    ).rejects.toThrow(
      'prepareModelInput cannot return persistent session patches.',
    );
  });
});
