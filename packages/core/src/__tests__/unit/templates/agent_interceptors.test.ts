import { describe, expect, it } from 'vitest';
import { DELETE_VALUE } from '../../../execution';
import { Hook, Middleware } from '../../../interceptors';
import { Message } from '../../../message';
import type { Session } from '../../../session';
import { Source } from '../../../source';
import { Agent } from '../../../templates';

describe('Agent interceptors', () => {
  it('runs beforeAgent and afterAgent middleware and hooks', async () => {
    const agent = Agent.create()
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
    const session = await Agent.create()
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
    const session = await Agent.create()
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
    const session = await Agent.create()
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
    const session = await Agent.create()
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
      .subroutine(
        (agent) => agent.user('hidden').assistant('should not run'),
        { retainMessages: false },
      )
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
      Agent.create()
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
    const session = await Agent.create()
      .observe((event) => {
        events.push(`${event.seq}:${event.type}`);
      })
      .user('hello')
      .execute();

    expect(session.getLastMessage()?.content).toBe('hello');
    expect(events).toEqual(['0:run.started', '1:run.completed']);
  });

  it('threads direct execution context into middleware', async () => {
    const session = await Agent.create()
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
      .execute(undefined, { context: { channel: 'claw-test' } });

    expect(session.getVarsObject()).toEqual({ channel: 'claw-test' });
  });

  it('threads direct execution context into nested agents', async () => {
    const session = await Agent.create()
      .sequence((agent) =>
        agent
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
          .assistant('reply'),
      )
      .execute(undefined, { context: { userId: 'U1' } });

    expect(session.getVarsObject()).toEqual({ userId: 'U1' });
  });

  it('emits session.patched events for materialized phase patches', async () => {
    const events: string[] = [];
    const session = await Agent.create()
      .observe((event) => {
        events.push(`${event.seq}:${event.type}:${event.phase ?? '-'}`);
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
    expect(events).toEqual([
      '0:run.started:-',
      '1:session.patched:beforeAgent',
      '2:model.started:model',
      '3:model.completed:model',
      '4:session.patched:afterModel',
      '5:run.completed:-',
    ]);
  });

  it('emits nested agent events to nested observers under a parent runtime', async () => {
    const parentEvents: string[] = [];
    const nestedEvents: string[] = [];

    const session = await Agent.create()
      .observe((event) => {
        parentEvents.push(`${event.seq}:${event.type}`);
      })
      .sequence((agent) =>
        agent
          .observe((event) => {
            nestedEvents.push(`${event.seq}:${event.type}`);
          })
          .user('nested hello'),
      )
      .execute();

    expect(session.getLastMessage()?.content).toBe('nested hello');
    expect(parentEvents).toEqual([
      '0:run.started',
      '1:run.started',
      '2:run.completed',
      '3:run.completed',
    ]);
    expect(nestedEvents).toEqual(['1:run.started', '2:run.completed']);
  });

  it('rejects unsupported direct execution commands', async () => {
    const agent = Agent.create().hook(
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
    const agent = Agent.create()
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
    const agent = Agent.create()
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
    const session = await Agent.create()
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

  it('preserves interceptors when nested builders are built', async () => {
    const session = await Agent.create()
      .sequence((agent) =>
        agent
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
          .user('nested hello'),
      )
      .execute();

    expect(session.getVarsObject()).toEqual({ nestedMiddleware: true });
    expect(session.getLastMessage()?.content).toBe('nested hello');
  });

  it('passes parent model middleware into nested assistants', async () => {
    const session = await Agent.create()
      .use(
        Middleware.create({
          name: 'parentModelPolicy',
          afterModel: () => ({
            result: { content: 'parent rewritten' },
          }),
        }),
      )
      .sequence((agent) => agent.assistant('nested original'))
      .execute();

    expect(session.getLastMessage()?.content).toBe('parent rewritten');
  });

  it('passes parent model middleware into conditional branches', async () => {
    const session = await Agent.create()
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
    const session = await Agent.create()
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

    const session = await Agent.create()
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

    const session = await Agent.create()
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

    const session = await Agent.create()
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
      Agent.create()
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

    const session = await Agent.create()
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

    const session = await Agent.create()
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
    const session = await Agent.create()
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
      Agent.create()
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
      'Assistant.execute does not support execution command suspend yet.',
    );
  });

  it('rejects persistent session patches from prepareModelInput', async () => {
    await expect(
      Agent.create()
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
      Agent.create()
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
      Agent.create()
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
