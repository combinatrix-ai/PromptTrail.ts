import { agent, app, MemoryRunStore, type AssistantResult } from './durable';
import type { Message } from './message';
import type { Attrs } from './session';
import {
  type BindingDefaults,
  type CronEvent,
  type DeliveryTarget,
  type DiscordMessageEvent,
  type RuntimeBinding,
  type RuntimeBindingEvent,
  type RuntimeBundle,
} from './runtime_bindings';
import {
  AssistantDeliveryTracker,
  assistantDeliveryKey,
  dispatchRuntimeBindingEvent,
  findRuntimeBinding,
  isConcreteDiscordDeliveryTarget,
  mergeBindingDefaults,
  passesDiscordBehavior,
} from './runtime_dispatch';

export interface MockChannel {
  id: string;
  name: string;
}

export interface MockUser {
  id: string;
  name: string;
  bot?: boolean;
}

export interface MockDiscordOptions {
  guild?: string;
  channels: Record<string, MockChannel>;
  users?: Record<string, MockUser>;
}

export interface MockDiscordReceiveOptions {
  channel: string;
  thread?: string;
  author: string;
  content: string;
  mentionsBot?: boolean;
  bot?: boolean;
  isDM?: boolean;
  autoThread?: boolean;
}

export interface MockDiscordDelivery {
  platform: 'discord';
  channel: string;
  thread?: string;
  content: string;
  idempotencyKey: string;
}

export interface EffectJournalEntry {
  kind: 'delivery' | 'unresolvedDelivery';
  idempotencyKey: string;
  status: 'completed' | 'skipped';
  target?: DeliveryTarget;
}

export interface MockAssistantInput {
  input: {
    latestText: string;
  };
  context: Record<string, unknown>;
}

export type MockAssistantHandler = (
  input: MockAssistantInput,
) => AssistantResult<Attrs>;

type DiscordReceiveHandler = (
  message: MockDiscordReceiveOptions,
) => Promise<void>;

type CronTickHandler = (
  name: string,
  payload?: Record<string, unknown>,
) => Promise<void>;

export class MockDiscordConnector {
  private receiveHandler?: DiscordReceiveHandler;
  private readonly sent: MockDiscordDelivery[] = [];
  private readonly createdThreads: Array<{ channel: string; thread: string }> =
    [];
  private threadCounter = 0;

  constructor(readonly options: MockDiscordOptions) {}

  attach(handler: DiscordReceiveHandler): void {
    this.receiveHandler = handler;
  }

  async receive(message: MockDiscordReceiveOptions): Promise<void> {
    if (!this.receiveHandler) {
      throw new Error('Mock Discord connector is not attached to a fixture');
    }
    await this.receiveHandler(message);
  }

  channel(keyOrName: string): MockChannel | undefined {
    return (
      this.options.channels[keyOrName] ??
      Object.values(this.options.channels).find(
        (channel) => channel.name === keyOrName || channel.id === keyOrName,
      )
    );
  }

  user(keyOrName: string, bot?: boolean): MockUser {
    const configured = this.options.users?.[keyOrName];
    if (configured) {
      return { ...configured, bot: bot ?? configured.bot };
    }
    return {
      id: `U_${keyOrName}`,
      name: keyOrName,
      bot: bot ?? false,
    };
  }

  createThread(channel: string): string {
    const thread = `T_${channel}_${++this.threadCounter}`;
    this.createdThreads.push({ channel, thread });
    return thread;
  }

  deliver(delivery: MockDiscordDelivery): void {
    this.sent.push(delivery);
  }

  deliveries(): MockDiscordDelivery[] {
    return [...this.sent];
  }

  threads(): Array<{ channel: string; thread: string }> {
    return [...this.createdThreads];
  }
}

export class MockCronConnector {
  private tickHandler?: CronTickHandler;
  private readonly origins = new Map<string, DeliveryTarget>();
  private readonly runNames: string[] = [];

  attach(handler: CronTickHandler): void {
    this.tickHandler = handler;
  }

  async tick(name: string, payload?: Record<string, unknown>): Promise<void> {
    if (!this.tickHandler) {
      throw new Error('Mock Cron connector is not attached to a fixture');
    }
    this.runNames.push(name);
    await this.tickHandler(name, payload);
  }

  setOrigin(name: string, origin: DeliveryTarget): void {
    this.origins.set(name, origin);
  }

  origin(name: string): DeliveryTarget | undefined {
    return this.origins.get(name);
  }

