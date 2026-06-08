import { describe, expect, it } from 'vitest';
import { PromptTrail, agent, memoryStore } from '../../durable';
import { Middleware } from '../../interceptors';
import {
  bind,
  discord,
  type DeliveryTarget,
  type DiscordMessageEvent,
} from '../../runtime_bindings';
import { Agent } from '../../templates';
import {
  assistantDeliveryKey,
  dispatchRuntimeBindingEvent,
  mergeBindingDefaults,
} from '../../runtime_dispatch';
import {
  type RuntimeAdapter,
  type RuntimeSourceContext,
} from '../../runtime_server';
import type { ObserverDeliveryBindingStore } from '../../execution';

function discordDeliveryTarget(channel: string, thread?: string) {
  return {
    platform: 'discord' as const,
    channel,
    thread,
  };
}

describe('RuntimeServer', () => {
  it('includes stable delivery targets in assistant delivery keys', () => {
    const conversationId = 'discord:guild:workroom:channel:C_general';
    const target = discordDeliveryTarget('general', 'T_debug');
    const reorderedTarget = {
      thread: 'T_debug',
      channel: 'general',
      platform: 'discord',
    } as DeliveryTarget;
    const otherTarget = discordDeliveryTarget('cloud-lab', 'T_debug');

    expect(assistantDeliveryKey(conversationId, 0, target)).toBe(
      assistantDeliveryKey(conversationId, 0, reorderedTarget),
    );
    expect(assistantDeliveryKey(conversationId, 0, target)).not.toBe(
      assistantDeliveryKey(conversationId, 0, otherTarget),
    );
  });

  it('keeps assistant delivery keys stable across JSON target round-trips', () => {
    const conversationId = 'discord:guild:workroom:channel:C_general';
    const targetWithUndefinedThread = discordDeliveryTarget('general');
    const roundTrippedTarget = JSON.parse(
      JSON.stringify(targetWithUndefinedThread),
    ) as DeliveryTarget;

    expect(
      assistantDeliveryKey(conversationId, 0, targetWithUndefinedThread),
    ).toBe(assistantDeliveryKey(conversationId, 0, roundTrippedTarget));
  });

  it('routes adapter source events through bindings and delivery drivers', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const activityEvents: string[] = [];
    const observerEvents: string[] = [];
    const deliveryEventRaw: unknown[] = [];
    const returnedBinding = { messageId: 'M_reply' };
    const observerWrites: string[] = [];
    const observerDeliveryBindingStore: ObserverDeliveryBindingStore = {
      claim(idempotencyKey, binding) {
        observerWrites.push(`claim:${idempotencyKey}:${binding.value}`);
        return true;
      },
      complete(idempotencyKey, binding) {
        observerWrites.push(`complete:${idempotencyKey}:${binding.value}`);
      },
      delete() {},
    };
    const main = agent('main').chat('chat', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: { main },
      middleware: [
        Middleware.create({
          name: 'mutatingDeliveryContext',
          beforeModel: ({ context }) => {
            const delivery = (
              context as {
                delivery?: { channel?: string };
              }
            ).delivery;
            if (delivery) {
              delivery.channel = 'middleware-mutated';
            }
          },
        }),
      ],
    });
    const bundle = PromptTrail.bundle({
      name: 'server-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const adapter: RuntimeAdapter = {
      name: 'test-discord',
      sources: [
        {
          type: 'discord.messages',
          start(ctx) {
            emit = ctx.emit;
          },
        },
      ],
      deliveries: [
        {
          platform: 'discord',
          deliver(_ctx, target, message) {
            const discordTarget = target as { channel: string };
            deliveries.push(`${discordTarget.channel}:${message.content}`);
            discordTarget.channel = 'driver-mutated';
            return returnedBinding;
          },
        },
      ],
      activities: [
        {
          platform: 'discord',
          start() {
            activityEvents.push('start');
            return {
              stop() {
                activityEvents.push('stop');
              },
            };
          },
        },
      ],
    };
    const server = PromptTrail.server({
      bundle,
      runtime: app,
      activity: { kind: 'typing' },
      observerDeliveryBindings: {
        deliveryBindingStore: observerDeliveryBindingStore,
      },
      observers: [
        async (event, context) => {
          if (
            event.type !== 'delivery.pending' &&
            event.type !== 'delivery.completed' &&
            event.type !== 'model.started'
          ) {
            return;
          }
          observerEvents.push(
            `${event.seq}:${event.type}:${event.idempotencyKey}`,
          );
          if (
            event.type === 'delivery.pending' ||
            event.type === 'delivery.completed'
          ) {
            deliveryEventRaw.push(structuredClone(event.raw));
          }
          if (event.type === 'model.started') {
            await context.deliveryBindings?.checkWrite(
              event.idempotencyKey ?? event.id,
              () => 'app',
            );
          }
          if (event.type === 'delivery.pending') {
            await context.deliveryBindings?.checkWrite(
              event.idempotencyKey,
              () => 'server',
            );
          }
        },
        async (event, context) => {
          if (event.type !== 'model.started') {
            return;
          }
          await context.deliveryBindings?.checkWrite(
            event.idempotencyKey ?? event.id,
            () => 'app-second',
          );
        },
        (event, context) => {
          if (event.type !== 'delivery.completed') {
            return;
          }
          const raw = event.raw as {
            delivery?: { platform?: string; channel?: string };
            platformBinding?: { messageId?: string };
            deliveryAttempt?: {
              platformBinding?: { messageId?: string };
            };
          };
          if (raw.delivery) {
            raw.delivery.platform = 'observer-mutated';
            raw.delivery.channel = 'observer-mutated';
          }
          if (raw.platformBinding) {
            raw.platformBinding.messageId = 'observer-mutated';
          }
          if (raw.deliveryAttempt?.platformBinding) {
            raw.deliveryAttempt.platformBinding.messageId =
              'observer-mutated-attempt';
          }
          const delivery = context.delivery as
            | { platform?: string; channel?: string }
            | undefined;
          if (delivery) {
            delivery.platform = 'context-mutated';
            delivery.channel = 'context-mutated';
          }
        },
      ],
      adapters: [adapter],
    });

    await server.start();
    await emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello',
    });

    const conversationId =
      'discord:guild:workroom:channel:C_general:user:U_alice';
    const finalDeliveryKey = assistantDeliveryKey(
      conversationId,
      0,
      discordDeliveryTarget('general'),
    );

    expect(activityEvents).toEqual(['start', 'stop']);
    expect(deliveries).toEqual(['general:reply:hello']);
    expect(observerEvents).toEqual([
      '1:model.started:discord:guild:workroom:channel:C_general:user:U_alice:chat#0/model:model:model.started:-',
      `0:delivery.pending:${finalDeliveryKey}`,
      `1:delivery.completed:${finalDeliveryKey}`,
    ]);
    expect(deliveryEventRaw).toEqual([
      expect.objectContaining({
        assistantIndex: 0,
        messageRef: {
          conversationId,
          assistantIndex: 0,
        },
        platformBinding: undefined,
        deliveryAttempt: expect.objectContaining({
          idempotencyKey: finalDeliveryKey,
          assistantIndex: 0,
          messageRef: {
            conversationId,
            assistantIndex: 0,
          },
          platformBinding: undefined,
        }),
      }),
      expect.objectContaining({
        assistantIndex: 0,
        messageRef: {
          conversationId,
          assistantIndex: 0,
        },
        platformBinding: { messageId: 'M_reply' },
        deliveryAttempt: expect.objectContaining({
          idempotencyKey: finalDeliveryKey,
          assistantIndex: 0,
          messageRef: {
            conversationId,
            assistantIndex: 0,
          },
          platformBinding: { messageId: 'M_reply' },
        }),
      }),
    ]);
    returnedBinding.messageId = 'driver-retained-mutated';
    expect(
      app.assistantDeliveryOutbox(conversationId).map((entry) => ({
        platformBinding: entry.platformBinding,
        target: entry.target,
      })),
    ).toEqual([
      {
        platformBinding: { messageId: 'M_reply' },
        target: expect.objectContaining({
          platform: 'discord',
          channel: 'general',
        }),
      },
    ]);
    expect(app.pendingAssistantDeliveryOutbox()).toEqual([]);
    expect(observerWrites).toEqual([
      'claim:["runtimeObserver:0","discord:guild:workroom:channel:C_general:user:U_alice:chat#0/model:model:model.started:-"]:undefined',
      'complete:["runtimeObserver:0","discord:guild:workroom:channel:C_general:user:U_alice:chat#0/model:model:model.started:-"]:app',
      'claim:["runtimeObserver:1","discord:guild:workroom:channel:C_general:user:U_alice:chat#0/model:model:model.started:-"]:undefined',
      'complete:["runtimeObserver:1","discord:guild:workroom:channel:C_general:user:U_alice:chat#0/model:model:model.started:-"]:app-second',
      `claim:["runtimeObserver:0","${finalDeliveryKey}"]:undefined`,
      `complete:["runtimeObserver:0","${finalDeliveryKey}"]:server`,
    ]);
  });

  it('routes runtime bundle events to registered Agent graphs', async () => {
    const main = Agent.create('main')
      .user('inbound')
      .assistant('reply', (session) => ({
        content: `reply:${session.getLastMessage()?.content ?? ''}`,
      }));
    const bundle = PromptTrail.bundle({
      name: 'graph-runtime',
      defaults: { durable: false },
      bindings: [
        bind(discord.messages())
          .to(main)
          .conversation(() => 'discord:graph'),
      ],
    });
    const app = PromptTrail.app({
      agents: bundle.agents,
    });
    const result = await dispatchRuntimeBindingEvent({
      app,
      binding: bundle.bindings[0]!,
      event: {
        source: 'discord',
        guild: 'workroom',
        channel: 'general',
        channelId: 'C_general',
        author: 'alice',
        authorId: 'U_alice',
        authorBot: false,
        content: 'hello',
      },
      defaults: mergeBindingDefaults(
        bundle.defaults,
        bundle.bindings[0]!.defaults,
      ),
    });

    expect(result.result.status).toBe('done');
    expect(result.result.runId).toBe('discord:graph');
    expect(
      result.result.session.messages.map((message) => message.content),
    ).toEqual(['hello', 'reply:hello']);
  });

  it('registers Agent instances from runtime bindings into bundles', () => {
    const main = Agent.create('main').assistant('reply', () => 'reply');
    const durable = agent('durable');
    const bundle = PromptTrail.bundle({
      name: 'binding-agent-registration',
      bindings: [
        bind(discord.messages())
          .to(main)
          .conversation(() => 'discord:graph'),
        bind(discord.messages())
          .to(durable)
          .conversation(() => 'discord:durable'),
      ],
    });

    expect(bundle.agents.main).toBe(main);
    expect(bundle.agents.durable).toBe(durable);
    expect(bundle.bindings.map((binding) => binding.agent)).toEqual([
      'main',
      'durable',
    ]);
  });

  it('compiles app bindings into runtime bundles', async () => {
    const main = Agent.create('main')
      .user('inbound')
      .assistant('reply', (session) => ({
        content: `reply:${session.getLastMessage()?.content ?? ''}`,
      }));
    const app = PromptTrail.app({
      name: 'graph-runtime-app',
      defaults: {
        durable: false,
        context: { appScope: 'runtime-app' },
      },
    }).bind(discord.messages(), (binding) => {
      binding
        .to(main)
        .conversation(() => 'discord:graph')
        .delivery(discord.channel('general'))
        .context((event) => ({
          bindingScope: 'discord-message',
          channelId: event.channelId,
        }));
    });
    const bundle = app.bundle();
    const result = await dispatchRuntimeBindingEvent({
      app,
      binding: bundle.bindings[0]!,
      event: {
        source: 'discord',
        guild: 'workroom',
        channel: 'general',
        channelId: 'C_general',
        author: 'alice',
        authorId: 'U_alice',
        authorBot: false,
        content: 'hello',
      },
      defaults: mergeBindingDefaults(
        bundle.defaults,
        bundle.bindings[0]!.defaults,
      ),
    });

    expect(bundle.name).toBe('graph-runtime-app');
    expect(bundle.agents.main).toBe(main);
    expect(bundle.bindings[0]!.agent).toBe('main');
    expect(bundle.bindings[0]!.defaults.delivery).toEqual(
      discord.channel('general'),
    );
    expect(result.context).toEqual(
      expect.objectContaining({
        appScope: 'runtime-app',
        bindingScope: 'discord-message',
        channelId: 'C_general',
        delivery: discord.channel('general'),
      }),
    );
    expect(
      result.result.session.messages.map((message) => message.content),
    ).toEqual(['hello', 'reply:hello']);
  });

  it('starts runtime adapter sources from app instances', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const activityEvents: string[] = [];
    const sourceEvents: string[] = [];
    const main = Agent.create('main')
      .user('inbound')
      .assistant('reply', (session) => ({
        content: `reply:${session.getLastMessage()?.content ?? ''}`,
      }));
    const app = PromptTrail.app({
      name: 'app-start-runtime',
      defaults: { durable: false },
    })
      .source({
        type: 'discord.messages',
        start(ctx) {
          sourceEvents.push('start');
          emit = ctx.emit;
        },
        stop() {
          sourceEvents.push('stop');
        },
      })
      .delivery({
        platform: 'discord',
        deliver(_ctx, target, message) {
          deliveries.push(`${target.channel}:${message.content}`);
        },
      })
      .activity({
        platform: 'discord',
        start(_ctx, target) {
          activityEvents.push(`start:${target.channel}`);
          return {
            stop() {
              activityEvents.push('stop');
            },
          };
        },
      })
      .bind(discord.messages(), (binding) =>
        binding
          .to(main)
          .conversation(() => 'discord:app-start')
          .delivery(discord.channel('general')),
      );

    await app.start();
    if (!emit) {
      throw new Error('Runtime source did not start.');
    }
    await emit({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      mentionsBot: true,
      content: 'hello',
    });
    await app.stop();

    expect(sourceEvents).toEqual(['start', 'stop']);
    expect(activityEvents).toEqual(['start:general', 'stop']);
    expect(deliveries).toEqual(['general:reply:hello']);
  });

  it('registers named Agent instances directly on apps', async () => {
    const main = Agent.create('main')
      .user('inbound')
      .assistant('reply', (session) => ({
        content: `reply:${session.getLastMessage()?.content ?? ''}`,
      }));
    const app = PromptTrail.app().agent(main);
    const result = await app.run({
      agent: 'main',
      runId: 'app-agent-instance',
      input: 'hello',
      durable: false,
    });

    expect(result.session.messages.map((message) => message.content)).toEqual([
      'hello',
      'reply:hello',
    ]);
  });

  it('registers DurableAgent instances directly on apps', async () => {
    const durable = agent('durable').assistant('reply', () => 'ok');
    const app = PromptTrail.app().agent(durable);
    const result = await app.run({
      agent: 'durable',
      runId: 'app-durable-agent-instance',
      durable: false,
    });

    expect(result.session.getLastMessage()?.content).toBe('ok');
  });

  it('rejects unnamed Agent instances registered directly on apps', () => {
    expect(() => PromptTrail.app().agent(Agent.quick())).toThrow(
      /Agent\.create\(name\)/,
    );
  });

  it('keeps runtime bundle Agent graph runs ephemeral-only for now', async () => {
    const main = Agent.create('main').assistant('reply', () => 'reply');
    const bundle = PromptTrail.bundle({
      name: 'durable-graph-runtime',
      agents: { main },
      bindings: [
        bind(discord.messages())
          .toAgent('main')
          .conversation(() => 'discord:graph'),
      ],
    });
    const app = PromptTrail.app({
      agents: bundle.agents,
    });

    await expect(
      dispatchRuntimeBindingEvent({
        app,
        binding: bundle.bindings[0]!,
        event: {
          source: 'discord',
          guild: 'workroom',
          channel: 'general',
          channelId: 'C_general',
          author: 'alice',
          authorId: 'U_alice',
          authorBot: false,
          content: 'hello',
        },
        defaults: mergeBindingDefaults(
          bundle.defaults,
          bundle.bindings[0]!.defaults,
        ),
      }),
    ).rejects.toThrow(/does not support durable graph Agent runs yet/);
  });

  it('accepts Agent instances in runtime bindings', () => {
    const main = Agent.create('main').assistant('reply', () => 'reply');
    const durable = agent('durable');
    const binding = bind(discord.messages())
      .to(main)
      .conversation(() => 'discord:graph')
      .build();
    const aliasBinding = bind(discord.messages())
      .toAgent(main)
      .conversation(() => 'discord:graph')
      .build();
    const durableBinding = bind(discord.messages())
      .to(durable)
      .conversation(() => 'discord:durable')
      .build();

    expect(binding.agent).toBe('main');
    expect(aliasBinding.agent).toBe('main');
    expect(durableBinding.agent).toBe('durable');
  });

  it('allocates delivery event sequence numbers per conversation', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const deliveryEvents: string[] = [];
    const main = agent('main').chat('chat', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
    const bundle = PromptTrail.bundle({
      name: 'server-delivery-seq-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const server = PromptTrail.server({
      bundle,
      runtime: PromptTrail.app({
        store: memoryStore(),
        agents: bundle.agents,
      }),
      observers: [
        (event) => {
          if (
            event.type === 'delivery.pending' ||
            event.type === 'delivery.completed'
          ) {
            deliveryEvents.push(
              `${event.conversationId}:${event.seq}:${event.type}`,
            );
          }
        },
      ],
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver() {
                return { messageId: 'sent' };
              },
            },
          ],
        },
      ],
    });

    await server.start();
    await emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello alice',
    });
    await emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'bob',
      authorId: 'U_bob',
      authorBot: false,
      content: 'hello bob',
    });

    expect(deliveryEvents).toEqual([
      'discord:guild:workroom:channel:C_general:user:U_alice:0:delivery.pending',
      'discord:guild:workroom:channel:C_general:user:U_alice:1:delivery.completed',
      'discord:guild:workroom:channel:C_general:user:U_bob:0:delivery.pending',
      'discord:guild:workroom:channel:C_general:user:U_bob:1:delivery.completed',
    ]);
  });

  it('uses stable idempotency keys for runtime error delivery', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const main = agent('main').chat('chat', () => {
      throw new Error('handler failed');
    });
    const bundle = PromptTrail.bundle({
      name: 'server-error-delivery-test',
      agents: { main },
      defaults: { durable: false },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const server = PromptTrail.server({
      bundle,
      runtime: PromptTrail.app({
        store: memoryStore(),
        agents: bundle.agents,
      }),
      errorMessage: 'Something failed.',
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver(ctx, _target, message) {
                deliveries.push(
                  `${ctx.conversationId}:${ctx.idempotencyKey}:${message.content}`,
                );
              },
            },
          ],
        },
      ],
    });
    const event: DiscordMessageEvent = {
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello',
    };

    await server.start();
    await emit?.(event);
    await emit?.(event);

    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toBe(deliveries[1]);
    expect(deliveries[0]).toMatch(
      /^discord:guild:workroom:channel:C_general:user:U_alice:runtime-error:[0-9a-f]{8}:Something failed\.$/,
    );
  });

  it('threads runtime binding context into durable middleware', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const middlewareDelivery: unknown[] = [];
    const observerDelivery: unknown[] = [];
    const main = agent('main').chat('chat', (session) => ({
      content: `reply:${session.getVarsObject().channelPrompt}`,
    }));
    const bundle = PromptTrail.bundle({
      name: 'server-context-test',
      agents: { main },
      defaults: {
        durable: true,
        context: {
          channelPrompts: {
            general: 'General channel prompt',
          },
        },
      },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const adapter: RuntimeAdapter = {
      name: 'test-discord',
      sources: [
        {
          type: 'discord.messages',
          start(ctx) {
            emit = ctx.emit;
          },
        },
      ],
      deliveries: [
        {
          platform: 'discord',
          deliver(_ctx, _target, message) {
            deliveries.push(message.content);
          },
        },
      ],
    };
    const server = PromptTrail.server({
      bundle,
      runtime: PromptTrail.app({
        store: memoryStore(),
        agents: bundle.agents,
        middleware: [
          Middleware.create({
            name: 'channelPrompt',
            beforeModel: ({ context }) => {
              middlewareDelivery.push(
                (context as { delivery?: unknown } | undefined)?.delivery,
              );
              return {
                session: {
                  vars: {
                    channelPrompt: (
                      context as { channelPrompt: string | undefined }
                    ).channelPrompt,
                  },
                },
              };
            },
          }),
        ],
        observers: [
          {
            replayPolicy: 'live-only',
            handle(event, context) {
              if (event.type === 'run.started') {
                observerDelivery.push(context.delivery);
              }
            },
          },
        ],
      }),
      adapters: [adapter],
    });

    await server.start();
    await emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello',
    });

    expect(deliveries).toEqual(['reply:General channel prompt']);
    expect(middlewareDelivery).toEqual([undefined]);
    expect(observerDelivery).toEqual([
      { platform: 'discord', channel: 'general', thread: undefined },
    ]);
  });

  it('routes durable tool events to adapter observers', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const observerEvents: string[] = [];
    const main = agent('main')
      .tool('lookup', {
        execute: async () => 'found',
      })
      .assistant('reply', () => ({
        content: 'using tool',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: {} }],
      }))
      .runTools('tools');
    const bundle = PromptTrail.bundle({
      name: 'server-adapter-observer-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const adapter: RuntimeAdapter = {
      name: 'test-discord',
      sources: [
        {
          type: 'discord.messages',
          start(ctx) {
            emit = ctx.emit;
          },
        },
      ],
      deliveries: [
        {
          platform: 'discord',
          deliver() {},
        },
      ],
      observers: [
        {
          name: 'adapterProgress',
          handle(event, context) {
            if (
              event.type !== 'tool.started' &&
              event.type !== 'tool.completed'
            ) {
              return;
            }
            observerEvents.push(
              `${event.type}:${event.name}:${(context.delivery as { platform?: string } | undefined)?.platform}`,
            );
          },
        },
      ],
    };
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const firstServer = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [adapter],
    });
    const secondServer = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [adapter],
    });

    await firstServer.start();
    await secondServer.start();
    await emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello',
    });

    expect(observerEvents).toEqual([
      'tool.started:lookup:discord',
      'tool.completed:lookup:discord',
    ]);
    await firstServer.stop();
    await secondServer.stop();
  });

  it('persists completed final deliveries across server restarts', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const main = agent('main').chat('chat', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
    const bundle = PromptTrail.bundle({
      name: 'server-restart-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const adapter: RuntimeAdapter = {
      name: 'test-discord',
      sources: [
        {
          type: 'discord.messages',
          start(ctx) {
            emit = ctx.emit;
          },
        },
      ],
      deliveries: [
        {
          platform: 'discord',
          deliver(_ctx, _target, message) {
            deliveries.push(message.content);
          },
        },
      ],
    };
    const firstServer = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [adapter],
    });

    await firstServer.start();
    await emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'first',
    });

    const secondServer = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [adapter],
    });

    await secondServer.start();
    await emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'second',
    });

    const conversationId =
      'discord:guild:workroom:channel:C_general:user:U_alice';
    const target = discordDeliveryTarget('general');

    expect(deliveries).toEqual(['reply:first', 'reply:second']);
    expect(
      app.assistantDeliveryOutbox(conversationId).map((entry) => ({
        idempotencyKey: entry.idempotencyKey,
        status: entry.status,
      })),
    ).toEqual([
      {
        idempotencyKey: assistantDeliveryKey(conversationId, 0, target),
        status: 'delivered',
      },
      {
        idempotencyKey: assistantDeliveryKey(conversationId, 1, target),
        status: 'delivered',
      },
    ]);
  });

  it('serializes concurrent dispatches for the same conversation', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstHandlerStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const main = agent('main').chat('chat', async (session) => {
      const content = session.getLastMessage()?.content ?? '';
      order.push(`handler:${content}`);
      if (content === 'first') {
        firstStarted?.();
        await firstCanFinish;
      }
      return `reply:${content}`;
    });
    const bundle = PromptTrail.bundle({
      name: 'server-lock-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const server = PromptTrail.server({
      bundle,
      runtime: PromptTrail.app({
        store: memoryStore(),
        agents: bundle.agents,
      }),
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver(_ctx, _target, message) {
                order.push(`deliver:${message.content}`);
              },
            },
          ],
        },
      ],
    });

    await server.start();
    const first = emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'first',
    });
    await firstHandlerStarted;
    const second = emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'second',
    });

    await Promise.resolve();
    expect(order).toEqual(['handler:first']);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual([
      'handler:first',
      'deliver:reply:first',
      'handler:second',
      'deliver:reply:second',
    ]);
  });

  it('runs concurrent dispatches for different conversations independently', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    let secondStarted: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstHandlerStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondHandlerStarted = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const main = agent('main').chat('chat', async (session) => {
      const content = session.getLastMessage()?.content ?? '';
      order.push(`handler:${content}`);
      if (content === 'first') {
        firstStarted?.();
        await firstCanFinish;
      }
      if (content === 'second') {
        secondStarted?.();
      }
      return `reply:${content}`;
    });
    const bundle = PromptTrail.bundle({
      name: 'server-lock-parallel-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const server = PromptTrail.server({
      bundle,
      runtime: PromptTrail.app({
        store: memoryStore(),
        agents: bundle.agents,
      }),
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver(_ctx, _target, message) {
                order.push(`deliver:${message.content}`);
              },
            },
          ],
        },
      ],
    });

    await server.start();
    const first = emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'first',
    });
    await firstHandlerStarted;
    const second = emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'bob',
      authorId: 'U_bob',
      authorBot: false,
      content: 'second',
    });

    await secondHandlerStarted;
    await second;
    expect(order).toEqual([
      'handler:first',
      'handler:second',
      'deliver:reply:second',
    ]);

    releaseFirst?.();
    await first;

    expect(order).toEqual([
      'handler:first',
      'handler:second',
      'deliver:reply:second',
      'deliver:reply:first',
    ]);
  });

  it('surfaces observer failures when strictObservers is enabled', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const main = agent('main').chat('chat', () => 'reply');
    const bundle = PromptTrail.bundle({
      name: 'server-strict-observer-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const server = PromptTrail.server({
      bundle,
      runtime: PromptTrail.app({
        store: memoryStore(),
        agents: bundle.agents,
      }),
      strictObservers: true,
      observers: [
        {
          name: 'failing',
          handle(event) {
            if (event.type === 'delivery.pending') {
              throw new Error('observer broke');
            }
          },
        },
      ],
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver() {
                // delivery.pending observer fails before the delivery driver.
              },
            },
          ],
        },
      ],
    });

    await server.start();
    await expect(
      emit?.({
        source: 'discord',
        guild: 'workroom',
        channel: 'general',
        channelId: 'C_general',
        author: 'alice',
        authorId: 'U_alice',
        authorBot: false,
        content: 'hello',
      }),
    ).rejects.toThrow('observer broke');
  });

  it('does not roll back completed delivery when strict observer fails on completion', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    let deliveries = 0;
    const main = agent('main').chat('chat', () => 'reply');
    const bundle = PromptTrail.bundle({
      name: 'server-strict-completed-observer-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const server = PromptTrail.server({
      bundle,
      runtime: app,
      strictObservers: true,
      observers: [
        {
          name: 'failing',
          handle(event) {
            if (event.type === 'delivery.completed') {
              throw new Error('observer broke');
            }
          },
        },
      ],
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver() {
                deliveries++;
              },
            },
          ],
        },
      ],
    });

    await server.start();
    await expect(
      emit?.({
        source: 'discord',
        guild: 'workroom',
        channel: 'general',
        channelId: 'C_general',
        author: 'alice',
        authorId: 'U_alice',
        authorBot: false,
        content: 'hello',
      }),
    ).rejects.toThrow('observer broke');

    expect(deliveries).toBe(1);
    expect(
      app
        .assistantDeliveryOutbox(
          'discord:guild:workroom:channel:C_general:user:U_alice',
        )
        .map((entry) => entry.status),
    ).toEqual(['delivered']);
  });

  it('materializes missing final delivery outbox entries on startup', async () => {
    const deliveries: string[] = [];
    const main = agent('main').chat('chat', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
    const bundle = PromptTrail.bundle({
      name: 'server-outbox-materialize-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const store = memoryStore();
    const app = PromptTrail.app({
      store,
      agents: bundle.agents,
    });
    const event: DiscordMessageEvent = {
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello',
    };
    const binding = bundle.bindings[0];

    await dispatchRuntimeBindingEvent({
      app,
      binding,
      event,
      defaults: mergeBindingDefaults(bundle.defaults, binding.defaults),
    });

    const runId = 'discord:guild:workroom:channel:C_general:user:U_alice';
    const deliveryKey = assistantDeliveryKey(
      runId,
      0,
      discordDeliveryTarget('general'),
    );
    expect(
      app.assistantDeliveryOutbox(runId).map((entry) => ({
        id: entry.id,
        idempotencyKey: entry.idempotencyKey,
        conversationId: entry.conversationId,
        messageRef: entry.messageRef,
        platformBinding: entry.platformBinding,
        status: entry.status,
        attempts: entry.attempts,
      })),
    ).toEqual([
      {
        id: deliveryKey,
        idempotencyKey: deliveryKey,
        conversationId: runId,
        messageRef: {
          conversationId: runId,
          assistantIndex: 0,
        },
        platformBinding: undefined,
        status: 'pending',
        attempts: 0,
      },
    ]);

    const run = store.get(runId)!;
    run.outbox = [];
    store.set(runId, run);
    expect(store.get(runId)?.outbox).toEqual([]);

    const server = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [
        {
          name: 'test-discord',
          deliveries: [
            {
              platform: 'discord',
              deliver(ctx, _target, message) {
                deliveries.push(`${ctx.idempotencyKey}:${message.content}`);
                return { messageId: `sent:${ctx.idempotencyKey}` };
              },
            },
          ],
        },
      ],
    });

    await server.start();

    expect(deliveries).toEqual([`${deliveryKey}:reply:hello`]);
    expect(
      app.assistantDeliveryOutbox(runId).map((entry) => ({
        id: entry.id,
        idempotencyKey: entry.idempotencyKey,
        conversationId: entry.conversationId,
        messageRef: entry.messageRef,
        platformBinding: entry.platformBinding,
        status: entry.status,
        attempts: entry.attempts,
      })),
    ).toEqual([
      {
        id: deliveryKey,
        idempotencyKey: deliveryKey,
        conversationId: runId,
        messageRef: {
          conversationId: runId,
          assistantIndex: 0,
        },
        platformBinding: { messageId: `sent:${deliveryKey}` },
        status: 'delivered',
        attempts: 1,
      },
    ]);
  });

  it('isolates existing run context from returned dispatch context mutations', async () => {
    const main = agent('main').chat('chat', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
    const bundle = PromptTrail.bundle({
      name: 'server-existing-context-clone-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const event: DiscordMessageEvent = {
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello',
    };
    const binding = bundle.bindings[0];
    const defaults = mergeBindingDefaults(bundle.defaults, binding.defaults);

    await dispatchRuntimeBindingEvent({ app, binding, event, defaults });
    const dispatched = await dispatchRuntimeBindingEvent({
      app,
      binding,
      event,
      defaults,
    });
    const delivery = dispatched.context.delivery as
      | { channel?: string }
      | undefined;
    if (delivery) {
      delivery.channel = 'caller-mutated';
    }

    const runId = 'discord:guild:workroom:channel:C_general:user:U_alice';
    const deliveryKey = assistantDeliveryKey(
      runId,
      0,
      discordDeliveryTarget('general'),
    );
    const secondDeliveryKey = assistantDeliveryKey(
      runId,
      1,
      discordDeliveryTarget('general'),
    );
    expect(
      app.pendingAssistantDeliveryOutbox().map(({ entry }) => ({
        idempotencyKey: entry.idempotencyKey,
        target: entry.target,
      })),
    ).toEqual([
      {
        idempotencyKey: deliveryKey,
        target: expect.objectContaining({
          platform: 'discord',
          channel: 'general',
        }),
      },
      {
        idempotencyKey: secondDeliveryKey,
        target: expect.objectContaining({
          platform: 'discord',
          channel: 'general',
        }),
      },
    ]);
  });

  it('fills runtime outbox metadata on existing delivery entries', async () => {
    const store = memoryStore();
    const main = agent('main').assistant('reply', () => 'stored reply');
    const app = PromptTrail.app({
      store,
      agents: { main },
    });
    const runId = 'discord:guild:workroom:channel:C_general';
    const otherRunId = 'discord:guild:workroom:channel:C_other';
    const target = discord.channel('general');
    const deliveryKey = assistantDeliveryKey(runId, 0, target);
    const otherDeliveryKey = assistantDeliveryKey(otherRunId, 0, target);

    await app.run({
      agent: 'main',
      runId,
      durable: true,
    });
    await app.run({
      agent: 'main',
      runId: otherRunId,
      durable: true,
    });
    const run = store.get(runId)!;
    run.outbox = [
      {
        assistantIndex: 0,
        idempotencyKey: deliveryKey,
        message: { type: 'assistant', content: 'stored reply' },
        target,
        status: 'pending',
        attempts: 0,
      } as never,
    ];
    store.set(runId, run);
    const otherRun = store.get(otherRunId)!;
    otherRun.outbox = [
      {
        assistantIndex: 0,
        idempotencyKey: otherDeliveryKey,
        message: { type: 'assistant', content: 'stored reply' },
        target,
        status: 'pending',
        attempts: 0,
      } as never,
    ];
    store.set(otherRunId, otherRun);

    expect(app.assistantDeliveryOutbox(runId)).toEqual([
      expect.objectContaining({
        id: deliveryKey,
        conversationId: runId,
        messageRef: {
          conversationId: runId,
          assistantIndex: 0,
        },
      }),
    ]);
    expect(store.get(otherRunId)?.outbox?.[0]).toEqual(
      expect.not.objectContaining({
        id: otherDeliveryKey,
        conversationId: otherRunId,
        messageRef: {
          conversationId: otherRunId,
          assistantIndex: 0,
        },
      }),
    );
  });

  it('retries pending final deliveries before starting sources', async () => {
    const order: string[] = [];
    const deliveries: string[] = [];
    const main = agent('main').assistant('reply', () => 'stored reply');
    const bundle = PromptTrail.bundle({
      name: 'server-outbox-retry-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const runId = 'discord:guild:workroom:channel:C_general';
    const target = discord.channel('general');
    const deliveryKey = assistantDeliveryKey(runId, 0, target);
    await app.run({
      agent: 'main',
      runId,
      durable: true,
    });
    app.prepareAssistantDeliveries(runId, [
      {
        assistantIndex: 0,
        idempotencyKey: deliveryKey,
        message: {
          type: 'assistant',
          content: 'retry me',
        },
        target,
      },
    ]);
    app.markAssistantDelivery(
      runId,
      deliveryKey,
      'failed',
      new Error('previous delivery failed'),
      { messageId: 'previous' },
    );

    const server = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start() {
                order.push('source-start');
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver(ctx, target, message) {
                order.push('deliver');
                (target as { channel?: string }).channel = 'retry-mutated';
                const binding = ctx.platformBinding as
                  | { messageId?: string }
                  | undefined;
                if (binding) {
                  binding.messageId = 'retry-mutated-binding';
                }
                message.content = 'retry-mutated-message';
                deliveries.push(
                  `${ctx.idempotencyKey}:${JSON.stringify(ctx.platformBinding)}:${message.content}`,
                );
                return { messageId: 'retried' };
              },
            },
          ],
        },
      ],
    });

    await server.start();

    expect(order).toEqual(['deliver', 'source-start']);
    expect(deliveries).toEqual([
      `${deliveryKey}:${JSON.stringify({ messageId: 'retry-mutated-binding' })}:retry-mutated-message`,
    ]);
    expect(
      app.assistantDeliveryOutbox(runId).map((entry) => ({
        platformBinding: entry.platformBinding,
        status: entry.status,
        attempts: entry.attempts,
        lastError: entry.lastError,
        message: entry.message,
        target: entry.target,
      })),
    ).toEqual([
      {
        platformBinding: { messageId: 'retried' },
        status: 'delivered',
        attempts: 1,
        lastError: undefined,
        message: {
          type: 'assistant',
          content: 'retry me',
        },
        target: expect.objectContaining({
          platform: 'discord',
          channel: 'general',
        }),
      },
    ]);
  });

  it('retries delivering final deliveries on startup', async () => {
    const deliveries: string[] = [];
    const main = agent('main').assistant('reply', () => 'stored reply');
    const bundle = PromptTrail.bundle({
      name: 'server-outbox-delivering-retry-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const runId = 'discord:guild:workroom:channel:C_general';
    const target = discord.channel('general');
    const deliveryKey = assistantDeliveryKey(runId, 0, target);
    await app.run({
      agent: 'main',
      runId,
      durable: true,
    });
    app.prepareAssistantDeliveries(runId, [
      {
        assistantIndex: 0,
        idempotencyKey: deliveryKey,
        message: {
          type: 'assistant',
          content: 'retry delivering',
        },
        target,
      },
    ]);
    app.markAssistantDelivery(runId, deliveryKey, 'delivering');

    const server = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [
        {
          name: 'test-discord',
          deliveries: [
            {
              platform: 'discord',
              deliver(ctx, _target, message) {
                deliveries.push(`${ctx.idempotencyKey}:${message.content}`);
              },
            },
          ],
        },
      ],
    });

    await server.start();

    expect(deliveries).toEqual([`${deliveryKey}:retry delivering`]);
    expect(
      app.assistantDeliveryOutbox(runId).map((entry) => ({
        status: entry.status,
        attempts: entry.attempts,
        lastError: entry.lastError,
      })),
    ).toEqual([{ status: 'delivered', attempts: 2, lastError: undefined }]);
  });

  it('stops startup delivery retries for a conversation after the first failure', async () => {
    const order: string[] = [];
    const main = agent('main').assistant('reply', () => 'stored reply');
    const bundle = PromptTrail.bundle({
      name: 'server-outbox-retry-order-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const runId = 'discord:guild:workroom:channel:C_general';
    const target = discord.channel('general');
    const firstDeliveryKey = assistantDeliveryKey(runId, 0, target);
    const secondDeliveryKey = assistantDeliveryKey(runId, 1, target);
    await app.run({
      agent: 'main',
      runId,
      durable: true,
    });
    app.prepareAssistantDeliveries(runId, [
      {
        assistantIndex: 0,
        idempotencyKey: firstDeliveryKey,
        message: { type: 'assistant', content: 'first' },
        target,
      },
      {
        assistantIndex: 1,
        idempotencyKey: secondDeliveryKey,
        message: { type: 'assistant', content: 'second' },
        target,
      },
    ]);

    const server = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start() {
                order.push('source-start');
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver(ctx) {
                order.push(`deliver:${ctx.idempotencyKey}`);
                throw new Error('delivery failed');
              },
            },
          ],
        },
      ],
    });

    await server.start();

    expect(order).toEqual([`deliver:${firstDeliveryKey}`, 'source-start']);
    expect(
      app.assistantDeliveryOutbox(runId).map((entry) => ({
        idempotencyKey: entry.idempotencyKey,
        status: entry.status,
        attempts: entry.attempts,
        lastError: entry.lastError,
      })),
    ).toEqual([
      {
        idempotencyKey: firstDeliveryKey,
        status: 'failed',
        attempts: 1,
        lastError: 'delivery failed',
      },
      {
        idempotencyKey: secondDeliveryKey,
        status: 'pending',
        attempts: 0,
        lastError: undefined,
      },
    ]);
  });
});
