import { describe, expect, it } from 'vitest';
import { PromptTrail, memoryStore } from '../../durable';
import { Middleware } from '../../interceptors';
import {
  Delivery,
  on,
  type DeliveryTarget,
  type TriggerEvent,
} from '../../runtime_bindings';
import { Agent } from '../../templates';
import type { Session } from '../../session';
import {
  assistantDeliveryKey,
  dispatchRuntimeEvent,
  mergeBindingDefaults,
} from '../../runtime_dispatch';
import {
  type RuntimeAdapter,
  type RuntimeGatewayContext,
} from '../../runtime_server';
import type { ObserverDeliveryBindingStore } from '../../execution';

interface FakeMessageEvent extends TriggerEvent {
  source: 'fake-chat';
  guild: string;
  channel: string;
  channelId: string;
  thread?: string;
  author: string;
  authorId: string;
  authorBot: boolean;
  content: string;
  mentionsBot?: boolean;
  isDM?: boolean;
}

interface FakeChatBehavior {
  allowedChannels?: readonly string[];
  freeResponseChannels?: readonly string[];
  threadResponseChannels?: readonly string[];
  requireMention?: boolean;
  threadRequireMention?: boolean;
}

function fakeChatDeliveryTarget(channel: string, thread?: string) {
  return {
    platform: 'fake-chat' as const,
    channel,
    thread,
  };
}

const fakeChat = {
  messages() {
    return {
      type: 'fake-chat.messages',
      eventAttrs: (event: FakeMessageEvent) => ({
        author: event.author,
        authorId: event.authorId,
        channel: event.channel,
        channelId: event.channelId,
        thread: event.thread,
      }),
      resolveDelivery: (delivery: DeliveryTarget, event: FakeMessageEvent) => {
        if (
          delivery.platform === 'origin' ||
          (delivery.platform === 'fake-chat' &&
            delivery.kind === 'originThread')
        ) {
          return fakeChatDeliveryTarget(event.channel, event.thread);
        }
        return delivery;
      },
      shouldDispatch: (
        event: FakeMessageEvent,
        defaults: { behavior?: unknown },
      ) => passesFakeChatBehavior(event, defaults.behavior),
      resolveContext: ({
        defaults,
        event,
      }: {
        defaults: {
          context?: Record<string, unknown>;
          skills?: readonly string[];
        };
        event: FakeMessageEvent;
      }) => ({
        channelPrompt: resolveFakeChatChannelPrompt(defaults, event),
        skills: resolveFakeChatChannelSkills(defaults, event),
      }),
    };
  },
  notBot() {
    return (event: FakeMessageEvent) => !event.authorBot;
  },
  sessionKey(options: {
    groupSessionsPerUser?: boolean;
    threadSessionsPerUser?: boolean;
  }) {
    return (event: FakeMessageEvent) => {
      if (event.isDM) {
        return `fake-chat:dm:${event.authorId}`;
      }
      if (event.thread) {
        const base = `fake-chat:guild:${event.guild}:thread:${event.thread}`;
        return options.threadSessionsPerUser
          ? `${base}:user:${event.authorId}`
          : base;
      }
      const base = `fake-chat:guild:${event.guild}:channel:${event.channelId}`;
      return options.groupSessionsPerUser
        ? `${base}:user:${event.authorId}`
        : base;
    };
  },
  replyToOriginThread() {
    return { platform: 'fake-chat', kind: 'originThread' };
  },
  channel(channel: string) {
    return { platform: 'fake-chat', channel };
  },
};

function passesFakeChatBehavior(
  event: FakeMessageEvent,
  behavior: unknown,
): boolean {
  if (!behavior || typeof behavior !== 'object') {
    return true;
  }
  const chatBehavior = behavior as FakeChatBehavior;
  if (
    chatBehavior.allowedChannels &&
    !chatBehavior.allowedChannels.includes(event.channel) &&
    !chatBehavior.allowedChannels.includes(event.channelId)
  ) {
    return false;
  }
  if (
    chatBehavior.freeResponseChannels?.includes(event.channel) ||
    chatBehavior.freeResponseChannels?.includes(event.channelId)
  ) {
    return true;
  }
  if (chatBehavior.requireMention === false) {
    return true;
  }
  return event.mentionsBot === true;
}

