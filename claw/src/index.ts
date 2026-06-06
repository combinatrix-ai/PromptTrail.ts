import 'dotenv/config';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
} from 'discord.js';
import {
  PromptTrail,
  agent,
  bind,
  discord,
  memoryStore,
  type BindingDefaults,
  type ConcreteDiscordDeliveryTarget,
  type DeliveryTarget,
  type DiscordMessageEvent,
  type RuntimeBinding,
  type RuntimeBindingEvent,
} from '@prompttrail/core';
import type { Message as PromptTrailMessage } from '@prompttrail/core';
import type { Session } from '@prompttrail/core';

interface ClawConfig {
  token: string;
  allowedChannels: string[];
  freeResponseChannels: string[];
  requireMention: boolean;
  threadRequireMention: boolean;
  replyMode: 'echo' | 'openai';
  openaiModel?: string;
}

interface DeliveryRecord {
  conversationId: string;
  deliveredAssistantCount: number;
}

const config = readConfig();

const mainAgent = agent('main').chat('chat', async (session) => ({
  content: await generateReply(session),
}));

const bundle = PromptTrail.bundle({
  name: 'claw-discord',
  agents: {
    main: mainAgent,
  },
  defaults: {
    durable: true,
  },
  bindings: [
    bind(discord.messages())
      .where(discord.notBot())
      .toAgent('main')
      .conversation(
        discord.sessionKey({
          groupSessionsPerUser: true,
          threadSessionsPerUser: false,
        }),
      )
      .defaults({
        delivery: discord.replyToOriginThread(),
        behavior: {
          allowedChannels: config.allowedChannels,
          freeResponseChannels: config.freeResponseChannels,
          requireMention: config.requireMention,
          threadRequireMention: config.threadRequireMention,
          autoThread: false,
        },
        toolsets: ['discord'],
      }),
  ],
});

