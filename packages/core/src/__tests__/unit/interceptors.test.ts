import { describe, expect, it } from 'vitest';
import { DELETE_VALUE } from '../../execution';
import {
  Hook,
  Middleware,
  runExecutionPhase,
  runMiddlewareWrapper,
} from '../../interceptors';
import { Message } from '../../message';
import { createSession } from '../../session';

describe('execution interceptors', () => {
  it('runs middleware before hooks and folds session transitions', async () => {
    const session = createSession({
      context: { count: 1 },
      messages: [Message.user('start')],
    });
    const middleware = Middleware.create({
      name: 'channelPolicy',
      beforeModel: ({ request, middlewareState }) => ({
        request: {
          ...(request as Record<string, unknown>),
          system: 'channel prompt',
        },
        session: {
          vars: { count: 2 },
          middlewareState: {
            seen: (middlewareState.seen as number | undefined) ?? 0,
          },
        },
      }),
    });
    const hook = Hook.create({
      name: 'audit',
      onBeforeModel: ({ session }) => ({
        session: session.addMessage(Message.system('audited')),
        command: { type: 'suspend', reason: 'approval' },
      }),
    });

    const result = await runExecutionPhase({
      phase: 'beforeModel',
      session,
      request: { user: 'hello' },
      middlewareState: { existing: true },
      middleware: [middleware],
      hooks: [hook],
      beforeVersion: 5,
    });

    expect(result.request).toEqual({
      user: 'hello',
      system: 'channel prompt',
    });
    expect(result.session.getVarsObject()).toEqual({ count: 2 });
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'start',
      'audited',
    ]);
    expect(result.middlewareState).toEqual({
      existing: true,
      seen: 0,
    });
    expect(result.command).toEqual({ type: 'suspend', reason: 'approval' });
    expect(result.beforeVersion).toBe(5);
    expect(result.afterVersion).toBe(7);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.map((step) => [step.kind, step.name])).toEqual([
      ['middleware', 'channelPolicy'],
      ['hook', 'audit'],
    ]);
    expect(result.steps.map((step) => step.transition.beforeVersion)).toEqual([
      5, 6,
    ]);
  });

  it('skips hooks for middleware-only phases', async () => {
    const session = createSession({
      messages: [Message.user('start')],
    });
    const middleware = Middleware.create({
      name: 'input',
      prepareModelInput: ({ request }) => ({
        request: {
          ...(request as Record<string, unknown>),
          transient: true,
        },
      }),
    });
    const hook = Hook.create({
      name: 'should-not-run',
      onBeforeModel: () => ({
        session: {
          appendMessages: [Message.system('wrong phase')],
        },
      }),
    });

    const result = await runExecutionPhase({
      phase: 'prepareModelInput',
      session,
      request: { user: 'hello' },
      middleware: [middleware],
      hooks: [hook],
      beforeVersion: 1,
    });

    expect(result.request).toEqual({ user: 'hello', transient: true });
    expect(result.session.messages).toHaveLength(1);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].kind).toBe('middleware');
  });

  it('omits platform delivery handles from middleware and hook contexts', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];

    await runExecutionPhase({
      phase: 'beforeModel',
      session: createSession(),
      context: {
        channelPrompt: 'discord channel policy',
        delivery: { platform: 'discord', channelId: 'C1' },
        deliveryBindings: { checkWrite: async () => undefined },
        observerDeliveryBindings: { checkWrite: async () => undefined },
        platformBinding: { messageId: 'M1' },
        platformBindings: { progress: 'M2' },
      },
      middleware: [
        Middleware.create({
          name: 'channelPolicy',
          beforeModel: ({ context }) => {
            seen.push(context);
          },
        }),
      ],
      hooks: [
        Hook.create({
          name: 'audit',
          onBeforeModel: ({ context }) => {
            seen.push(context);
          },
        }),
      ],
    });

    expect(seen).toEqual([
      { channelPrompt: 'discord channel policy' },
      { channelPrompt: 'discord channel policy' },
    ]);
  });

  it('omits platform delivery handles from middleware wrapper contexts', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];

    await runMiddlewareWrapper({
      phase: 'wrapModelCall',
      session: createSession(),
      request: { prompt: 'original' },
      context: {
        channelPrompt: 'discord channel policy',
        delivery: { platform: 'discord', channelId: 'C1' },
        deliveryBindings: { checkWrite: async () => undefined },
        observerDeliveryBindings: { checkWrite: async () => undefined },
        platformBinding: { messageId: 'M1' },
        platformBindings: { progress: 'M2' },
      },
      middleware: [
        Middleware.create({
          name: 'modelWrapper',
          wrapModelCall: ({ context }, next) => {
            seen.push(context);
            return next();
          },
        }),
      ],
      call: () => 'reply',
    });

    expect(seen).toEqual([{ channelPrompt: 'discord channel policy' }]);
  });

  it('rejects hook request and result patches at runtime', async () => {
    const hook = Hook.create({
      name: 'badHook',
      onAfterModel: () =>
        ({
          request: { bad: true },
          result: { bad: true },
        }) as never,
    });

    await expect(
      runExecutionPhase({
        phase: 'afterModel',
        session: createSession(),
        hooks: [hook],
      }),
    ).rejects.toThrow(
      'Hook badHook cannot return request/result patches in afterModel',
    );
  });

  it('preserves request/result when middleware only patches session', async () => {
    const session = createSession({
      context: { stale: true },
    });
    const middleware = Middleware.create({
      name: 'cleanup',
      afterTool: () => ({
        session: {
          vars: {
            stale: DELETE_VALUE,
            fresh: true,
          },
        },
      }),
    });

    const result = await runExecutionPhase({
      phase: 'afterTool',
      session,
      request: { tool: 'search' },
      result: { content: 'ok' },
      middleware: [middleware],
    });

    expect(result.request).toEqual({ tool: 'search' });
    expect(result.result).toEqual({ content: 'ok' });
    expect(result.session.getVarsObject()).toEqual({ fresh: true });
  });

  it('short-circuits remaining handlers after a control command', async () => {
    const session = createSession({
      messages: [Message.user('start')],
    });
    const first = Middleware.create({
      name: 'approval',
      beforeTool: () => ({
        session: {
          appendMessages: [Message.system('approval required')],
        },
        command: { type: 'suspend', reason: 'approval' },
      }),
    });
    const second = Middleware.create({
      name: 'must-not-run',
      beforeTool: () => ({
        session: {
          appendMessages: [Message.system('wrong')],
        },
      }),
    });
    const hook = Hook.create({
      name: 'must-not-run-hook',
      onBeforeTool: () => ({
        session: {
          appendMessages: [Message.system('wrong hook')],
        },
      }),
    });

    const result = await runExecutionPhase({
      phase: 'beforeTool',
      session,
      middleware: [first, second],
      hooks: [hook],
      beforeVersion: 2,
    });

    expect(result.command).toEqual({ type: 'suspend', reason: 'approval' });
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'start',
      'approval required',
    ]);
    expect(result.steps.map((step) => step.name)).toEqual(['approval']);
    expect(result.afterVersion).toBe(3);
  });

  it('does not record steps for void handlers', async () => {
    const result = await runExecutionPhase({
      phase: 'afterAgent',
      session: createSession(),
      middleware: [
        Middleware.create({
          name: 'noop',
          afterAgent: () => undefined,
        }),
      ],
    });

    expect(result.steps).toEqual([]);
    expect(result.afterVersion).toBe(0);
  });

  it('checks abort signals before each handler', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runExecutionPhase({
        phase: 'beforeAgent',
        session: createSession(),
        signal: controller.signal,
        middleware: [
          Middleware.create({
            name: 'blocked',
            beforeAgent: () => ({
              session: {
                vars: { ran: true },
              },
            }),
          }),
        ],
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not apply a patch when the signal aborts during a handler', async () => {
    const controller = new AbortController();

    await expect(
      runExecutionPhase({
        phase: 'beforeAgent',
        session: createSession(),
        signal: controller.signal,
        middleware: [
          Middleware.create({
            name: 'aborting',
            beforeAgent: () => {
              controller.abort();
              return {
                session: {
                  vars: { shouldNotApply: true },
                },
              };
            },
          }),
        ],
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects nested durable effects in materialized phases', async () => {
    await expect(
      runExecutionPhase({
        phase: 'beforeModel',
        session: createSession(),
        middleware: [
          Middleware.create({
            name: 'clock',
            beforeModel: async ({ durable }) => ({
              session: {
                vars: {
                  now: await durable.once('now', 'clock', () => Date.now()),
                },
              },
            }),
          }),
        ],
      }),
    ).rejects.toThrow(
      "ctx.once() is not allowed in middleware clock beforeModel; declare durability: 'replayable-handler'",
    );
  });

  it('requires durable execution for replayable handler effects', async () => {
    await expect(
      runExecutionPhase({
        phase: 'beforeModel',
        session: createSession(),
        middleware: [
          Middleware.create({
            name: 'profile',
            durability: 'replayable-handler',
            beforeModel: async ({ durable }) => ({
              session: {
                vars: {
                  profile: await durable.once(
                    'load-profile',
                    'profile',
                    () => 'loaded',
                  ),
                },
              },
            }),
          }),
        ],
      }),
    ).rejects.toThrow(
      'ctx.once() is only available when middleware profile beforeModel runs in durable replayable-handler mode.',
    );
  });

  it('injects durable boundaries only for replayable handlers', async () => {
    const provided: string[] = [];
    const result = await runExecutionPhase({
      phase: 'beforeModel',
      session: createSession(),
      durableBoundary: (handler) => ({
        async once(name, dep, fn) {
          provided.push(
            `${handler.kind}:${handler.name}:${handler.phase}:${name}:${dep}`,
          );
          return fn();
        },
      }),
      middleware: [
        Middleware.create({
          name: 'clock',
          durability: 'replayable-handler',
          beforeModel: async ({ durable }) => ({
            session: {
              vars: {
                now: await durable.once('now', 'clock', () => 123),
              },
            },
          }),
        }),
      ],
    });

    expect(result.session.getVarsObject()).toEqual({ now: 123 });
    expect(provided).toEqual(['middleware:clock:beforeModel:now:clock']);

    await expect(
      runExecutionPhase({
        phase: 'beforeModel',
        session: createSession(),
        durableBoundary: () => ({
          async once(_name, _dep, fn) {
            return fn();
          },
        }),
        middleware: [
          Middleware.create({
            name: 'materialized',
            beforeModel: async ({ durable }) => ({
              session: {
                vars: {
                  now: await durable.once('now', 'clock', () => 456),
                },
              },
            }),
          }),
        ],
      }),
    ).rejects.toThrow(
      "ctx.once() is not allowed in middleware materialized beforeModel; declare durability: 'replayable-handler'",
    );
  });

  it('runs middleware wrappers around an execution call', async () => {
    const session = createSession({
      messages: [Message.user('start')],
    });
    const events: string[] = [];
    const result = await runMiddlewareWrapper({
      phase: 'wrapModelCall',
      session,
      request: { prompt: 'original' },
      middleware: [
        Middleware.create({
          name: 'outer',
          wrapModelCall: async ({ request }, next) => {
            events.push(`outer:before:${JSON.stringify(request)}`);
            const content = await next({
              request: { prompt: 'rewritten' },
            });
            events.push(`outer:after:${content}`);
            return {
              result: `${content}:outer`,
              session: { vars: { outer: true } },
            };
          },
        }),
        Middleware.create({
          name: 'inner',
          wrapModelCall: async (_ctx, next) => {
            const content = await next();
            return `${content}:inner`;
          },
        }),
      ],
      call: async ({ request }) => {
        events.push(`call:${request.prompt}`);
        return `result:${request.prompt}`;
      },
      beforeVersion: 10,
    });

    expect(result.result).toBe('result:rewritten:inner:outer');
    expect(result.session.getVarsObject()).toEqual({ outer: true });
    expect(result.afterVersion).toBe(11);
    expect(result.steps.map((step) => step.name)).toEqual(['inner', 'outer']);
    expect(events).toEqual([
      'outer:before:{"prompt":"original"}',
      'call:rewritten',
      'outer:after:result:rewritten:inner',
    ]);
  });

  it('falls through wrapper middleware that returns void', async () => {
    const events: string[] = [];
    const result = await runMiddlewareWrapper({
      phase: 'wrapModelCall',
      session: createSession(),
      request: { prompt: 'original' },
      middleware: [
        Middleware.create({
          name: 'observer',
          wrapModelCall: async (_ctx, next) => {
            events.push('observer:before');
            await next();
            events.push('observer:after');
          },
        }),
        Middleware.create({
          name: 'implicitNext',
          wrapModelCall: () => {
            events.push('implicitNext');
          },
        }),
      ],
      call: async ({ request }) => {
        events.push(`call:${request.prompt}`);
        return `result:${request.prompt}`;
      },
    });

    expect(result.result).toBe('result:original');
    expect(result.steps).toEqual([]);
    expect(events).toEqual([
      'observer:before',
      'implicitNext',
      'call:original',
      'observer:after',
    ]);
  });
});
