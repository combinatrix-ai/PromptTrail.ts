import { describe, expect, it } from 'vitest';
import { DELETE_VALUE } from '../../execution';
import { Hook, Middleware, runExecutionPhase } from '../../interceptors';
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
});
