import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ClientOptions,
  type Message as DiscordMessage,
} from 'discord.js';
import type { Observer, ObserverContext } from './execution';
import type {
  ConcreteDiscordDeliveryTarget,
  DeliveryTarget,
  DiscordMessageEvent,
} from './runtime_bindings';
import { isConcreteDiscordDeliveryTarget } from './runtime_dispatch';
import type {
  RuntimeActivityHandle,
  RuntimeAdapter,
  RuntimeSourceContext,
} from './runtime_server';

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
    sources: [
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
          await channel.send(message.content);
        },
      },
    ],
    activities: [
      {
        platform: 'discord',
        async start(_ctx, target, activity) {
          if (
            !isConcreteDiscordDeliveryTarget(target) ||
            (activity.kind !== 'typing' && activity.kind !== 'processing')
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
  return {
    name: 'discordProgress',
    replayPolicy: 'live-and-journaled',
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
      const channel = await resolveDiscordDeliveryChannel(client, delivery);
      if (!channel?.isSendable()) {
        return;
      }
      await channel.send(content);
    },
  };
}

export async function handleDiscordMessage(
  ctx: RuntimeSourceContext<DiscordMessageEvent>,
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
): Promise<RuntimeActivityHandle | undefined> {
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