  runs(): string[] {
    return [...this.runNames];
  }
}

export interface MockRuntimeFixtureOptions {
  bundle: RuntimeBundle;
  connectors: {
    discord: MockDiscordConnector;
    cron: MockCronConnector;
  };
  assistant?: MockAssistantHandler;
}

export interface MockConversationSummary {
  id: string;
  agent: string;
  status: 'done' | 'suspended';
}

export function mockDiscord(options: MockDiscordOptions): MockDiscordConnector {
  return new MockDiscordConnector(options);
}

export function mockCron(): MockCronConnector {
  return new MockCronConnector();
}

export function deterministicAssistant(): MockAssistantHandler {
  return ({ input, context }) => ({
    content: `reply:${input.latestText}`,
    attrs: {
      observed: {
        conversationId: context.conversationId,
        delivery: context.delivery,
        toolsets: context.toolsets,
        skills: context.skills,
        workdir: context.workdir,
        historyBackfill: context.historyBackfill,
        channelPrompt: context.channelPrompt,
      },
    },
  });
}

export function mockRuntimeFixture(options: MockRuntimeFixtureOptions) {
  return new MockRuntimeFixture(options);
}

class MockRuntimeFixture {
  readonly store = new MemoryRunStore();
  readonly app: ReturnType<typeof app>;
  readonly discord: MockDiscordConnector;
  readonly cron: MockCronConnector;
  readonly runtime: {
    conversations: () => MockConversationSummary[];
    inbox: (conversationId: string) => Array<Record<string, unknown>>;
    session: (conversationId: string) => unknown;
    resume: (conversationId: string) => Promise<void>;
    lastAssistantObservation: () => unknown;
  };
  readonly effects: {
    journal: () => EffectJournalEntry[];
  };

  private readonly deliveryTracker = new AssistantDeliveryTracker();
  private readonly effectEntries: EffectJournalEntry[] = [];

  constructor(private readonly options: MockRuntimeFixtureOptions) {
    this.app = app({
      store: this.store,
      agents: this.buildAgents(),
    });
    this.discord = options.connectors.discord;
    this.cron = options.connectors.cron;
    this.discord.attach((message) => this.handleDiscord(message));
    this.cron.attach((name, payload) => this.handleCron(name, payload));
    this.runtime = {
      conversations: () =>
        [...this.store.entries()].map(([id, run]) => ({
          id,
          agent: run.agentName,
          status: run.status === 'done' ? 'done' : 'suspended',
        })),
      inbox: (conversationId) => {
        const run = this.store.get(conversationId);
        return (run?.inbox ?? []).map((message) => {
          const attrs = (message.attrs ?? {}) as Record<string, unknown>;
          return {
            role: message.kind,
            source: attrs.source,
            content: message.content,
            author: attrs.author,
            channel: attrs.channel,
            thread: attrs.thread,
          };
        });
      },
      session: (conversationId) => this.store.get(conversationId)?.result,
      resume: async (conversationId) => {
        const result = await this.app.resume(conversationId);
        this.deliverUndelivered(conversationId, result.session.messages);
      },
      lastAssistantObservation: () => this.lastAssistantObservation(),
    };
    this.effects = {
      journal: () => [...this.effectEntries],
    };
  }

  private buildAgents(): Record<string, ReturnType<typeof agent>> {
    const assistant = this.options.assistant ?? deterministicAssistant();
    const agents: Record<string, ReturnType<typeof agent>> = {};
    for (const name of Object.keys(this.options.bundle.agents)) {
      agents[name] = agent(name).chat('chat', (session) => {
        const last = session.getLastMessage();
        const attrs = (last?.attrs ?? {}) as Record<string, unknown>;
        const context =
          (attrs.runtimeContext as Record<string, unknown> | undefined) ?? {};
        return assistant({
          input: { latestText: last?.content ?? '' },
          context,
        });
      });
    }
    return agents;
  }

