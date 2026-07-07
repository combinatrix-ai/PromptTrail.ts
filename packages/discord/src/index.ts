import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ClientOptions,
  type Message as DiscordMessage,
} from 'discord.js';
import type {
  BindingDefaults,
  ConversationResolver,
  DeliveryTarget,
  ExecutionEvent,
  Observer,
  ObserverContext,
  RuntimeFilter,
  Trigger,
  TriggerEvent,
} from '@prompttrail/core';
import type {
  RuntimeAdapter,
  RuntimeGatewayContext,
  RuntimePresenceHandle,
} from '@prompttrail/core/runtime_server';

export interface DiscordMessageEvent extends TriggerEvent {
  source: 'discord';
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

export interface DiscordOriginThreadDeliveryTarget extends DeliveryTarget {
  platform: 'discord';
  kind: 'originThread';
}

export interface DiscordChannelDeliveryTarget extends DeliveryTarget {
  platform: 'discord';
  channel: string;
}

export interface ConcreteDiscordDeliveryTarget extends DeliveryTarget {
  platform: 'discord';
  channel: string;
  thread?: string;
}

export interface DiscordBindingBehavior {
  allowedChannels?: readonly string[];
  freeResponseChannels?: readonly string[];
  threadResponseChannels?: readonly string[];
  requireMention?: boolean;
  autoThread?: boolean;
  threadRequireMention?: boolean;
  reactions?: boolean;
  allowAnyAttachment?: boolean;
  maxAttachmentBytes?: number;
}

export const discord = {
  messages(): Trigger<DiscordMessageEvent> {
    return {
      type: 'discord.messages',
      eventAttrs: (event) => ({
        author: event.author,
        authorId: event.authorId,
        channel: event.channel,
        channelId: event.channelId,
        thread: event.thread,
      }),
      resolveDelivery: (delivery, event) => {
        if (delivery.platform === 'origin') {
          return discordOrigin(event);
        }
        if (isDiscordOriginThreadDeliveryTarget(delivery)) {
          return discordOrigin(event);
        }
        return delivery;
      },
      resolveContext: ({ defaults, event }) => ({
        channelPrompt: resolveChannelPrompt(defaults, event),
        skills: resolveChannelSkills(defaults, event),
      }),
      shouldDispatch: (event, defaults) =>
        passesDiscordBehavior(event, defaults.behavior),
    };
  },

  notBot(): RuntimeFilter<DiscordMessageEvent> {
    return (event) => !event.authorBot;
  },

  inChannels(channels: readonly string[]): RuntimeFilter<DiscordMessageEvent> {
    return (event) =>
      channels.some((channel) =>
        channelMatches(event.channel, event.channelId, channel),
      );
  },

  sessionKey(options: {
    groupSessionsPerUser?: boolean;
    threadSessionsPerUser?: boolean;
  }): ConversationResolver<DiscordMessageEvent> {
    return (event) => {
      if (event.isDM) {
        return `discord:dm:${event.authorId}`;
      }
      if (event.thread) {
        const base = `discord:guild:${event.guild}:thread:${event.thread}`;
        return options.threadSessionsPerUser
          ? `${base}:user:${event.authorId}`
          : base;
      }
      const base = `discord:guild:${event.guild}:channel:${event.channelId}`;
      return options.groupSessionsPerUser
        ? `${base}:user:${event.authorId}`
        : base;
    };
  },

  replyToOriginThread(): DiscordOriginThreadDeliveryTarget {
    return { platform: 'discord', kind: 'originThread' };
  },

  channel(channel: string): DiscordChannelDeliveryTarget {
    return { platform: 'discord', channel };
  },
};

export interface DiscordGatewayOptions {
  token?: string;
  client?: Client;
  clientOptions?: ClientOptions;
  stripBotMention?: boolean;
  progress?: false | DiscordProgressObserverOptions;
  onReady?: (client: Client<true>) => void | Promise<void>;
  onError?: (error: unknown, message: DiscordMessage) => void | Promise<void>;
}

export interface DiscordProgressObserverOptions {
  format?: (event: {
    type: 'tool.started' | 'tool.completed';
    toolName?: string;
    toolCallId?: string;
  }) => string | undefined;
  bindings?: DiscordProgressBindingStore;
  bindingTtlMs?: number;
  maxBindingEntries?: number;
}

export interface DiscordProgressBinding {
  idempotencyKey: string;
  target: ConcreteDiscordDeliveryTarget;
  content: string;
  messageId?: string;
  status: 'claimed' | 'sent';
}

export interface DiscordProgressBindingStore {
  claim(
    idempotencyKey: string,
    binding: DiscordProgressBinding,
  ): boolean | Promise<boolean>;
  set(
    idempotencyKey: string,
    binding: DiscordProgressBinding,
  ): void | Promise<void>;
  delete(idempotencyKey: string): void | Promise<void>;
}

export function createDiscordClient(options?: ClientOptions): Client {
  return new Client(options ?? defaultDiscordClientOptions());
}

export function defaultDiscordClientOptions(): ClientOptions {
  return {
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  };
}

export function discordGateway(options: DiscordGatewayOptions): RuntimeAdapter {
  const client = options.client ?? createDiscordClient(options.clientOptions);
  return {
    name: 'discord',
    gateways: [
      {
        type: 'discord.messages',
        async start(ctx) {
          client.once(Events.ClientReady, (readyClient) => {
            void options.onReady?.(readyClient);
          });
          client.on(Events.MessageCreate, (message) => {
            void handleDiscordMessage(ctx, message, options).catch((error) =>
              options.onError
                ? options.onError(error, message)
                : console.error('Failed to handle Discord message', error),
            );
          });
          if (options.token) {
            await client.login(options.token);
          }
        },
        async stop() {
          client.destroy();
        },
      },
    ],
    deliveries: [
      {
        platform: 'discord',
        async deliver(_ctx, target, message) {
          if (!isConcreteDiscordDeliveryTarget(target)) {
            return;
          }
          const channel = await resolveDiscordDeliveryChannel(client, target);
          if (!channel?.isSendable()) {
            console.warn('Discord delivery target is not sendable', target);
            return;
          }
          const sent = await channel.send(message.content);
          return {
            platform: 'discord',
            channelId: sent.channelId,
            messageId: sent.id,
          };
        },
      },
    ],
    presences: [
      {
        platform: 'discord',
        async start(_ctx, target, presence) {
          if (
            !isConcreteDiscordDeliveryTarget(target) ||
            (presence.kind !== 'typing' && presence.kind !== 'processing')
          ) {
            return undefined;
          }
          return startDiscordTyping(client, target);
        },
      },
    ],
    observers:
      options.progress === false
        ? []
        : [discordProgressObserver(client, options.progress)],
  };
}

export function discordProgressObserver(
  client: Client,
  options: DiscordProgressObserverOptions = {},
): Observer {
  const bindings =
    options.bindings ??
    inMemoryDiscordProgressBindings({
      maxEntries: options.maxBindingEntries,
      ttlMs: options.bindingTtlMs,
    });
  return {
    name: 'discordProgress',
    async handle(event, context) {
      if (event.type !== 'tool.started' && event.type !== 'tool.completed') {
        return;
      }
      const delivery = progressDeliveryTarget(context);
      if (!delivery) {
        return;
      }
      const content = options.format
        ? options.format({
            type: event.type,
            toolName: event.name as string | undefined,
            toolCallId: event.toolCallId as string | undefined,
          })
        : defaultDiscordProgressMessage(
            event.type,
            event.name as string | undefined,
          );
      if (!content) {
        return;
      }
      const idempotencyKey = discordProgressIdempotencyKey(event, delivery);
      const claimed = await bindings.claim(idempotencyKey, {
        idempotencyKey,
        target: delivery,
        content,
        status: 'claimed',
      });
      if (!claimed) {
        return;
      }
      const channel = await resolveDiscordDeliveryChannel(client, delivery);
      if (!channel?.isSendable()) {
        await bindings.delete(idempotencyKey);
        return;
      }
      try {
        const sent = await channel.send(content);
        await bindings.set(idempotencyKey, {
          idempotencyKey,
          target: delivery,
          content,
          messageId: discordMessageId(sent),
          status: 'sent',
        });
      } catch (error) {
        await bindings.delete(idempotencyKey);
        throw error;
      }
    },
  };
}

export async function handleDiscordMessage(
  ctx: RuntimeGatewayContext<DiscordMessageEvent>,
  message: DiscordMessage,
  options: Pick<DiscordGatewayOptions, 'stripBotMention'> = {},
): Promise<void> {
  const event = discordMessageToEvent(message.client, message);
  if (!event) {
    return;
  }
  await ctx.emit(event, {
    content: options.stripBotMention
      ? stripBotMention(event.content, message.client.user?.id)
      : event.content,
  });
}

export function discordMessageToEvent(
  client: Client,
  message: DiscordMessage,
): DiscordMessageEvent | undefined {
  if (message.author.bot) {
    return undefined;
  }

  const channel = message.channel;
  const isThread = channel.isThread();
  const parent = isThread ? channel.parent : undefined;
  const channelName =
    (isThread ? parent?.name : 'name' in channel ? channel.name : undefined) ??
    channel.id;
  const channelId = isThread ? (parent?.id ?? channel.id) : channel.id;
  const thread = isThread ? channel.id : undefined;

  return {
    source: 'discord',
    guild: message.guildId ?? `dm:${message.author.id}`,
    channel: channelName,
    channelId,
    thread,
    author: message.author.username,
    authorId: message.author.id,
    authorBot: message.author.bot,
    content: message.content,
    mentionsBot: client.user ? message.mentions.has(client.user) : false,
    isDM: channel.type === ChannelType.DM,
  };
}

export async function resolveDiscordDeliveryChannel(
  client: Client,
  delivery: ConcreteDiscordDeliveryTarget,
) {
  if (delivery.thread) {
    return client.channels.fetch(delivery.thread);
  }
  const channel = client.channels.cache.find(
    (candidate) =>
      candidate.id === delivery.channel ||
      ('name' in candidate && candidate.name === delivery.channel),
  );
  return channel ?? client.channels.fetch(delivery.channel);
}

export async function startDiscordTyping(
  client: Client,
  delivery: ConcreteDiscordDeliveryTarget,
): Promise<RuntimePresenceHandle | undefined> {
  const target = await resolveDiscordDeliveryChannel(client, delivery).catch(
    () => undefined,
  );
  const sendTyping = getSendTyping(target);
  if (!sendTyping) {
    return undefined;
  }

  await sendTyping().catch(() => undefined);
  const interval = setInterval(() => {
    void sendTyping().catch(() => undefined);
  }, 8_000);

  return {
    stop() {
      clearInterval(interval);
    },
  };
}

function getSendTyping(
  target: Awaited<ReturnType<typeof resolveDiscordDeliveryChannel>> | undefined,
): (() => Promise<void>) | undefined {
  if (!target?.isSendable() || !('sendTyping' in target)) {
    return undefined;
  }
  const sendTyping = target.sendTyping;
  if (typeof sendTyping !== 'function') {
    return undefined;
  }
  return () => sendTyping.call(target);
}

function progressDeliveryTarget(
  context: ObserverContext,
): ConcreteDiscordDeliveryTarget | undefined {
  const delivery = context.delivery;
  return isDeliveryTarget(delivery) && isConcreteDiscordDeliveryTarget(delivery)
    ? delivery
    : undefined;
}

function inMemoryDiscordProgressBindings(options: {
  ttlMs?: number;
  maxEntries?: number;
}): DiscordProgressBindingStore {
  const ttlMs = options.ttlMs ?? 60 * 60 * 1_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const bindings = new Map<
    string,
    { binding: DiscordProgressBinding; expiresAt: number }
  >();
  return {
    claim(idempotencyKey, binding) {
      pruneDiscordProgressBindings(bindings, ttlMs, maxEntries);
      if (bindings.has(idempotencyKey)) {
        return false;
      }
      bindings.set(idempotencyKey, {
        binding,
        expiresAt: Date.now() + ttlMs,
      });
      pruneDiscordProgressBindings(bindings, ttlMs, maxEntries);
      return true;
    },
    set(idempotencyKey, binding) {
      pruneDiscordProgressBindings(bindings, ttlMs, maxEntries);
      bindings.set(idempotencyKey, {
        binding,
        expiresAt: Date.now() + ttlMs,
      });
      pruneDiscordProgressBindings(bindings, ttlMs, maxEntries);
    },
    delete(idempotencyKey) {
      bindings.delete(idempotencyKey);
    },
  };
}

function pruneDiscordProgressBindings(
  bindings: Map<string, { binding: DiscordProgressBinding; expiresAt: number }>,
  ttlMs: number,
  maxEntries: number,
): void {
  const now = Date.now();
  for (const [key, entry] of bindings) {
    if (entry.expiresAt <= now) {
      bindings.delete(key);
    }
  }
  while (bindings.size > maxEntries) {
    const oldest = bindings.keys().next().value as string | undefined;
    if (!oldest) {
      break;
    }
    bindings.delete(oldest);
  }
  if (ttlMs <= 0) {
    bindings.clear();
  }
}

function discordProgressIdempotencyKey(
  event: ExecutionEvent,
  delivery: ConcreteDiscordDeliveryTarget,
): string {
  return [
    event.idempotencyKey ?? event.id,
    delivery.platform,
    delivery.channel,
    delivery.thread ?? '-',
  ].join(':');
}

function discordMessageId(sent: unknown): string | undefined {
  if (sent && typeof sent === 'object' && 'id' in sent) {
    const id = (sent as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

export function isConcreteDiscordDeliveryTarget(
  delivery: DeliveryTarget | undefined,
): delivery is ConcreteDiscordDeliveryTarget {
  return (
    delivery?.platform === 'discord' &&
    'channel' in delivery &&
    !('kind' in delivery)
  );
}

export function passesDiscordBehavior(
  event: DiscordMessageEvent,
  behavior: BindingDefaults['behavior'],
): boolean {
  if (!isDiscordBindingBehavior(behavior)) {
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

export function matchesDiscordChannel(
  event: DiscordMessageEvent,
  channel: string,
): boolean {
  return channelMatches(event.channel, event.channelId, channel);
}

function isDiscordBindingBehavior(
  behavior: BindingDefaults['behavior'],
): behavior is DiscordBindingBehavior {
  return !!behavior && typeof behavior === 'object';
}

function isDiscordOriginThreadDeliveryTarget(
  delivery: DeliveryTarget,
): delivery is DiscordOriginThreadDeliveryTarget {
  return delivery.platform === 'discord' && delivery.kind === 'originThread';
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

function channelMatches(
  eventChannel: string,
  eventChannelId: string,
  id: string,
) {
  return eventChannel === id || eventChannelId === id;
}

function resolveChannelPrompt(
  defaults: BindingDefaults,
  event: DiscordMessageEvent,
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

function resolveChannelSkills(
  defaults: BindingDefaults,
  event: DiscordMessageEvent,
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

function isDeliveryTarget(value: unknown): value is DeliveryTarget {
  return (
    !!value &&
    typeof value === 'object' &&
    'platform' in value &&
    typeof (value as { platform?: unknown }).platform === 'string'
  );
}

function defaultDiscordProgressMessage(
  type: 'tool.started' | 'tool.completed',
  toolName: string | undefined,
): string {
  const label = toolName ?? 'tool';
  return type === 'tool.started'
    ? `Running ${label}...`
    : `Completed ${label}.`;
}

function stripBotMention(content: string, botUserId?: string): string {
  if (!botUserId) {
    return content;
  }
  return content
    .replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, 'g'), '')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
