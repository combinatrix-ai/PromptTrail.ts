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
      '2:session.patched:afterModel',
      '3:run.completed:-',
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