const runtime = PromptTrail.app({
  store: memoryStore(),
  agents: bundle.agents,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const deliveryRecords = new Map<string, DeliveryRecord>();

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Claw Discord bot logged in as ${readyClient.user.tag}`);
  console.log(`Allowed channels: ${config.allowedChannels.join(', ')}`);
  console.log(`Reply mode: ${config.replyMode}`);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleMessage(message);
  } catch (error) {
    console.error('Failed to handle Discord message', error);
    if (message.channel.isSendable()) {
      await message.channel.send('Claw failed to handle that message.');
    }
  }
});

await client.login(config.token);

async function handleMessage(message: DiscordMessage): Promise<void> {
  const event = toDiscordEvent(message);
  if (!event) {
    return;
  }

  const binding = findBinding('discord.messages', event);
  if (!binding) {
    return;
  }

  const defaults = mergeDefaults(bundle.defaults, binding.defaults);
  if (!passesDiscordBehavior(event, defaults.behavior)) {
    return;
  }

  const conversationId = binding.conversation(event);
  const delivery = resolveDelivery(defaults.delivery, event);
  const result = await runtime.send({
    agent: binding.agent,
    runId: conversationId,
    input: {
      kind: 'user',
      content: stripBotMention(message.content, client.user?.id),
      attrs: {
        source: 'discord',
        author: event.author,
        authorId: event.authorId,
        channel: event.channel,
        channelId: event.channelId,
        thread: event.thread,
        runtimeContext: {
          conversationId,
          delivery,
          toolsets: defaults.toolsets,
        },
      },
    },
    durable: defaults.durable ?? true,
  });

  await deliverNewAssistantMessages(
    conversationId,
    delivery,
    result.session.messages,
  );
}

function toDiscordEvent(
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

function findBinding<TEvent extends RuntimeBindingEvent>(
  sourceType: string,
  event: TEvent,
): RuntimeBinding<TEvent> | undefined {
  return bundle.bindings.find(
    (binding) =>
      binding.source.type === sourceType &&
      binding.filters.every((filter) =>
        (filter as (candidate: TEvent) => boolean)(event),
      ),
  ) as RuntimeBinding<TEvent> | undefined;
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

function passesDiscordBehavior(
  event: DiscordMessageEvent,
  behavior: BindingDefaults['behavior'],
): boolean {
  if (!behavior) {
    return true;
  }
  if (
    behavior.allowedChannels &&
    !behavior.allowedChannels.some((channel) => matchesChannel(event, channel))
  ) {
    return false;
  }
  if (event.thread && behavior.threadRequireMention === false) {
    return true;
  }
  if (
    behavior.freeResponseChannels?.some((channel) =>
      matchesChannel(event, channel),
    )
  ) {
    return true;
  }
  if (behavior.requireMention === false) {
    return true;
  }
  return event.mentionsBot === true;
}

function matchesChannel(event: DiscordMessageEvent, channel: string): boolean {
  return event.channel === channel || event.channelId === channel;
}

function resolveDelivery(
  delivery: DeliveryTarget | undefined,
  event: DiscordMessageEvent,
): ConcreteDiscordDeliveryTarget | undefined {
  if (!delivery) {
    return undefined;
  }
  if (delivery.platform === 'discord' && 'kind' in delivery) {
    return {
      platform: 'discord',
      channel: event.channel,
      thread: event.thread,
    };
  }
  if (delivery.platform === 'discord' && 'channel' in delivery) {
    return delivery;
  }
  return undefined;
}

async function deliverNewAssistantMessages(
  conversationId: string,
  delivery: ConcreteDiscordDeliveryTarget | undefined,
  messages: readonly PromptTrailMessage[],
): Promise<void> {
  if (!delivery) {
    return;
  }
  const assistants = messages.filter((message) => message.type === 'assistant');
  const record = deliveryRecords.get(conversationId) ?? {
    conversationId,
    deliveredAssistantCount: 0,
  };
  const pending = assistants.slice(record.deliveredAssistantCount);
  for (const message of pending) {
    const target = await resolveDiscordDeliveryChannel(delivery);
    if (!target?.isSendable()) {
      console.warn('Discord delivery target is not sendable', delivery);
      continue;
    }
    await target.send(message.content);
    record.deliveredAssistantCount++;
  }
  deliveryRecords.set(conversationId, record);
}

async function resolveDiscordDeliveryChannel(
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

async function generateReply(session: Session): Promise<string> {
  const last = session.getLastMessage();
  const latest = last?.content ?? '';
  if (config.replyMode === 'echo') {
    return `ack: ${latest}`;
  }
  if (!process.env.OPENAI_API_KEY) {
    return 'CLAW_REPLY_MODE=openai requires OPENAI_API_KEY.';
  }
  if (!config.openaiModel) {
    return 'CLAW_REPLY_MODE=openai requires CLAW_OPENAI_MODEL.';
  }

  const result = await generateText({
    model: openai(config.openaiModel),
    system: 'You are Claw, a concise Discord-native PromptTrail agent.',
    messages: session.messages
      .filter((message) => message.type !== 'tool_result')
      .map((message) => ({
        role: message.type === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      })),
  });
  return result.text;
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

function readConfig(): ClawConfig {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN is required');
  }
  const requireMention = readBoolean('DISCORD_REQUIRE_MENTION', false);
  return {
    token,
    allowedChannels: readList('DISCORD_ALLOWED_CHANNELS', ['general']),
    freeResponseChannels: readList(
      'DISCORD_FREE_RESPONSE_CHANNELS',
      requireMention ? [] : ['general'],
    ),
    requireMention,
    threadRequireMention: readBoolean('DISCORD_THREAD_REQUIRE_MENTION', false),
    replyMode: process.env.CLAW_REPLY_MODE === 'openai' ? 'openai' : 'echo',
    openaiModel: process.env.CLAW_OPENAI_MODEL,
  };
}

function readList(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