function resolveFakeChatChannelPrompt(
  defaults: { context?: Record<string, unknown> },
  event: FakeMessageEvent,
): string | undefined {
  const prompts = defaults.context?.channelPrompts as
    | Record<string, string>
    | undefined;
  if (!prompts) {
    return undefined;
  }
  return (
    (event.thread ? prompts[event.thread] : undefined) ??
    prompts[event.channel] ??
    prompts[event.channelId]
  );
}

function resolveFakeChatChannelSkills(
  defaults: { context?: Record<string, unknown>; skills?: readonly string[] },
  event: FakeMessageEvent,
): readonly string[] | undefined {
  const bindings = defaults.context?.channelSkillBindings as
    | Array<{ channel: string; skills: readonly string[] }>
    | undefined;
  if (!bindings) {
    return defaults.skills;
  }
  const exactThread = event.thread
    ? bindings.find((binding) => binding.channel === event.thread)
    : undefined;
  const parent = bindings.find(
    (binding) =>
      binding.channel === event.channel || binding.channel === event.channelId,
  );
  return exactThread?.skills ?? parent?.skills ?? defaults.skills;
}

function chatAgent(
  name: string,
  handler: (session: Session) => unknown,
): Agent {
  return Agent.create(name).inbox('inbox').assistant('reply', handler);
}