  private async handleDiscord(
    message: MockDiscordReceiveOptions,
  ): Promise<void> {
    const channel = this.discord.channel(message.channel);
    if (!channel) {
      throw new Error(`Unknown mock Discord channel: ${message.channel}`);
    }
    const user = this.discord.user(message.author, message.bot);
    let event: DiscordMessageEvent = {
      source: 'discord',
      guild: this.discord.options.guild ?? 'workroom',
      channel: channel.name,
      channelId: channel.id,
      thread: message.thread,
      author: user.name,
      authorId: user.id,
      authorBot: user.bot ?? false,
      content: message.content,
      mentionsBot: message.mentionsBot,
      isDM: message.isDM,
    };

    const binding = findRuntimeBinding(
      this.options.bundle,
      'discord.messages',
      event,
    );
    if (!binding) {
      return;
    }

    const defaults = mergeBindingDefaults(
      this.options.bundle.defaults,
      binding.defaults,
    );
    if (!passesDiscordBehavior(event, defaults.behavior)) {
      return;
    }
    if (
      defaults.behavior?.autoThread &&
      !event.thread &&
      message.autoThread !== false
    ) {
      event = {
        ...event,
        thread: this.discord.createThread(channel.name),
      };
    }

    await this.dispatch(binding, event, defaults);
  }

  private async handleCron(
    name: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const binding = this.options.bundle.bindings.find(
      (candidate) =>
        candidate.source.type === 'cron.schedule' && candidate.name === name,
    );
    if (!binding) {
      throw new Error(`Unknown mock cron job: ${name}`);
    }
    const event: CronEvent = {
      source: 'cron',
      job: {
        id: slug(name),
        name,
        schedule: binding.source.schedule ?? '',
        origin: this.cron.origin(name),
      },
      payload,
      ...(payload ?? {}),
    } as CronEvent;
    await this.dispatch(
      binding,
      event,
      mergeBindingDefaults(this.options.bundle.defaults, binding.defaults),
    );
  }

  private async dispatch<TEvent extends RuntimeBindingEvent>(
    binding: RuntimeBinding<TEvent>,
    event: TEvent,
    defaults: BindingDefaults,
  ): Promise<void> {
    const { conversationId, result } = await dispatchRuntimeBindingEvent({
      app: this.app,
      binding,
      event,
      defaults,
    });
    this.deliverUndelivered(conversationId, result.session.messages);
  }

  private deliverUndelivered(
    conversationId: string,
    messages: readonly Message<Attrs>[],
  ): void {
    const pending = messages
      .filter(
        (message): message is Message<Attrs> & { type: 'assistant' } =>
          message.type === 'assistant',
      )
      .map((message, index) => {
        const attrs = (message.attrs ?? {}) as Record<string, unknown>;
        const observed = (attrs.observed ?? {}) as Record<string, unknown>;
        const delivery = observed.delivery as DeliveryTarget | undefined;
        return {
          message,
          assistantIndex: index,
          idempotencyKey: assistantDeliveryKey(conversationId, index, delivery),
          target: delivery,
        };
      })
      .filter((delivery) => !this.deliveryTracker.has(delivery.idempotencyKey));
    const deliveryAttempts = this.app.prepareAssistantDeliveries(
      conversationId,
      pending,
    );
    for (const deliveryAttempt of deliveryAttempts) {
      const message = deliveryAttempt.message;
      const delivery = deliveryAttempt.target as DeliveryTarget | undefined;
      if (!isConcreteDiscordDeliveryTarget(delivery)) {
        this.app.markAssistantDelivery(
          conversationId,
          deliveryAttempt.idempotencyKey,
          'skipped',
        );
        this.deliveryTracker.markDelivered(deliveryAttempt);
        this.effectEntries.push({
          kind: 'unresolvedDelivery',
          idempotencyKey: deliveryAttempt.idempotencyKey,
          status: 'skipped',
          target: delivery,
        });
        continue;
      }
      this.discord.deliver({
        platform: 'discord',
        channel: delivery.channel,
        thread: delivery.thread,
        content: message.content,
        idempotencyKey: deliveryAttempt.idempotencyKey,
      });
      this.app.markAssistantDelivery(
        conversationId,
        deliveryAttempt.idempotencyKey,
        'delivered',
      );
      this.deliveryTracker.markDelivered(deliveryAttempt);
      this.effectEntries.push({
        kind: 'delivery',
        idempotencyKey: deliveryAttempt.idempotencyKey,
        status: 'completed',
        target: delivery,
      });
    }
  }

  private lastAssistantObservation(): unknown {
    for (const [, run] of [...this.store.entries()].reverse()) {
      const messages = run.result?.messages ?? [];
      for (const message of [...messages].reverse()) {
        if (message.type === 'assistant') {
          const attrs = (message.attrs ?? {}) as Record<string, unknown>;
          return attrs.observed;
        }
      }
    }
    return undefined;
  }
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
