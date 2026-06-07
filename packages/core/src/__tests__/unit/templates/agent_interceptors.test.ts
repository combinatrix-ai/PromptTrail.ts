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
});
