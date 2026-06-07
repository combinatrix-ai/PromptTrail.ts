import { describe, expect, it } from 'vitest';
import {
  MemoryDurableRuntime,
  NondeterminismError,
  PromptTrail,
  agent,
  manualSource,
  memoryStore,
} from '../../durable';
import { Hook, Middleware } from '../../interceptors';

describe('durable agent runtime', () => {
  it('runs durable agents through the app runtime', async () => {
    let modelCalls = 0;
    const assistant = agent('assistant')
      .system('You are helpful.')
      .turn('main', (turn) =>
        turn
          .steer('inbox')
          .assistant('reply', () => {
            modelCalls++;
            return `turn ${modelCalls}`;
          })
          .awaitUser('next'),
      );
    const app = PromptTrail.app({
      agents: { assistant },
      store: memoryStore(),
    });

    const first = await app.run({
      agent: 'assistant',
      runId: 'run-1',
      input: 'hello',
      durable: true,
    });

    expect(first.status).toBe('suspended');
    expect(first.awaiting).toBe('main/next/input');
    expect(first.session.messages.map((message) => message.content)).toEqual([
      'You are helpful.',
      'hello',
      'turn 1',
    ]);
    expect(modelCalls).toBe(1);

    const second = await app.send({
      runId: 'run-1',
      input: 'next message',
    });

    expect(second.status).toBe('done');
    expect(second.session.messages.map((message) => message.content)).toEqual([
      'You are helpful.',
      'hello',
      'turn 1',
      'next message',
    ]);
    expect(modelCalls).toBe(1);
  });

  it('journals model and tool effects for durable replay', async () => {
    let modelCalls = 0;
    let toolCalls = 0;
    const assistant = agent('tool-agent')
      .system('Use tools.')
      .tool('lookup', {
        execute: async ({ query }) => {
          toolCalls++;
          return `result:${query}`;
        },
      })
      .turn('main', (turn) =>
        turn
          .steer('inbox')
          .assistant('reply', (session) => {
            modelCalls++;
            const hasToolResult = session
              .getMessagesByType('tool_result')
              .some((message) => message.content === 'result:hello');
            if (hasToolResult) {
              return 'done';
            }
            return {
              content: 'need tool',
              toolCalls: [
                {
                  id: 'call-1',
                  name: 'lookup',
                  arguments: { query: 'hello' },
                },
              ],
            };
          })
          .runTools('tools')
          .untilNoToolCalls()
          .awaitUser('next'),
      );
    const app = PromptTrail.app({
      agents: { assistant },
      store: memoryStore(),
    });

    const first = await app.run({
      agent: assistant,
      runId: 'run-2',
      input: 'hello',
      durable: true,
    });
    const replay = await app.resume('run-2');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(modelCalls).toBe(2);
    expect(toolCalls).toBe(1);
    expect(app.journal('run-2')).toEqual([
      'main#0/inbox/peek',
      'main#0/reply/model',
      'main#0/tools/call-1',
      'main#1/inbox/peek',
      'main#1/reply/model',
    ]);
  });

  it('passes activity metadata to durable tool executions', async () => {
    const contexts: Array<{
      runId: string;
      stepId: string;
      idempotencyKey?: string;
      toolCallId: string;
    }> = [];
    let activityResolutions = 0;
    const assistant = agent('activity-tool-agent')
      .tool('sendDiscord', {
        activity: (call) => {
          activityResolutions++;
          return {
            kind: 'external-write',
            idempotencyKey: `discord:${call.id}`,
          };
        },
        execute: async (_args, context) => {
          contexts.push({
            runId: context.runId,
            stepId: context.stepId,
            idempotencyKey: context.activity.idempotencyKey,
            toolCallId: context.toolCall.id,
          });
          return { sent: context.activity.idempotencyKey };
        },
      })
      .assistant('reply', () => ({
        content: 'need tool',
        toolCalls: [
          {
            id: 'call-send',
            name: 'sendDiscord',
            arguments: { channel: 'claw-test' },
          },
        ],
      }))
      .runTools();
    const app = PromptTrail.app({
      agents: { assistant },
      store: memoryStore(),
    });

    const first = await app.run({
      agent: assistant,
      runId: 'run-activity-tool',
      durable: true,
    });
    const replay = await app.resume('run-activity-tool');

    expect(first.status).toBe('done');
    expect(replay.status).toBe('done');
    expect(contexts).toEqual([
      {
        runId: 'run-activity-tool',
        stepId: 'tools/call-send',
        idempotencyKey: 'discord:call-send',
        toolCallId: 'call-send',
      },
    ]);
    expect(activityResolutions).toBe(1);
    expect(app.journal('run-activity-tool')).toEqual([
      'reply/model',
      'tools/call-send',
    ]);
  });

  it('requires idempotency keys for external-write durable tools', async () => {
    let toolCalls = 0;
    const assistant = agent('write-tool-agent')
      .tool('sendDiscord', {
        activity: { kind: 'external-write' },
        execute: async () => {
          toolCalls++;
          return 'sent';
        },
      })
      .assistant('reply', () => ({
        content: 'need tool',
        toolCalls: [
          {
            id: 'call-send',
            name: 'sendDiscord',
            arguments: { channel: 'claw-test' },
          },
        ],
      }))
      .runTools();
    const app = PromptTrail.app({
      agents: { assistant },
      store: memoryStore(),
    });

    await expect(
      app.run({
        agent: assistant,
        runId: 'run-write-tool',
        durable: true,
      }),
    ).rejects.toThrow(
      'Durable tool sendDiscord external-write activity requires idempotencyKey.',
    );
    expect(toolCalls).toBe(0);
    expect(app.journal('run-write-tool')).toEqual(['reply/model']);
  });

  it('rejects duplicate durable tool step ids in one batch', async () => {
    let toolCalls = 0;
    const assistant = agent('duplicate-tool-agent')
      .tool('lookup', {
        execute: async () => {
          toolCalls++;
          return 'result';
        },
      })
      .assistant('reply', () => ({
        content: 'need tools',
        toolCalls: [
          {
            id: 'call-1',
            name: 'lookup',
            arguments: { query: 'one' },
          },
          {
            id: 'call-1',
            name: 'lookup',
            arguments: { query: 'two' },
          },
        ],
      }))
      .runTools();
    const app = PromptTrail.app({
      agents: { assistant },
      store: memoryStore(),
    });

    await expect(
      app.run({
        agent: assistant,
        runId: 'run-duplicate-tools',
        durable: true,
      }),
    ).rejects.toThrow(
      'Duplicate durable tool step: tools/call-1. Tool call ids must be unique within tools.',
    );
    expect(toolCalls).toBe(0);
    expect(app.journal('run-duplicate-tools')).toEqual(['reply/model']);
  });

  it('journals resolved session transitions without re-running patch handlers', async () => {
    let patchCalls = 0;
    const assistant = agent('patch-agent')
      .patch('stamp', () => {
        patchCalls++;
        return {
          session: {
            vars: {
              stamp: patchCalls,
            },
          },
        };
      })
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { assistant },
      store: memoryStore(),
    });

    const first = await app.run({
      agent: assistant,
      runId: 'run-patch',
      durable: true,
    });
    const replay = await app.resume('run-patch');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(first.session.getVarsObject()).toEqual({ stamp: 1 });
    expect(replay.session.getVarsObject()).toEqual({ stamp: 1 });
    expect(patchCalls).toBe(1);
    expect(app.journal('run-patch')).toEqual(['stamp/transition']);
  });

  it('journals app-level model middleware and hooks without re-running them on replay', async () => {
    let beforeCalls = 0;
    let afterCalls = 0;
    let hookCalls = 0;
    let modelCalls = 0;
    const assistant = agent('intercepted').turn('main', (turn) =>
      turn
        .steer()
        .assistant('reply', (session) => {
          modelCalls++;
          return `model:${session.getVarsObject().beforeModel}`;
        })
        .awaitUser(),
    );
    const app = PromptTrail.app({
      agents: { intercepted: assistant },
      store: memoryStore(),
      middleware: [
        Middleware.create({
          name: 'modelPolicy',
          beforeModel: () => {
            beforeCalls++;
            return {
              session: {
                vars: { beforeModel: `before:${beforeCalls}` },
              },
            };
          },
          afterModel: ({ result }) => {
            afterCalls++;
            return {
              result: {
                content: `${(result as { content: string }).content}:after:${afterCalls}`,
              },
              session: {
                vars: { afterModel: afterCalls },
              },
            };
          },
        }),
      ],
      hooks: [
        Hook.create({
          name: 'audit',
          onAfterModel: () => {
            hookCalls++;
            return {
              session: {
                vars: { hook: hookCalls },
              },
            };
          },
        }),
      ],
    });

    const first = await app.run({
      agent: 'intercepted',
      runId: 'run-intercepted',
      input: 'hello',
      durable: true,
    });
    const replay = await app.resume('run-intercepted');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()?.content).toBe(
      'model:before:1:after:1',
    );
    expect(replay.session.getVarsObject()).toEqual({
      beforeModel: 'before:1',
      afterModel: 1,
      hook: 1,
    });
    expect(beforeCalls).toBe(1);
    expect(afterCalls).toBe(1);
    expect(hookCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(app.journal('run-intercepted')).toEqual([
      'main/steer/peek',
      'main/reply/beforeModel',
      'main/reply/model',
      'main/reply/afterModel',
    ]);
  });

  it('composes durable agent-level middleware and hooks before app-level handlers', async () => {
    const appendOrder = (
      session: { getVar(name: string): unknown },
      label: string,
    ) =>
      `${(session.getVar('order') as string | undefined) ?? ''}${label}>`;
    let agentMiddlewareCalls = 0;
    let appMiddlewareCalls = 0;
    let agentHookCalls = 0;
    let appHookCalls = 0;
    const assistant = agent('configured')
      .use(
        Middleware.create({
          name: 'agentMiddleware',
          beforeModel: ({ session }) => {
            agentMiddlewareCalls++;
            return {
              session: {
                vars: { order: appendOrder(session, 'agentMw') },
              },
            };
          },
        }),
      )
      .hook(
        Hook.create({
          name: 'agentHook',
          onBeforeModel: ({ session }) => {
            agentHookCalls++;
            return {
              session: {
                vars: { order: appendOrder(session, 'agentHook') },
              },
            };
          },
        }),
      )
      .turn('main', (turn) =>
        turn
          .steer()
          .assistant('reply', (session) => `order:${session.getVar('order')}`)
          .awaitUser(),
      );
    const app = PromptTrail.app({
      agents: { configured: assistant },
      store: memoryStore(),
      middleware: [
        Middleware.create({
          name: 'appMiddleware',
          beforeModel: ({ session }) => {
            appMiddlewareCalls++;
            return {
              session: {
                vars: { order: appendOrder(session, 'appMw') },
              },
            };
          },
        }),
      ],
      hooks: [
        Hook.create({
          name: 'appHook',
          onBeforeModel: ({ session }) => {
            appHookCalls++;
            return {
              session: {
                vars: { order: appendOrder(session, 'appHook') },
              },
            };
          },
        }),
      ],
    });

    const first = await app.run({
      agent: 'configured',
      runId: 'run-agent-configured',
      durable: true,
    });
    const replay = await app.resume('run-agent-configured');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()?.content).toBe(
      'order:agentMw>appMw>agentHook>appHook>',
    );
    expect(agentMiddlewareCalls).toBe(1);
    expect(appMiddlewareCalls).toBe(1);
    expect(agentHookCalls).toBe(1);
    expect(appHookCalls).toBe(1);
    expect(app.journal('run-agent-configured')).toEqual([
      'main/steer/peek',
      'main/reply/beforeModel',
      'main/reply/model',
    ]);
  });

  it('emits durable runtime events to agent-level observers', async () => {
    const appEvents: string[] = [];
    const events: string[] = [];
    const assistant = agent('observed-agent')
      .observe({
        name: 'agentObserver',
        handle(event) {
          if (
            event.type === 'run.started' ||
            event.type === 'model.started' ||
            event.type === 'model.completed' ||
            event.type === 'run.completed'
          ) {
            events.push(`${event.seq}:${event.type}:${event.stepId ?? '-'}`);
          }
        },
      })
      .assistant('reply', () => 'hello');
    const app = PromptTrail.app({
      agents: { observed: assistant },
      store: memoryStore(),
      observers: [
        {
          name: 'appObserver',
          handle(event) {
            if (event.type === 'model.started') {
              appEvents.push(`${event.seq}:${event.type}:${event.stepId}`);
            }
          },
        },
      ],
    });

    const result = await app.run({
      agent: 'observed',
      runId: 'run-agent-observed',
      durable: true,
    });

    expect(result.status).toBe('done');
    expect(appEvents).toEqual(['1:model.started:reply/model']);
    expect(events).toEqual([
      '0:run.started:-',
      '1:model.started:reply/model',
      '2:model.completed:reply/model',
      '3:run.completed:-',
    ]);
  });

  it('journals durable beforeAgent and afterAgent phases without re-running them on replay', async () => {
    const store = memoryStore();
    let beforeCalls = 0;
    let afterCalls = 0;
    let hookCalls = 0;
    let modelCalls = 0;
    const assistant = agent('agent-phases').assistant('reply', (session) => {
      modelCalls++;
      return `model:${session.getVarsObject().beforeAgent}`;
    });
    const app = PromptTrail.app({
      agents: { phased: assistant },
      store,
      middleware: [
        Middleware.create({
          name: 'agentPolicy',
          beforeAgent: () => {
            beforeCalls++;
            return {
              session: { vars: { beforeAgent: `before:${beforeCalls}` } },
            };
          },
          afterAgent: () => {
            afterCalls++;
            return {
              session: { vars: { afterAgent: `after:${afterCalls}` } },
            };
          },
        }),
      ],
      hooks: [
        Hook.create({
          name: 'agentAudit',
          onAfterAgent: () => {
            hookCalls++;
            return {
              session: { vars: { afterHook: `hook:${hookCalls}` } },
            };
          },
        }),
      ],
    });

    const first = await app.run({
      agent: 'phased',
      runId: 'run-agent-phases',
      durable: true,
    });
    const stored = store.get('run-agent-phases')!;
    stored.status = 'open';
    stored.result = undefined;
    const replay = await app.resume('run-agent-phases');

    expect(first.status).toBe('done');
    expect(replay.status).toBe('done');
    expect(replay.session.getLastMessage()?.content).toBe('model:before:1');
    expect(replay.session.getVarsObject()).toEqual({
      beforeAgent: 'before:1',
      afterAgent: 'after:1',
      afterHook: 'hook:1',
    });
    expect(beforeCalls).toBe(1);
    expect(afterCalls).toBe(1);
    expect(hookCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(app.journal('run-agent-phases')).toEqual([
      'beforeAgent',
      'reply/model',
      'afterAgent',
    ]);
  });

  it('replays durable effects inside replayable phase handlers after a mid-phase crash', async () => {
    let handlerCalls = 0;
    let memoCalls = 0;
    let activityCalls = 0;
    let modelCalls = 0;
    const assistant = agent('replayable-effect').turn('main', (turn) =>
      turn
        .steer()
        .assistant('reply', (session) => {
          modelCalls++;
          const vars = session.getVarsObject();
          return `model:${vars.now}:${vars.profile}`;
        })
        .awaitUser(),
    );
    const app = PromptTrail.app({
      agents: { replayable: assistant },
      store: memoryStore(),
      middleware: [
        Middleware.create({
          name: 'profileLoader',
          durability: 'replayable-handler',
          beforeModel: async ({ durable }) => {
            handlerCalls++;
            const now = await durable.memo('now', () => {
              memoCalls++;
              return `now:${memoCalls}`;
            });
            const profile = await durable.activity(
              'load-profile',
              { kind: 'external-read' },
              () => {
                activityCalls++;
                return `profile:${activityCalls}`;
              },
            );
            if (handlerCalls === 1) {
              throw new Error('phase crash');
            }
            return {
              session: {
                vars: {
                  now,
                  profile,
                  handlerCalls,
                },
              },
            };
          },
        }),
      ],
    });

    await expect(
      app.run({
        agent: 'replayable',
        runId: 'run-replayable-effects',
        input: 'hello',
        durable: true,
      }),
    ).rejects.toThrow('phase crash');

    expect(app.journal('run-replayable-effects')).toEqual([
      'main/steer/peek',
      'main/reply/beforeModel/middleware[0]/beforeModel/profileLoader/memo/now',
      'main/reply/beforeModel/middleware[0]/beforeModel/profileLoader/activity/load-profile',
    ]);

    const replay = await app.resume('run-replayable-effects');

    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()?.content).toBe(
      'model:now:1:profile:1',
    );
    expect(replay.session.getVarsObject()).toEqual({
      now: 'now:1',
      profile: 'profile:1',
      handlerCalls: 2,
    });
    expect(handlerCalls).toBe(2);
    expect(memoCalls).toBe(1);
    expect(activityCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(app.journal('run-replayable-effects')).toEqual([
      'main/steer/peek',
      'main/reply/beforeModel/middleware[0]/beforeModel/profileLoader/memo/now',
      'main/reply/beforeModel/middleware[0]/beforeModel/profileLoader/activity/load-profile',
      'main/reply/beforeModel',
      'main/reply/model',
    ]);
  });

  it('emits durable session.patched events for live and journaled phase patches', async () => {
    const events: string[] = [];
    const assistant = agent('patch-observed')
      .assistant(
        'reply',
        (session) => `model:${session.getVarsObject().before}`,
      )
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { observed: assistant },
      store: memoryStore(),
      observers: [
        {
          replayPolicy: 'live-and-journaled',
          handle(event) {
            if (event.type !== 'session.patched') {
              return;
            }
            const raw = event.raw as {
              kind: string;
              name?: string;
            };
            events.push(
              `${event.seq}:${event.replay}:${event.stepId}:${event.phase}:${raw.kind}:${raw.name ?? '-'}`,
            );
          },
        },
      ],
      middleware: [
        Middleware.create({
          name: 'before',
          beforeModel: () => ({
            session: { vars: { before: 'yes' } },
          }),
        }),
      ],
      hooks: [
        Hook.create({
          name: 'audit',
          onAfterModel: () => ({
            session: { vars: { audited: true } },
          }),
        }),
      ],
    });

    const first = await app.run({
      agent: 'observed',
      runId: 'run-patch-observed',
      durable: true,
    });
    const replay = await app.resume('run-patch-observed');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(events).toEqual([
      '1:live:reply/beforeModel:beforeModel:middleware:before',
      '4:live:reply/afterModel:afterModel:hook:audit',
      '7:journaled:reply/beforeModel:beforeModel:middleware:before',
      '8:journaled:reply/afterModel:afterModel:hook:audit',
    ]);
  });

  it('surfaces strict durable session.patched observer failures without re-running the phase', async () => {
    let beforeCalls = 0;
    const assistant = agent('strict-patch-observed')
      .assistant(
        'reply',
        (session) => `model:${session.getVarsObject().before}`,
      )
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { observed: assistant },
      store: memoryStore(),
      strictObservers: true,
      observers: [
        {
          name: 'failingPatchObserver',
          handle(event) {
            if (event.type === 'session.patched') {
              throw new Error(`patch observer failed:${event.replay}`);
            }
          },
        },
      ],
      middleware: [
        Middleware.create({
          name: 'before',
          beforeModel: () => {
            beforeCalls++;
            return {
              session: { vars: { before: beforeCalls } },
            };
          },
        }),
      ],
    });

    await expect(
      app.run({
        agent: 'observed',
        runId: 'run-strict-patch-observed',
        durable: true,
      }),
    ).rejects.toThrow('patch observer failed:live');
    await expect(app.resume('run-strict-patch-observed')).rejects.toThrow(
      'patch observer failed:journaled',
    );

    expect(beforeCalls).toBe(1);
    expect(app.journal('run-strict-patch-observed')).toEqual([
      'reply/beforeModel',
    ]);
  });

  it('applies durable prepareModelInput as transient model input', async () => {
    const assistant = agent('prepared')
      .assistant(
        'reply',
        (session) => `saw:${session.getVarsObject().temporary}`,
      )
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { prepared: assistant },
      store: memoryStore(),
      middleware: [
        Middleware.create({
          name: 'prepare',
          prepareModelInput: ({ request }) => ({
            request: {
              session: (
                request as {
                  session: { withVar(key: string, value: string): unknown };
                }
              ).session.withVar('temporary', 'yes'),
            },
          }),
        }),
      ],
    });

    const first = await app.run({
      agent: 'prepared',
      runId: 'run-prepare',
      durable: true,
    });
    const replay = await app.resume('run-prepare');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()?.content).toBe('saw:yes');
    expect(replay.session.getVarsObject()).toEqual({});
    expect(app.journal('run-prepare')).toEqual([
      'reply/prepareModelInput',
      'reply/model',
    ]);
  });

  it('journals durable wrapModelCall middleware without re-running on replay', async () => {
    let wrapperCalls = 0;
    let modelCalls = 0;
    const events: string[] = [];
    const assistant = agent('wrapped-model')
      .assistant('reply', (session) => {
        modelCalls++;
        return `model:${session.getVarsObject().temporary}`;
      })
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { wrapped: assistant },
      store: memoryStore(),
      observers: [
        {
          replayPolicy: 'live-and-journaled',
          handle(event) {
            if (event.type === 'session.patched') {
              events.push(`${event.replay}:${event.stepId}:${event.phase}`);
            }
          },
        },
      ],
      middleware: [
        Middleware.create({
          name: 'modelWrapper',
          wrapModelCall: async ({ request }, next) => {
            wrapperCalls++;
            const upstreamSession = (
              request as {
                session: { withVar(key: string, value: string): unknown };
              }
            ).session;
            const result = await next({
              session: upstreamSession.withVar('downstream', 'kept'),
              request: {
                session: upstreamSession.withVar('temporary', 'wrapped'),
              },
            });
            return {
              result: `${result}:wrapper:${wrapperCalls}`,
              session: {
                vars: { wrappedModel: wrapperCalls },
              },
            };
          },
        }),
      ],
    });

    const first = await app.run({
      agent: 'wrapped',
      runId: 'run-wrap-model',
      durable: true,
    });
    const replay = await app.resume('run-wrap-model');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()?.content).toBe(
      'model:wrapped:wrapper:1',
    );
    expect(replay.session.getVarsObject()).toEqual({
      downstream: 'kept',
      wrappedModel: 1,
    });
    expect(wrapperCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(app.journal('run-wrap-model')).toEqual([
      'reply/wrapModelCall/next/0',
      'reply/wrapModelCall',
    ]);
    expect(events).toEqual([
      'live:reply/wrapModelCall:wrapModelCall',
      'journaled:reply/wrapModelCall:wrapModelCall',
    ]);
  });

  it('does not re-run wrapped model calls after a post-next crash', async () => {
    let wrapperCalls = 0;
    let modelCalls = 0;
    const assistant = agent('crashy-wrapped-model')
      .assistant('reply', () => {
        modelCalls++;
        return `model:${modelCalls}`;
      })
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { wrapped: assistant },
      store: memoryStore(),
      middleware: [
        Middleware.create({
          name: 'crashyModelWrapper',
          wrapModelCall: async (_context, next) => {
            wrapperCalls++;
            const result = await next();
            if (wrapperCalls === 1) {
              throw new Error('post-next model crash');
            }
            return `${result}:wrapper:${wrapperCalls}`;
          },
        }),
      ],
    });

    await expect(
      app.run({
        agent: 'wrapped',
        runId: 'run-wrap-model-crash',
        durable: true,
      }),
    ).rejects.toThrow('post-next model crash');

    expect(app.journal('run-wrap-model-crash')).toEqual([
      'reply/wrapModelCall/next/0',
    ]);

    const replay = await app.resume('run-wrap-model-crash');

    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()?.content).toBe('model:1:wrapper:2');
    expect(wrapperCalls).toBe(2);
    expect(modelCalls).toBe(1);
    expect(app.journal('run-wrap-model-crash')).toEqual([
      'reply/wrapModelCall/next/0',
      'reply/wrapModelCall',
    ]);
  });

  it('journals app-level model middleware around durable chat nodes', async () => {
    let beforeCalls = 0;
    let afterCalls = 0;
    let modelCalls = 0;
    const assistant = agent('chatty').chat('chat', (session) => {
      modelCalls++;
      return `chat:${session.getLastMessage()?.content}:${session.getVarsObject().before}`;
    });
    const app = PromptTrail.app({
      agents: { chatty: assistant },
      store: memoryStore(),
      middleware: [
        Middleware.create({
          name: 'chatPolicy',
          beforeModel: () => {
            beforeCalls++;
            return {
              session: {
                vars: { before: beforeCalls },
              },
            };
          },
          afterModel: ({ result }) => {
            afterCalls++;
            return {
              result: {
                content: `${(result as { content: string }).content}:after:${afterCalls}`,
              },
            };
          },
        }),
      ],
    });

    const first = await app.run({
      agent: 'chatty',
      runId: 'run-chat-intercepted',
      input: 'hello',
      durable: true,
    });
    const replay = await app.resume('run-chat-intercepted');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()?.content).toBe(
      'chat:hello:1:after:1',
    );
    expect(beforeCalls).toBe(1);
    expect(afterCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(app.journal('run-chat-intercepted')).toEqual([
      'chat#0/input',
      'chat#0/beforeModel',
      'chat#0/model',
      'chat#0/afterModel',
    ]);
  });

  it('journals app-level tool middleware without re-running on replay', async () => {
    let beforeCalls = 0;
    let afterCalls = 0;
    let toolCalls = 0;
    const assistant = agent('tool-intercepted')
      .tool('lookup', {
        execute: async ({ query }) => {
          toolCalls++;
          return `result:${query}`;
        },
      })
      .assistant('reply', () => ({
        content: 'need tool',
        toolCalls: [
          {
            id: 'call-1',
            name: 'lookup',
            arguments: { query: 'original' },
          },
        ],
      }))
      .runTools('tools')
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { intercepted: assistant },
      store: memoryStore(),
      middleware: [
        Middleware.create({
          name: 'toolPolicy',
          beforeTool: ({ request }) => {
            beforeCalls++;
            const call = request as {
              id: string;
              name: string;
              arguments: Record<string, unknown>;
            };
            return {
              request: {
                ...call,
                arguments: { ...call.arguments, query: 'rewritten' },
              },
              session: {
                vars: { beforeTool: beforeCalls },
              },
            };
          },
          afterTool: ({ result }) => {
            afterCalls++;
            const message = result as { content: string };
            return {
              result: {
                ...message,
                content: `${message.content}:after:${afterCalls}`,
              },
              session: {
                vars: { afterTool: afterCalls },
              },
            };
          },
        }),
      ],
    });

    const first = await app.run({
      agent: 'intercepted',
      runId: 'run-tool-intercepted',
      durable: true,
    });
    const replay = await app.resume('run-tool-intercepted');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()).toMatchObject({
      type: 'tool_result',
      content: 'result:rewritten:after:1',
      attrs: { toolCallId: 'call-1' },
    });
    expect(replay.session.getVarsObject()).toEqual({
      beforeTool: 1,
      afterTool: 1,
    });
    expect(beforeCalls).toBe(1);
    expect(afterCalls).toBe(1);
    expect(toolCalls).toBe(1);
    expect(app.journal('run-tool-intercepted')).toEqual([
      'reply/model',
      'tools/call-1/beforeTool',
      'tools/call-1',
      'tools/call-1/afterTool',
    ]);
  });

  it('journals durable wrapToolCall middleware that replaces tool execution', async () => {
    let wrapperCalls = 0;
    let toolCalls = 0;
    const assistant = agent('wrapped-tool')
      .tool('write', {
        activity: {
          kind: 'external-write',
          idempotencyKey: 'write:call-1',
        },
        execute: async () => {
          toolCalls++;
          return 'should not run';
        },
      })
      .assistant('reply', () => ({
        content: 'need tool',
        toolCalls: [
          {
            id: 'call-1',
            name: 'write',
            arguments: { value: 'danger' },
          },
        ],
      }))
      .runTools('tools')
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { wrapped: assistant },
      store: memoryStore(),
      middleware: [
        Middleware.create({
          name: 'toolWrapper',
          wrapToolCall: ({ request }) => {
            wrapperCalls++;
            const call = request as { id: string; name: string };
            return {
              request: {
                ...call,
                name: `denied-${call.name}`,
              },
              result: {
                type: 'tool_result',
                content: `denied:${call.name}:${wrapperCalls}`,
                attrs: { toolCallId: call.id },
              },
              session: {
                vars: { deniedTool: call.name },
              },
            };
          },
          afterTool: ({ request, result }) => {
            const call = request as { name: string };
            const message = result as { content: string };
            return {
              result: {
                ...message,
                content: `${message.content}:after:${call.name}`,
              },
              session: {
                vars: { afterToolRequest: call.name },
              },
            };
          },
        }),
      ],
    });

    const first = await app.run({
      agent: 'wrapped',
      runId: 'run-wrap-tool',
      durable: true,
    });
    const replay = await app.resume('run-wrap-tool');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()).toMatchObject({
      type: 'tool_result',
      content: 'denied:write:1:after:denied-write',
      attrs: { toolCallId: 'call-1' },
    });
    expect(replay.session.getVarsObject()).toEqual({
      deniedTool: 'write',
      afterToolRequest: 'denied-write',
    });
    expect(wrapperCalls).toBe(1);
    expect(toolCalls).toBe(0);
    expect(app.journal('run-wrap-tool')).toEqual([
      'reply/model',
      'tools/call-1/wrapToolCall',
      'tools/call-1/afterTool',
    ]);
  });

  it('replays durable effects inside tool bodies after a mid-tool crash', async () => {
    let toolCalls = 0;
    let memoCalls = 0;
    let activityCalls = 0;
    const assistant = agent('tool-effects')
      .tool('lookup', {
        execute: async (_args, { durable }) => {
          toolCalls++;
          const token = await durable.memo('token', () => {
            memoCalls++;
            return `token:${memoCalls}`;
          });
          const profile = await durable.activity(
            'read-profile',
            { kind: 'external-read' },
            () => {
              activityCalls++;
              return `profile:${activityCalls}`;
            },
          );
          if (toolCalls === 1) {
            throw new Error('tool crash');
          }
          return `${token}:${profile}:tool:${toolCalls}`;
        },
      })
      .turn('main', (turn) =>
        turn
          .steer()
          .assistant('reply', () => ({
            content: 'need tool',
            toolCalls: [
              {
                id: 'call-1',
                name: 'lookup',
                arguments: {},
              },
            ],
          }))
          .runTools('tools')
          .awaitUser(),
      );
    const app = PromptTrail.app({
      agents: { tools: assistant },
      store: memoryStore(),
    });

    await expect(
      app.run({
        agent: 'tools',
        runId: 'run-tool-effects',
        input: 'hello',
        durable: true,
      }),
    ).rejects.toThrow('tool crash');

    expect(app.journal('run-tool-effects')).toEqual([
      'main/steer/peek',
      'main/reply/model',
      'main/tools/call-1/tool/lookup/memo/token',
      'main/tools/call-1/tool/lookup/activity/read-profile',
    ]);

    const replay = await app.resume('run-tool-effects');

    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()).toMatchObject({
      type: 'tool_result',
      content: 'token:1:profile:1:tool:2',
      attrs: { toolCallId: 'call-1' },
    });
    expect(toolCalls).toBe(2);
    expect(memoCalls).toBe(1);
    expect(activityCalls).toBe(1);
    expect(app.journal('run-tool-effects')).toEqual([
      'main/steer/peek',
      'main/reply/model',
      'main/tools/call-1/tool/lookup/memo/token',
      'main/tools/call-1/tool/lookup/activity/read-profile',
      'main/tools/call-1',
    ]);
  });

  it('does not re-run wrapped tools after a post-next crash', async () => {
    let wrapperCalls = 0;
    let toolCalls = 0;
    const assistant = agent('crashy-wrapped-tool')
      .tool('write', {
        activity: {
          kind: 'external-write',
          idempotencyKey: 'write:call-1',
        },
        execute: async () => {
          toolCalls++;
          return `tool:${toolCalls}`;
        },
      })
      .assistant('reply', () => ({
        content: 'need tool',
        toolCalls: [
          {
            id: 'call-1',
            name: 'write',
            arguments: { value: 'danger' },
          },
        ],
      }))
      .runTools('tools')
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { wrapped: assistant },
      store: memoryStore(),
      middleware: [
        Middleware.create({
          name: 'crashyToolWrapper',
          wrapToolCall: async (_context, next) => {
            wrapperCalls++;
            const result = await next();
            if (wrapperCalls === 1) {
              throw new Error('post-next tool crash');
            }
            return `${result}:wrapper:${wrapperCalls}`;
          },
        }),
      ],
    });

    await expect(
      app.run({
        agent: 'wrapped',
        runId: 'run-wrap-tool-crash',
        durable: true,
      }),
    ).rejects.toThrow('post-next tool crash');

    expect(app.journal('run-wrap-tool-crash')).toEqual([
      'reply/model',
      'tools/call-1/wrapToolCall/next/0',
    ]);

    const replay = await app.resume('run-wrap-tool-crash');

    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()).toMatchObject({
      type: 'tool_result',
      content: 'tool:1:wrapper:2',
      attrs: { toolCallId: 'call-1' },
    });
    expect(wrapperCalls).toBe(2);
    expect(toolCalls).toBe(1);
    expect(app.journal('run-wrap-tool-crash')).toEqual([
      'reply/model',
      'tools/call-1/wrapToolCall/next/0',
      'tools/call-1/wrapToolCall',
    ]);
  });

  it('rejects unsupported commands from durable patch transitions', async () => {
    const assistant = agent('patch-command').patch('pause', () => ({
      command: { type: 'suspend', reason: 'manual' },
    }));
    const app = PromptTrail.app({ store: memoryStore() });

    await expect(
      app.run({
        agent: assistant,
        runId: 'run-patch-command',
        durable: true,
      }),
    ).rejects.toThrow(
      'Durable patch pause returned unsupported command suspend.',
    );
    expect(app.journal('run-patch-command')).toEqual([]);
  });

  it('journals middlewareState writes from durable patch transitions', async () => {
    let patchCalls = 0;
    const assistant = agent('patch-middleware-state')
      .patch('state', () => {
        patchCalls++;
        return {
          session: {
            middlewareState: {
              local: `token:${patchCalls}`,
            },
          },
        };
      })
      .turn('main', (turn) =>
        turn
          .steer()
          .assistant(
            'reply',
            (session) => `model:${session.getVarsObject().local}`,
          )
          .awaitUser(),
      );
    const app = PromptTrail.app({
      store: memoryStore(),
      middleware: [
        Middleware.create({
          name: 'state-reader',
          beforeModel: ({ middlewareState }) => ({
            session: {
              vars: {
                local: middlewareState.local,
              },
            },
          }),
        }),
      ],
    });

    const first = await app.run({
      agent: assistant,
      runId: 'run-patch-middleware-state',
      durable: true,
    });
    const replay = await app.resume('run-patch-middleware-state');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()?.content).toBe('model:token:1');
    expect(replay.session.getVarsObject()).toEqual({ local: 'token:1' });
    expect(patchCalls).toBe(1);
    expect(app.journal('run-patch-middleware-state')).toEqual([
      'state/transition',
      'main/steer/peek',
      'main/reply/beforeModel',
      'main/reply/model',
    ]);
  });

  it('can run ephemeral executions without persisting them', async () => {
    const assistant = agent('ephemeral').assistant('reply', () => 'hello');
    const app = PromptTrail.app({ agents: { assistant } });

    const result = await app.run({
      agent: 'assistant',
      input: 'ignored',
    });

    expect(result.status).toBe('done');
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'hello',
    ]);
    expect(() => app.journal(result.runId)).toThrow('Unknown durable run');
  });

  it('emits durable app lifecycle observer events across resume', async () => {
    const events: string[] = [];
    const assistant = agent('observed')
      .assistant('reply', () => 'hello')
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { observed: assistant },
      observers: [
        (event) => {
          if (!event.type.startsWith('run.')) {
            return;
          }
          events.push(
            `${event.seq}:${event.type}:${event.stepId ?? '-'}:${event.sessionVersion ?? '-'}`,
          );
        },
      ],
      store: memoryStore(),
    });

    const first = await app.run({
      agent: 'observed',
      runId: 'run-observed',
      durable: true,
    });
    const second = await app.send({
      runId: 'run-observed',
      input: 'continue',
    });

    expect(first.status).toBe('suspended');
    expect(second.status).toBe('done');
    expect(events).toEqual([
      '0:run.started:-:0',
      '3:run.suspended:wait/input/input:0',
      '4:run.started:-:0',
      '5:run.completed:-:0',
    ]);
  });

  it('journals onSuspend and onResume hooks around awaitUser', async () => {
    let suspendCalls = 0;
    let resumeCalls = 0;
    const assistant = agent('await-hooks').turn('main', (turn) =>
      turn
        .awaitUser()
        .assistant(
          'reply',
          (session) =>
            `seen:${session.getVarsObject().suspended}:${session.getVarsObject().resumed}:${session.getLastMessage()?.content}`,
        ),
    );
    const app = PromptTrail.app({
      agents: { hooks: assistant },
      hooks: [
        Hook.create({
          name: 'awaitLifecycle',
          onSuspend: ({ request }) => {
            suspendCalls++;
            return {
              session: {
                vars: {
                  suspended: `${(request as { stepId: string }).stepId}:${suspendCalls}`,
                },
              },
            };
          },
          onResume: ({ request }) => {
            resumeCalls++;
            return {
              session: {
                vars: {
                  resumed: `${(request as { stepId: string }).stepId}:${resumeCalls}`,
                },
              },
            };
          },
        }),
      ],
      store: memoryStore(),
    });

    const suspended = await app.run({
      agent: 'hooks',
      runId: 'run-await-hooks',
      durable: true,
    });
    const stillSuspended = await app.resume('run-await-hooks');
    const completed = await app.send({
      runId: 'run-await-hooks',
      input: 'hello',
    });

    expect(suspended.status).toBe('suspended');
    expect(stillSuspended.status).toBe('suspended');
    expect(completed.status).toBe('done');
    expect(suspended.session.getVarsObject()).toEqual({
      suspended: 'main/input/input:1',
    });
    expect(stillSuspended.session.getVarsObject()).toEqual({
      suspended: 'main/input/input:1',
    });
    expect(completed.session.getLastMessage()?.content).toBe(
      'seen:main/input/input:1:main/input/input:1:hello',
    );
    expect(suspendCalls).toBe(1);
    expect(resumeCalls).toBe(1);
    expect(app.journal('run-await-hooks')).toEqual([
      'main/input/input/onSuspend',
      'main/input/input/onResume',
      'main/input/input',
      'main/reply/model',
    ]);
  });

  it('emits durable model observer events only for live model execution', async () => {
    const events: string[] = [];
    let modelCalls = 0;
    const assistant = agent('model-observed')
      .assistant('reply', () => {
        modelCalls++;
        return `model:${modelCalls}`;
      })
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { observed: assistant },
      observers: [
        (event) => {
          if (
            event.type.startsWith('model.') ||
            event.type.startsWith('run.')
          ) {
            events.push(`${event.seq}:${event.type}:${event.stepId ?? '-'}`);
          }
        },
      ],
      store: memoryStore(),
    });

    const first = await app.run({
      agent: 'observed',
      runId: 'run-model-observed',
      durable: true,
    });
    const replay = await app.resume('run-model-observed');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(modelCalls).toBe(1);
    expect(events).toEqual([
      '0:run.started:-',
      '1:model.started:reply/model',
      '2:model.completed:reply/model',
      '3:run.suspended:wait/input/input',
      '4:run.started:-',
      '5:run.suspended:wait/input/input',
    ]);
  });

  it('does not let model observer failures re-run durable models', async () => {
    let modelCalls = 0;
    const assistant = agent('model-observer-failure')
      .assistant('reply', () => {
        modelCalls++;
        return `model:${modelCalls}`;
      })
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { observed: assistant },
      observers: [
        {
          name: 'failingModelProgress',
          handle(event) {
            if (event.type === 'model.completed') {
              throw new Error('model progress failed');
            }
          },
        },
      ],
      strictObservers: true,
      store: memoryStore(),
    });

    const first = await app.run({
      agent: 'observed',
      runId: 'run-model-observer-failure',
      durable: true,
    });
    const replay = await app.resume('run-model-observer-failure');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(modelCalls).toBe(1);
    expect(app.journal('run-model-observer-failure')).toEqual(['reply/model']);
  });

  it('threads durable app execution context into middleware and tools', async () => {
    const toolContexts: unknown[] = [];
    const assistant = agent('contextual')
      .tool('readContext', {
        execute: async (_args, context) => {
          toolContexts.push(context.context);
          return `tool:${(context.context as { requestId: string }).requestId}`;
        },
      })
      .assistant('reply', (session) => ({
        content: `ctx:${session.getVarsObject().channel}`,
        toolCalls: [
          {
            id: 'call-1',
            name: 'readContext',
            arguments: {},
          },
        ],
      }))
      .runTools('tools')
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { contextual: assistant },
      middleware: [
        Middleware.create({
          name: 'contextReader',
          beforeModel: ({ context }) => ({
            session: {
              vars: {
                channel: (context as { channel: string }).channel,
              },
            },
          }),
        }),
      ],
      store: memoryStore(),
    });

    const first = await app.run({
      agent: 'contextual',
      runId: 'run-contextual',
      durable: true,
      context: {
        channel: 'claw-test',
        requestId: 'req-1',
      },
    });
    const replay = await app.resume('run-contextual');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(replay.session.getLastMessage()).toMatchObject({
      type: 'tool_result',
      content: 'tool:req-1',
    });
    expect(toolContexts).toEqual([
      {
        channel: 'claw-test',
        requestId: 'req-1',
      },
    ]);
  });

  it('can surface durable app observer failures in strict mode', async () => {
    const assistant = agent('strict-observed').assistant(
      'reply',
      () => 'hello',
    );
    const app = PromptTrail.app({
      agents: { observed: assistant },
      observers: [
        {
          name: 'failing',
          handle(event) {
            if (event.type === 'run.started') {
              throw new Error('observer broke');
            }
          },
        },
      ],
      strictObservers: true,
      store: memoryStore(),
    });

    await expect(
      app.run({
        agent: 'observed',
        runId: 'run-strict-observer',
        durable: true,
      }),
    ).rejects.toThrow('observer broke');
  });

  it('emits durable tool observer events only for live tool execution', async () => {
    const events: string[] = [];
    let toolCalls = 0;
    const assistant = agent('tool-observed')
      .tool('lookup', {
        execute: async ({ query }) => {
          toolCalls++;
          return `result:${query}`;
        },
      })
      .assistant('reply', () => ({
        content: 'need tool',
        toolCalls: [
          {
            id: 'call-1',
            name: 'lookup',
            arguments: { query: 'hello' },
          },
        ],
      }))
      .runTools('tools')
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { observed: assistant },
      observers: [
        (event) => {
          if (event.type.startsWith('tool.') || event.type.startsWith('run.')) {
            events.push(
              `${event.seq}:${event.type}:${event.stepId ?? '-'}:${event.name ?? '-'}`,
            );
          }
        },
      ],
      store: memoryStore(),
    });

    const first = await app.run({
      agent: 'observed',
      runId: 'run-tool-observed',
      durable: true,
    });
    const replay = await app.resume('run-tool-observed');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(toolCalls).toBe(1);
    expect(events).toEqual([
      '0:run.started:-:-',
      '3:tool.started:tools/call-1:lookup',
      '4:tool.completed:tools/call-1:lookup',
      '5:run.suspended:wait/input/input:-',
      '6:run.started:-:-',
      '7:run.suspended:wait/input/input:-',
    ]);
  });

  it('does not let tool observer failures re-run durable tools', async () => {
    let toolCalls = 0;
    const assistant = agent('tool-observer-failure')
      .tool('write', {
        activity: {
          kind: 'external-write',
          idempotencyKey: 'write:call-1',
        },
        execute: async () => {
          toolCalls++;
          return `write:${toolCalls}`;
        },
      })
      .assistant('reply', () => ({
        content: 'need tool',
        toolCalls: [
          {
            id: 'call-1',
            name: 'write',
            arguments: {},
          },
        ],
      }))
      .runTools('tools')
      .turn('wait', (turn) => turn.awaitUser());
    const app = PromptTrail.app({
      agents: { observed: assistant },
      observers: [
        {
          name: 'failingProgress',
          handle(event) {
            if (event.type === 'tool.completed') {
              throw new Error('progress failed');
            }
          },
        },
      ],
      strictObservers: true,
      store: memoryStore(),
    });

    const first = await app.run({
      agent: 'observed',
      runId: 'run-tool-observer-failure',
      durable: true,
    });
    const replay = await app.resume('run-tool-observer-failure');

    expect(first.status).toBe('suspended');
    expect(replay.status).toBe('suspended');
    expect(toolCalls).toBe(1);
    expect(app.journal('run-tool-observer-failure')).toEqual([
      'reply/model',
      'tools/call-1',
    ]);
  });

  it('throws NondeterminismError for mismatched journal order', async () => {
    const store = memoryStore();
    const app = PromptTrail.app({ store });
    const stable = agent('stable')
      .system('System')
      .assistant('a', () => 'A');

    await app.run({
      agent: stable,
      runId: 'run-5',
      durable: true,
    });

    const run = store.get('run-5')!;
    run.agent = agent('changed')
      .system('System')
      .assistant('b', () => 'B');
    run.status = 'open';
    run.result = undefined;

    await expect(app.resume('run-5')).rejects.toBeInstanceOf(
      NondeterminismError,
    );
  });

  it('throws NondeterminismError when middleware order changes on replay', async () => {
    const store = memoryStore();
    const assistant = agent('ordered-middleware')
      .assistant(
        'reply',
        (session) =>
          `model:${session.getVarsObject().first}:${session.getVarsObject().second}`,
      )
      .turn('wait', (turn) => turn.awaitUser());
    const first = Middleware.create({
      name: 'first',
      beforeModel: () => ({
        session: { vars: { first: true } },
      }),
    });
    const second = Middleware.create({
      name: 'second',
      beforeModel: () => ({
        session: { vars: { second: true } },
      }),
    });
    const app = PromptTrail.app({
      agents: { ordered: assistant },
      store,
      middleware: [first, second],
    });

    const run = await app.run({
      agent: 'ordered',
      runId: 'run-middleware-order',
      durable: true,
    });

    expect(run.status).toBe('suspended');
    expect(app.journal('run-middleware-order')).toEqual([
      'reply/beforeModel',
      'reply/model',
    ]);

    const reordered = PromptTrail.app({
      agents: { ordered: assistant },
      store,
      middleware: [second, first],
    });

    await expect(
      reordered.resume('run-middleware-order'),
    ).rejects.toBeInstanceOf(NondeterminismError);
  });

  it('routes events from app sources into durable runs', async () => {
    const source = manualSource();
    const assistant = agent('assistant')
      .system('System')
      .turn('main', (turn) =>
        turn
          .steer()
          .assistant(
            'reply',
            (session) => `seen:${session.getMessagesByType('user').length}`,
          )
          .awaitUser(),
      );
    const app = PromptTrail.app({
      agents: { assistant },
      sources: { manual: source },
      store: memoryStore(),
    });

    await app.start();
    await source.emit({
      source: 'manual',
      agent: 'assistant',
      runId: 'run-6',
      input: 'hello',
      durable: true,
    });

    const result = await app.resume('run-6');

    expect(result.status).toBe('suspended');
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'System',
      'hello',
      'seen:1',
    ]);
  });

  it('keeps MemoryDurableRuntime as a compatibility wrapper', async () => {
    const runtime = new MemoryDurableRuntime();
    const assistant = agent('assistant')
      .assistant('reply', () => 'hello')
      .turn('wait', (turn) => turn.awaitUser());

    const result = await runtime.start(assistant, {
      runId: 'compat',
    });

    expect(result.status).toBe('suspended');
    expect(runtime.journal('compat')).toEqual(['reply/model']);
  });
});