describe('RuntimeServer', () => {
  it('includes stable delivery targets in assistant delivery keys', () => {
    const conversationId = 'fake-chat:guild:workroom:channel:C_general';
    const target = fakeChatDeliveryTarget('general', 'T_debug');
    const reorderedTarget = {
      thread: 'T_debug',
      channel: 'general',
      platform: 'fake-chat',
    } as DeliveryTarget;
    const otherTarget = fakeChatDeliveryTarget('cloud-lab', 'T_debug');

    expect(assistantDeliveryKey(conversationId, 0, target)).toBe(
      assistantDeliveryKey(conversationId, 0, reorderedTarget),
    );
    expect(assistantDeliveryKey(conversationId, 0, target)).not.toBe(
      assistantDeliveryKey(conversationId, 0, otherTarget),
    );
  });

  it('keeps assistant delivery keys stable across JSON target round-trips', () => {
    const conversationId = 'fake-chat:guild:workroom:channel:C_general';
    const targetWithUndefinedThread = fakeChatDeliveryTarget('general');
    const roundTrippedTarget = JSON.parse(
      JSON.stringify(targetWithUndefinedThread),
    ) as DeliveryTarget;

    expect(
      assistantDeliveryKey(conversationId, 0, targetWithUndefinedThread),
    ).toBe(assistantDeliveryKey(conversationId, 0, roundTrippedTarget));
  });

  it('routes adapter gateway events through bindings and delivery drivers', async () => {
    let emit: RuntimeGatewayContext<FakeMessageEvent>['emit'] | undefined;
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
    const main = chatAgent('main', (session) => ({
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
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [
        on(fakeChat.messages())
          .where(fakeChat.notBot())
          .toAgent('main')
          .conversation(fakeChat.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: fakeChat.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const adapter: RuntimeAdapter = {
      name: 'test-fake-chat',
      gateways: [
        {
          type: 'fake-chat.messages',
          start(ctx) {
            emit = ctx.emit;
          },
        },
      ],
      deliveries: [
        {
          platform: 'fake-chat',
          deliver(_ctx, target, message) {
            const fakeChatTarget = target as unknown as { channel: string };
            deliveries.push(`${fakeChatTarget.channel}:${message.content}`);
            fakeChatTarget.channel = 'driver-mutated';
            return returnedBinding;
          },
        },
      ],
      presences: [
        {
          platform: 'fake-chat',
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
      presence: { kind: 'typing' },
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
              event.idempotencyKey!,
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
      source: 'fake-chat',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello',
    });

    const conversationId =
      'fake-chat:guild:workroom:channel:C_general:user:U_alice';
    const finalDeliveryKey = assistantDeliveryKey(
      conversationId,
      0,
      fakeChatDeliveryTarget('general'),
    );

    expect(activityEvents).toEqual(['start', 'stop']);
    expect(deliveries).toEqual(['general:reply:hello']);
    expect(observerEvents).toEqual([
      '1:model.started:fake-chat:guild:workroom:channel:C_general:user:U_alice:model:1:model.started',
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
      (await app.assistantDeliveryOutbox(conversationId)).map((entry) => ({
        platformBinding: entry.platformBinding,
        target: entry.target,
      })),
    ).toEqual([
      {
        platformBinding: { messageId: 'M_reply' },
        target: expect.objectContaining({
          platform: 'fake-chat',
          channel: 'general',
        }),
      },
    ]);
    expect(await app.pendingAssistantDeliveryOutbox()).toEqual([]);
    expect(observerWrites).toEqual([
      'claim:["runtimeObserver:0","fake-chat:guild:workroom:channel:C_general:user:U_alice:model:1:model.started"]:undefined',
      'complete:["runtimeObserver:0","fake-chat:guild:workroom:channel:C_general:user:U_alice:model:1:model.started"]:app',
      'claim:["runtimeObserver:1","fake-chat:guild:workroom:channel:C_general:user:U_alice:model:1:model.started"]:undefined',
      'complete:["runtimeObserver:1","fake-chat:guild:workroom:channel:C_general:user:U_alice:model:1:model.started"]:app-second',
      `claim:["runtimeObserver:0","${finalDeliveryKey}"]:undefined`,
      `complete:["runtimeObserver:0","${finalDeliveryKey}"]:server`,
    ]);
  });

  it('routes runtime bundle events to registered Agent graphs', async () => {
    const main = Agent.create('main')
      .inbox('inbound')
      .assistant('reply', (session) => ({
        content: `reply:${session.getLastMessage()?.content ?? ''}`,
      }));
    const bundle = PromptTrail.runtimeBundle({
      name: 'graph-runtime',
      defaults: {},
      bindings: [
        on(fakeChat.messages())
          .to(main)
          .conversation(() => 'fake-chat:graph'),
      ],
    });
    const app = PromptTrail.app({
      agents: bundle.agents,
    });
    const result = await dispatchRuntimeEvent({
      app,
      binding: bundle.bindings[0]!,
      event: {
        source: 'fake-chat',
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
    expect(result.result.runId).toBe('fake-chat:graph');
    expect(
      result.result.session.messages.map((message) => message.content),
    ).toEqual(['hello', 'reply:hello']);
  });

  it('registers Agent instances from runtime bindings into bundles', () => {
    const main = Agent.create('main').assistant('reply', () => 'reply');
    const durable = Agent.create('durable');
    const bundle = PromptTrail.runtimeBundle({
      name: 'binding-agent-registration',
      bindings: [
        on(fakeChat.messages())
          .to(main)
          .conversation(() => 'fake-chat:graph'),
        on(fakeChat.messages())
          .to(durable)
          .conversation(() => 'fake-chat:durable'),
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
      .inbox('inbound')
      .assistant('reply', (session) => ({
        content: `reply:${session.getLastMessage()?.content ?? ''}`,
      }));
    const app = PromptTrail.app({
      name: 'graph-runtime-app',
      defaults: {
        context: { appScope: 'runtime-app' },
        delivery: Delivery.origin() as DeliveryTarget,
      },
    }).on(fakeChat.messages(), (binding) => {
      binding
        .to(main)
        .conversation(() => 'fake-chat:graph')
        .reply(fakeChat.channel('general'))
        .context((event) => ({
          bindingScope: 'fake-chat-message',
          channelId: event.channelId,
        }));
    });
    const bundle = app.bundle();
    const result = await dispatchRuntimeEvent({
      app,
      binding: bundle.bindings[0]!,
      event: {
        source: 'fake-chat',
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
      fakeChat.channel('general'),
    );
    expect(result.delivery).toEqual(fakeChat.channel('general'));
    expect(result.context).toEqual(
      expect.objectContaining({
        appScope: 'runtime-app',
        bindingScope: 'fake-chat-message',
        channelId: 'C_general',
        delivery: fakeChat.channel('general'),
      }),
    );
    expect(
      result.result.session.messages.map((message) => message.content),
    ).toEqual(['hello', 'reply:hello']);
  });

  it('starts runtime adapter gateways from app instances', async () => {
    let emit: RuntimeGatewayContext<FakeMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const activityEvents: string[] = [];
    const sourceEvents: string[] = [];
    const observerEvents: string[] = [];
    const runtimeObserverEvents: string[] = [];
    const main = Agent.create('main')
      .inbox('inbound')
      .assistant('reply', (session) => ({
        content: `reply:${session.getLastMessage()?.content ?? ''}`,
      }));
    const app = PromptTrail.app({
      name: 'app-start-runtime',
      defaults: {},
    })
      .gateway({
        type: 'fake-chat.messages',
        start(ctx) {
          sourceEvents.push('start');
          emit = ctx.emit;
        },
        stop() {
          sourceEvents.push('stop');
        },
      })
      .delivery({
        platform: 'fake-chat',
        deliver(_ctx, target, message) {
          deliveries.push(`${target.channel}:${message.content}`);
        },
      })
      .presence({
        platform: 'fake-chat',
        start(_ctx, target) {
          activityEvents.push(`start:${target.channel}`);
          return {
            stop() {
              activityEvents.push('stop');
            },
          };
        },
      })
      .adapter({
        name: 'runtime-observer',
        observers: [
          (event) => {
            if (
              event.type === 'run.started' ||
              event.type === 'run.completed' ||
              event.type === 'delivery.pending' ||
              event.type === 'delivery.completed'
            ) {
              runtimeObserverEvents.push(event.type);
            }
          },
        ],
      })
      .on(fakeChat.messages(), (binding) =>
        binding
          .to(main)
          .conversation(() => 'fake-chat:app-start')
          .reply(fakeChat.channel('general')),
      )
      .observe((event) => {
        if (
          event.type === 'run.started' ||
          event.type === 'run.completed' ||
          event.type === 'delivery.pending' ||
          event.type === 'delivery.completed'
        ) {
          observerEvents.push(event.type);
        }
      });

    await app.start();
    if (!emit) {
      throw new Error('Runtime source did not start.');
    }
    await emit({
      source: 'fake-chat',
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
    expect(observerEvents).toEqual([
      'run.started',
      'run.completed',
      'delivery.pending',
      'delivery.completed',
    ]);
    expect(runtimeObserverEvents).toEqual([
      'run.started',
      'run.completed',
      'delivery.pending',
      'delivery.completed',
    ]);
  });

  it('registers named Agent instances directly on apps', async () => {
    const main = Agent.create('main')
      .inbox('inbound')
      .assistant('reply', (session) => ({
        content: `reply:${session.getLastMessage()?.content ?? ''}`,
      }));
    const app = PromptTrail.app().agent(main);
    const result = await app.run({
      agent: 'main',
      runId: 'app-agent-instance',
      input: 'hello',
    });

    expect(result.session.messages.map((message) => message.content)).toEqual([
      'hello',
      'reply:hello',
    ]);
  });

  it('registers durable agent factory results directly on apps', async () => {
    const durable = Agent.create('durable').assistant('reply', () => 'ok');
    const app = PromptTrail.app().agent(durable);
    const result = await app.run({
      agent: 'durable',
      runId: 'app-durable-agent-instance',
    });

    expect(result.session.getLastMessage()?.content).toBe('ok');
  });

  it('rejects unnamed Agent instances registered directly on apps', () => {
    expect(() =>
      PromptTrail.app().agent((Agent.create as unknown as () => Agent)()),
    ).toThrow(/Agent\.create\(name\)/);
  });

  it('runs runtime bundle Agent graph runs durably', async () => {
    const store = memoryStore();
    const main = Agent.create('main')
      .system('system', 'SYS')
      .inbox('inbound')
      .assistant('reply', (session) => ({
        content: `reply:${session.getLastMessage()?.content ?? ''}`,
      }));
    const bundle = PromptTrail.runtimeBundle({
      name: 'durable-graph-runtime',
      agents: { main },
      defaults: {
        checkpoint: true,
        delivery: fakeChat.replyToOriginThread(),
      },
      bindings: [
        on(fakeChat.messages())
          .toAgent('main')
          .conversation(() => 'fake-chat:graph'),
      ],
    });
    const app = PromptTrail.app({
      store,
      agents: bundle.agents,
    });

    const event = {
      source: 'fake-chat' as const,
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello',
    };
    const defaults = mergeBindingDefaults(
      bundle.defaults,
      bundle.bindings[0]!.defaults,
    );
    const first = await dispatchRuntimeEvent({
      app,
      binding: bundle.bindings[0]!,
      event,
      defaults,
    });
    const second = await dispatchRuntimeEvent({
      app,
      binding: bundle.bindings[0]!,
      event: { ...event, content: 'again' },
      defaults,
    });

    expect(
      first.result.session.messages.map((message) => message.content),
    ).toEqual(['SYS', 'hello', 'reply:hello']);
    expect(
      second.result.session.messages.map((message) => message.content),
    ).toEqual(['SYS', 'hello', 'reply:hello', 'again', 'reply:again']);

    const run = (await store.get('fake-chat:graph'))!;
    expect(run).toMatchObject({
      status: 'done',
      graphCursor: 2,
    });
    expect(run.inbox).toHaveLength(2);
    expect(await app.assistantDeliveryOutbox('fake-chat:graph')).toHaveLength(
      2,
    );
  });

  it('accepts Agent instances in runtime bindings', () => {
    const main = Agent.create('main').assistant('reply', () => 'reply');
    const durable = Agent.create('durable');
    const binding = on(fakeChat.messages())
      .to(main)
      .conversation(() => 'fake-chat:graph')
      .build();
    const aliasBinding = on(fakeChat.messages())
      .toAgent(main)
      .conversation(() => 'fake-chat:graph')
      .build();
    const durableBinding = on(fakeChat.messages())
      .to(durable)
      .conversation(() => 'fake-chat:durable')
      .build();

    expect(binding.agent).toBe('main');
    expect(aliasBinding.agent).toBe('main');
    expect(durableBinding.agent).toBe('durable');
  });

  it('allocates delivery event sequence numbers per conversation', async () => {
    let emit: RuntimeGatewayContext<FakeMessageEvent>['emit'] | undefined;
    const deliveryEvents: string[] = [];
    const main = chatAgent('main', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-delivery-seq-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [
        on(fakeChat.messages())
          .where(fakeChat.notBot())
          .toAgent('main')
          .conversation(fakeChat.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: fakeChat.replyToOriginThread(),
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
          name: 'test-fake-chat',
          gateways: [
            {
              type: 'fake-chat.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'fake-chat',
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
      source: 'fake-chat',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello alice',
    });
    await emit?.({
      source: 'fake-chat',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'bob',
      authorId: 'U_bob',
      authorBot: false,
      content: 'hello bob',
    });

    expect(deliveryEvents).toEqual([
      'fake-chat:guild:workroom:channel:C_general:user:U_alice:0:delivery.pending',
      'fake-chat:guild:workroom:channel:C_general:user:U_alice:1:delivery.completed',
      'fake-chat:guild:workroom:channel:C_general:user:U_bob:0:delivery.pending',
      'fake-chat:guild:workroom:channel:C_general:user:U_bob:1:delivery.completed',
    ]);
  });

  it('uses stable idempotency keys for runtime error delivery', async () => {
    let emit: RuntimeGatewayContext<FakeMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const main = chatAgent('main', () => {
      throw new Error('handler failed');
    });
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-error-delivery-test',
      agents: { main },
      defaults: {},
      bindings: [
        on(fakeChat.messages())
          .where(fakeChat.notBot())
          .toAgent('main')
          .conversation(fakeChat.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: fakeChat.replyToOriginThread(),
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
          name: 'test-fake-chat',
          gateways: [
            {
              type: 'fake-chat.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'fake-chat',
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
    const event: FakeMessageEvent = {
      source: 'fake-chat',
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
      /^fake-chat:guild:workroom:channel:C_general:user:U_alice:runtime-error:[0-9a-f]{8}:Something failed\.$/,
    );
  });

  it('threads runtime binding context into durable middleware', async () => {
    let emit: RuntimeGatewayContext<FakeMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const middlewareDelivery: unknown[] = [];
    const observerDelivery: unknown[] = [];
    const main = chatAgent('main', (session) => ({
      content: `reply:${(session.getVarsObject() as Record<string, unknown>).channelPrompt}`,
    }));
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-context-test',
      agents: { main },
      defaults: {
        checkpoint: true,
        context: {
          channelPrompts: {
            general: 'General channel prompt',
          },
        },
      },
      bindings: [
        on(fakeChat.messages())
          .where(fakeChat.notBot())
          .toAgent('main')
          .conversation(fakeChat.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: fakeChat.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const adapter: RuntimeAdapter = {
      name: 'test-fake-chat',
      gateways: [
        {
          type: 'fake-chat.messages',
          start(ctx) {
            emit = ctx.emit;
          },
        },
      ],
      deliveries: [
        {
          platform: 'fake-chat',
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
      source: 'fake-chat',
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
      { platform: 'fake-chat', channel: 'general', thread: undefined },
    ]);
  });

  it('persists completed final deliveries across server restarts', async () => {
    let emit: RuntimeGatewayContext<FakeMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const main = chatAgent('main', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-restart-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [
        on(fakeChat.messages())
          .where(fakeChat.notBot())
          .toAgent('main')
          .conversation(fakeChat.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: fakeChat.replyToOriginThread(),
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
      name: 'test-fake-chat',
      gateways: [
        {
          type: 'fake-chat.messages',
          start(ctx) {
            emit = ctx.emit;
          },
        },
      ],
      deliveries: [
        {
          platform: 'fake-chat',
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
      source: 'fake-chat',
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
      source: 'fake-chat',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'second',
    });

    const conversationId =
      'fake-chat:guild:workroom:channel:C_general:user:U_alice';
    const target = fakeChatDeliveryTarget('general');

    expect(deliveries).toEqual(['reply:first', 'reply:second']);
    expect(
      (await app.assistantDeliveryOutbox(conversationId)).map((entry) => ({
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
    let emit: RuntimeGatewayContext<FakeMessageEvent>['emit'] | undefined;
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstHandlerStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const main = chatAgent('main', async (session) => {
      const content = session.getLastMessage()?.content ?? '';
      order.push(`handler:${content}`);
      if (content === 'first') {
        firstStarted?.();
        await firstCanFinish;
      }
      return `reply:${content}`;
    });
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-lock-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [
        on(fakeChat.messages())
          .where(fakeChat.notBot())
          .toAgent('main')
          .conversation(fakeChat.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: fakeChat.replyToOriginThread(),
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
          name: 'test-fake-chat',
          gateways: [
            {
              type: 'fake-chat.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'fake-chat',
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
      source: 'fake-chat',
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
      source: 'fake-chat',
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
    let emit: RuntimeGatewayContext<FakeMessageEvent>['emit'] | undefined;
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
    const main = chatAgent('main', async (session) => {
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
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-lock-parallel-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [
        on(fakeChat.messages())
          .where(fakeChat.notBot())
          .toAgent('main')
          .conversation(fakeChat.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: fakeChat.replyToOriginThread(),
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
          name: 'test-fake-chat',
          gateways: [
            {
              type: 'fake-chat.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'fake-chat',
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
      source: 'fake-chat',
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
      source: 'fake-chat',
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
    let emit: RuntimeGatewayContext<FakeMessageEvent>['emit'] | undefined;
    const main = chatAgent('main', () => 'reply');
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-strict-observer-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [
        on(fakeChat.messages())
          .where(fakeChat.notBot())
          .toAgent('main')
          .conversation(fakeChat.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: fakeChat.replyToOriginThread(),
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
          name: 'test-fake-chat',
          gateways: [
            {
              type: 'fake-chat.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'fake-chat',
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
        source: 'fake-chat',
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
    let emit: RuntimeGatewayContext<FakeMessageEvent>['emit'] | undefined;
    let deliveries = 0;
    const main = chatAgent('main', () => 'reply');
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-strict-completed-observer-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [
        on(fakeChat.messages())
          .where(fakeChat.notBot())
          .toAgent('main')
          .conversation(fakeChat.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: fakeChat.replyToOriginThread(),
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
          name: 'test-fake-chat',
          gateways: [
            {
              type: 'fake-chat.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'fake-chat',
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
        source: 'fake-chat',
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
      (
        await app.assistantDeliveryOutbox(
          'fake-chat:guild:workroom:channel:C_general:user:U_alice',
        )
      ).map((entry) => entry.status),
    ).toEqual(['delivered']);
  });

  it('materializes missing final delivery outbox entries on startup', async () => {
    const deliveries: string[] = [];
    const main = chatAgent('main', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-outbox-materialize-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [
        on(fakeChat.messages())
          .where(fakeChat.notBot())
          .toAgent('main')
          .conversation(fakeChat.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: fakeChat.replyToOriginThread(),
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
    const event: FakeMessageEvent = {
      source: 'fake-chat',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello',
    };
    const binding = bundle.bindings[0];

    await dispatchRuntimeEvent({
      app,
      binding,
      event,
      defaults: mergeBindingDefaults(bundle.defaults, binding.defaults),
    });

    const runId = 'fake-chat:guild:workroom:channel:C_general:user:U_alice';
    const deliveryKey = assistantDeliveryKey(
      runId,
      0,
      fakeChatDeliveryTarget('general'),
    );
    expect(
      (await app.assistantDeliveryOutbox(runId)).map((entry) => ({
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

    const run = (await store.get(runId))!;
    run.outbox = [];
    expect((await store.get(runId))?.outbox).toEqual([]);

    const server = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [
        {
          name: 'test-fake-chat',
          deliveries: [
            {
              platform: 'fake-chat',
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
      (await app.assistantDeliveryOutbox(runId)).map((entry) => ({
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
    const main = chatAgent('main', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-existing-context-clone-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [
        on(fakeChat.messages())
          .where(fakeChat.notBot())
          .toAgent('main')
          .conversation(fakeChat.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: fakeChat.replyToOriginThread(),
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
    const event: FakeMessageEvent = {
      source: 'fake-chat',
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

    await dispatchRuntimeEvent({ app, binding, event, defaults });
    const dispatched = await dispatchRuntimeEvent({
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

    const runId = 'fake-chat:guild:workroom:channel:C_general:user:U_alice';
    const deliveryKey = assistantDeliveryKey(
      runId,
      0,
      fakeChatDeliveryTarget('general'),
    );
    const secondDeliveryKey = assistantDeliveryKey(
      runId,
      1,
      fakeChatDeliveryTarget('general'),
    );
    expect(
      (await app.pendingAssistantDeliveryOutbox()).map(({ entry }) => ({
        idempotencyKey: entry.idempotencyKey,
        target: entry.target,
      })),
    ).toEqual([
      {
        idempotencyKey: deliveryKey,
        target: expect.objectContaining({
          platform: 'fake-chat',
          channel: 'general',
        }),
      },
      {
        idempotencyKey: secondDeliveryKey,
        target: expect.objectContaining({
          platform: 'fake-chat',
          channel: 'general',
        }),
      },
    ]);
  });

  it('fills runtime outbox metadata on existing delivery entries', async () => {
    const store = memoryStore();
    const main = Agent.create('main').assistant('reply', () => 'stored reply');
    const app = PromptTrail.app({
      store,
      agents: { main },
    });
    const runId = 'fake-chat:guild:workroom:channel:C_general';
    const otherRunId = 'fake-chat:guild:workroom:channel:C_other';
    const target = fakeChat.channel('general');
    const deliveryKey = assistantDeliveryKey(runId, 0, target);
    const otherDeliveryKey = assistantDeliveryKey(otherRunId, 0, target);

    await app.run({
      agent: 'main',
      runId,
      checkpoint: true,
    });
    await app.run({
      agent: 'main',
      runId: otherRunId,
      checkpoint: true,
    });
    const run = (await store.get(runId))!;
    run.outbox = [];
    await store.upsertOutbox(runId, {
      assistantIndex: 0,
      idempotencyKey: deliveryKey,
      message: { type: 'assistant', content: 'stored reply' },
      target,
      status: 'pending',
      attempts: 0,
    } as never);
    const otherRun = (await store.get(otherRunId))!;
    otherRun.outbox = [];
    await store.upsertOutbox(otherRunId, {
      assistantIndex: 0,
      idempotencyKey: otherDeliveryKey,
      message: { type: 'assistant', content: 'stored reply' },
      target,
      status: 'pending',
      attempts: 0,
    } as never);

    expect(await app.assistantDeliveryOutbox(runId)).toEqual([
      expect.objectContaining({
        id: deliveryKey,
        conversationId: runId,
        messageRef: {
          conversationId: runId,
          assistantIndex: 0,
        },
      }),
    ]);
    expect((await store.get(otherRunId))?.outbox?.[0]).toEqual(
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
    const main = Agent.create('main').assistant('reply', () => 'stored reply');
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-outbox-retry-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const runId = 'fake-chat:guild:workroom:channel:C_general';
    const target = fakeChat.channel('general');
    const deliveryKey = assistantDeliveryKey(runId, 0, target);
    await app.run({
      agent: 'main',
      runId,
      checkpoint: true,
    });
    await app.prepareAssistantDeliveries(runId, [
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
    await app.markAssistantDelivery(
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
          name: 'test-fake-chat',
          gateways: [
            {
              type: 'fake-chat.messages',
              start() {
                order.push('source-start');
              },
            },
          ],
          deliveries: [
            {
              platform: 'fake-chat',
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
      (await app.assistantDeliveryOutbox(runId)).map((entry) => ({
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
          platform: 'fake-chat',
          channel: 'general',
        }),
      },
    ]);
  });

  it('retries delivering final deliveries on startup', async () => {
    const deliveries: string[] = [];
    const main = Agent.create('main').assistant('reply', () => 'stored reply');
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-outbox-delivering-retry-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const runId = 'fake-chat:guild:workroom:channel:C_general';
    const target = fakeChat.channel('general');
    const deliveryKey = assistantDeliveryKey(runId, 0, target);
    await app.run({
      agent: 'main',
      runId,
      checkpoint: true,
    });
    await app.prepareAssistantDeliveries(runId, [
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
    await app.markAssistantDelivery(runId, deliveryKey, 'delivering');

    const server = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [
        {
          name: 'test-fake-chat',
          deliveries: [
            {
              platform: 'fake-chat',
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
      (await app.assistantDeliveryOutbox(runId)).map((entry) => ({
        status: entry.status,
        attempts: entry.attempts,
        lastError: entry.lastError,
      })),
    ).toEqual([{ status: 'delivered', attempts: 2, lastError: undefined }]);
  });

  it('stops startup delivery retries for a conversation after the first failure', async () => {
    const order: string[] = [];
    const main = Agent.create('main').assistant('reply', () => 'stored reply');
    const bundle = PromptTrail.runtimeBundle({
      name: 'server-outbox-retry-order-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: [],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const runId = 'fake-chat:guild:workroom:channel:C_general';
    const target = fakeChat.channel('general');
    const firstDeliveryKey = assistantDeliveryKey(runId, 0, target);
    const secondDeliveryKey = assistantDeliveryKey(runId, 1, target);
    await app.run({
      agent: 'main',
      runId,
      checkpoint: true,
    });
    await app.prepareAssistantDeliveries(runId, [
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
          name: 'test-fake-chat',
          gateways: [
            {
              type: 'fake-chat.messages',
              start() {
                order.push('source-start');
              },
            },
          ],
          deliveries: [
            {
              platform: 'fake-chat',
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
      (await app.assistantDeliveryOutbox(runId)).map((entry) => ({
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
