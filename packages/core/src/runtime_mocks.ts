import {
  agent,
  app,
  MemoryRunStore,
  type AssistantResult,
  type DurableAgent,
} from './durable';
import type { Message } from './message';
import type { Attrs } from './session';
import {
  type BindingDefaults,
  type ConcreteDiscordDeliveryTarget,
  type CronEvent,
  type DeliveryTarget,
  type DiscordMessageEvent,
  type RuntimeBinding,
  type RuntimeBindingEvent,
  type RuntimeBundle,
} from './runtime_bindings';

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

  private readonly deliveredKeys = new Set<string>();
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

  private buildAgents(): Record<string, DurableAgent<any, any>> {
    const assistant = this.options.assistant ?? deterministicAssistant();
    const agents: Record<string, DurableAgent<any, any>> = {};
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

    const binding = this.findBinding('discord.messages', event);
    if (!binding) {
      return;
    }

    const defaults = mergeDefaults(
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
      mergeDefaults(this.options.bundle.defaults, binding.defaults),
    );
  }

  private findBinding<TEvent extends RuntimeBindingEvent>(
    sourceType: string,
    event: TEvent,
  ): RuntimeBinding<TEvent> | undefined {
    return this.options.bundle.bindings.find(
      (binding) =>
        binding.source.type === sourceType &&
        binding.filters.every((filter) =>
          (filter as (event: TEvent) => boolean)(event),
        ),
    ) as RuntimeBinding<TEvent> | undefined;
  }

  private async dispatch<TEvent extends RuntimeBindingEvent>(
    binding: RuntimeBinding<TEvent>,
    event: TEvent,
    defaults: BindingDefaults,
  ): Promise<void> {
    const conversationId = binding.conversation(event);
    const delivery = resolveDelivery(defaults.delivery, event);
    const context = contextFromDefaults(
      conversationId,
      defaults,
      delivery,
      event,
    );
    const content = resolveInput(binding, event);
    const result = await this.app.send({
      agent: binding.agent,
      runId: conversationId,
      input: {
        kind: 'user',
        content,
        attrs: {
          source: event.source,
          ...eventAttrs(event),
          runtimeContext: context,
        },
      },
      durable: defaults.durable ?? true,
    });
    this.deliverUndelivered(conversationId, result.session.messages);
  }

  private deliverUndelivered(
    conversationId: string,
    messages: readonly Message<Attrs>[],
  ): void {
    const assistants = messages.filter(
      (message) => message.type === 'assistant',
    );
    for (let index = 0; index < assistants.length; index++) {
      const message = assistants[index];
      const attrs = (message.attrs ?? {}) as Record<string, unknown>;
      const observed = (attrs.observed ?? {}) as Record<string, unknown>;
      const delivery = observed.delivery as DeliveryTarget | undefined;
      const idempotencyKey = `${conversationId}:turn:${
        index + 1
      }:delivery:final`;
      if (this.deliveredKeys.has(idempotencyKey)) {
        continue;
      }
      this.deliveredKeys.add(idempotencyKey);
      if (!delivery || delivery.platform !== 'discord') {
        this.effectEntries.push({
          kind: 'unresolvedDelivery',
          idempotencyKey,
          status: 'skipped',
          target: delivery,
        });
        continue;
      }
      const target = delivery as ConcreteDiscordDeliveryTarget;
      this.discord.deliver({
        platform: 'discord',
        channel: target.channel,
        thread: target.thread,
        content: message.content,
        idempotencyKey,
      });
      this.effectEntries.push({
        kind: 'delivery',
        idempotencyKey,
        status: 'completed',
        target,
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

function resolveInput<TEvent extends RuntimeBindingEvent>(
  binding: RuntimeBinding<TEvent>,
  event: TEvent,
): string {
  if (typeof binding.input === 'function') {
    return binding.input(event as TEvent & Record<string, unknown>);
  }
  if (typeof binding.input === 'string') {
    return binding.input;
  }
  return 'content' in event ? event.content : event.job.name;
}

function mergeDefaults(
  base: BindingDefaults,
  override: BindingDefaults,
): BindingDefaults {
  return {
    ...base,
    ...override,
    context: { ...(base.context ?? {}), ...(override.context ?? {}) },
    behavior: { ...(base.behavior ?? {}), ...(override.behavior ?? {}) },
  };
}

function resolveDelivery(
  delivery: DeliveryTarget | undefined,
  event: RuntimeBindingEvent,
): DeliveryTarget | undefined {
  if (!delivery) {
    return undefined;
  }
  if (delivery.platform === 'origin') {
    if (event.source === 'cron') {
      return event.job.origin;
    }
    return discordOrigin(event);
  }
  if (delivery.platform === 'discord' && 'kind' in delivery) {
    return event.source === 'discord' ? discordOrigin(event) : undefined;
  }
  return delivery;
}

function discordOrigin(
  event: DiscordMessageEvent,
): ConcreteDiscordDeliveryTarget {
  return {
    platform: 'discord',
    channel: event.channel,
    thread: event.thread,
  };
}

function contextFromDefaults(
  conversationId: string,
  defaults: BindingDefaults,
  delivery: DeliveryTarget | undefined,
  event: RuntimeBindingEvent,
): Record<string, unknown> {
  const channelPrompt = resolveChannelPrompt(defaults, event);
  const skills = resolveChannelSkills(defaults, event);
  return {
    ...(defaults.context ?? {}),
    conversationId,
    delivery,
    toolsets: defaults.toolsets,
    skills,
    workdir: defaults.workdir,
    historyBackfill: defaults.context?.historyBackfill,
    channelPrompt,
  };
}

function resolveChannelPrompt(
  defaults: BindingDefaults,
  event: RuntimeBindingEvent,
): string | undefined {
  if (event.source !== 'discord') {
    return undefined;
  }
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

function resolveChannelSkills(
  defaults: BindingDefaults,
  event: RuntimeBindingEvent,
): readonly string[] | undefined {
  if (event.source !== 'discord') {
    return defaults.skills;
  }
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

function eventAttrs(event: RuntimeBindingEvent): Record<string, unknown> {
  if (event.source === 'discord') {
    return {
      author: event.author,
      authorId: event.authorId,
      channel: event.channel,
      channelId: event.channelId,
      thread: event.thread,
    };
  }
  return {
    job: event.job.name,
    jobId: event.job.id,
  };
}

function passesDiscordBehavior(
  event: DiscordMessageEvent,
  behavior: BindingDefaults['behavior'],
): boolean {
  if (!behavior) {
    return true;
  }
  if (
    behavior.allowedChannels &&
    !behavior.allowedChannels.some((channel) =>
      matchesDiscordChannel(event, channel),
    )
  ) {
    return false;
  }
  if (event.thread) {
    const threadCanRespond =
      behavior.threadResponseChannels?.some((channel) =>
        matchesDiscordChannel(event, channel),
      ) ?? true;
    if (threadCanRespond && behavior.threadRequireMention === false) {
      return true;
    }
  }
  if (
    behavior.freeResponseChannels?.some((channel) =>
      matchesDiscordChannel(event, channel),
    )
  ) {
    return true;
  }
  if (behavior.requireMention === false) {
    return true;
  }
  return event.mentionsBot === true;
}

function matchesDiscordChannel(
  event: DiscordMessageEvent,
  channel: string,
): boolean {
  return event.channel === channel || event.channelId === channel;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
