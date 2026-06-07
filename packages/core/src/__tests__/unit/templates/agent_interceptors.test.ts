import { describe, expect, it } from 'vitest';
import { Hook, Middleware } from '../../../interceptors';
import { Message } from '../../../message';
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

  it('emits run.failed before rethrowing direct execution errors', async () => {
    const events: string[] = [];
    const agent = Agent.create()
      .observe((event) => {
        events.push(`${event.seq}:${event.type}`);
      })
      .hook(
        Hook.create({
          name: 'control',
          onBeforeAgent: () => ({
            command: { type: 'halt', reason: 'manual' },
          }),
        }),
      );

    await expect(agent.execute()).rejects.toThrow(
      'Agent.execute does not support execution command halt yet.',
    );
    expect(events).toEqual(['0:run.started', '1:run.failed']);
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
});
