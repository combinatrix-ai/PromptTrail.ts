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
  AssistantDeliveryTracker,
  agent,
  bind,
  collectCodexTurnResult,
  createCodexAppServerWebSocketClient,
  dispatchRuntimeBindingEvent,
  discord,
  findRuntimeBinding,
  isConcreteDiscordDeliveryTarget,
  memoryStore,
  mergeBindingDefaults,
  passesDiscordBehavior,
  resolveRuntimeDelivery,
  resolveRuntimeInput,
  type ConcreteDiscordDeliveryTarget,
  type DiscordMessageEvent,
} from '@prompttrail/core';
import type { Message as PromptTrailMessage } from '@prompttrail/core';
import type { Session } from '@prompttrail/core';

interface ClawConfig {
  token: string;
  allowedChannels: string[];
  freeResponseChannels: string[];
  requireMention: boolean;
  threadRequireMention: boolean;
  replyMode: 'echo' | 'openai' | 'codex';
  openaiModel?: string;
  codexAppServerUrl: string;
  codexModel?: string;
  codexCwd: string;
  codexTimeoutMs: number;
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

const deliveryTracker = new AssistantDeliveryTracker();
const codexThreadIds = new Map<string, string>();

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

  const binding = findRuntimeBinding(bundle, 'discord.messages', event);
  if (!binding) {
    return;
  }

  const defaults = mergeBindingDefaults(bundle.defaults, binding.defaults);
  if (!passesDiscordBehavior(event, defaults.behavior)) {
    return;
  }

  const delivery = resolveRuntimeDelivery(defaults.delivery, event);
  const discordDelivery = isConcreteDiscordDeliveryTarget(delivery)
    ? delivery
    : undefined;
  const dispatched = await withTypingIndicator(discordDelivery, () =>
    dispatchRuntimeBindingEvent({
      app: runtime,
      binding,
      event,
      defaults,
      content: stripBotMention(
        resolveRuntimeInput(binding, event),
        client.user?.id,
      ),
    }),
  );

  await deliverNewAssistantMessages(
    dispatched.conversationId,
    discordDelivery,
    dispatched.result.session.messages,
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

async function deliverNewAssistantMessages(
  conversationId: string,
  delivery: ConcreteDiscordDeliveryTarget | undefined,
  messages: readonly PromptTrailMessage[],
): Promise<void> {
  if (!delivery) {
    return;
  }
  for (const deliveryAttempt of deliveryTracker.pending(
    conversationId,
    messages,
  )) {
    const target = await resolveDiscordDeliveryChannel(delivery);
    if (!target?.isSendable()) {
      console.warn('Discord delivery target is not sendable', delivery);
      continue;
    }
    await target.send(deliveryAttempt.message.content);
    deliveryTracker.markDelivered(deliveryAttempt);
  }
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

async function withTypingIndicator<T>(
  delivery: ConcreteDiscordDeliveryTarget | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const target = delivery
    ? await resolveDiscordDeliveryChannel(delivery).catch(() => undefined)
    : undefined;
  const sendTyping = getSendTyping(target);
  if (!sendTyping) {
    return task();
  }

  await sendTyping().catch(() => undefined);
  const interval = setInterval(() => {
    void sendTyping().catch(() => undefined);
  }, 8_000);

  try {
    return await task();
  } finally {
    clearInterval(interval);
  }
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

async function generateReply(session: Session): Promise<string> {
  const last = session.getLastMessage();
  const latest = last?.content ?? '';
  if (config.replyMode === 'echo') {
    return `ack: ${latest}`;
  }
  if (config.replyMode === 'codex') {
    return generateCodexReply(session, latest);
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

async function generateCodexReply(
  session: Session,
  latest: string,
): Promise<string> {
  const runtimeContext = getRuntimeContext(session);
  const conversationId = runtimeContext?.conversationId ?? 'default';
  const client = createCodexAppServerWebSocketClient({
    url: config.codexAppServerUrl,
    timeoutMs: config.codexTimeoutMs,
    clientInfo: {
      name: 'prompttrail_claw',
      title: 'PromptTrail Claw',
      version: '0.0.1',
    },
  });

  try {
    const threadId =
      codexThreadIds.get(conversationId) ??
      (
        await client.startThread({
          cwd: config.codexCwd,
          model: config.codexModel,
          sandboxPolicy: { type: 'readOnly' },
          approvalPolicy: 'never',
        })
      ).threadId;
    codexThreadIds.set(conversationId, threadId);

    const rawResult = await client.startTurn({
      threadId,
      input: [
        {
          type: 'text',
          text: latest,
        },
      ],
      cwd: config.codexCwd,
      model: config.codexModel,
      sandboxPolicy: { type: 'readOnly' },
      approvalPolicy: 'never',
    });
    const result = isAsyncIterable(rawResult)
      ? await collectCodexTurnResult(rawResult, { threadId })
      : rawResult;

    const finalAnswer = result.finalAnswer?.trim();
    if (!finalAnswer) {
      throw new Error('Codex App Server returned no final answer.');
    }
    return finalAnswer;
  } catch (error) {
    codexThreadIds.delete(conversationId);
    console.error('Codex App Server reply failed', error);
    return codexFailureMessage(error);
  } finally {
    await client.close?.();
  }
}

function codexFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('timed out')) {
    return 'Codex App Server の応答がタイムアウトしました。次のメッセージでは新しい Codex thread で再試行します。';
  }
  return 'Codex App Server から応答を取得できませんでした。次のメッセージでは新しい Codex thread で再試行します。';
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' && value !== null && Symbol.asyncIterator in value
  );
}

function getRuntimeContext(
  session: Session,
): { conversationId?: string } | undefined {
  const attrs = session.getLastMessage()?.attrs as
    | { runtimeContext?: { conversationId?: string } }
    | undefined;
  return attrs?.runtimeContext;
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
    replyMode: readReplyMode(),
    openaiModel: readOptionalString('CLAW_OPENAI_MODEL'),
    codexAppServerUrl:
      readOptionalString('CODEX_APP_SERVER_URL') ?? 'ws://127.0.0.1:8390',
    codexModel: readOptionalString('CLAW_CODEX_MODEL'),
    codexCwd: readOptionalString('CLAW_CODEX_CWD') ?? process.cwd(),
    codexTimeoutMs: readInteger('CLAW_CODEX_TIMEOUT_MS', 300_000),
  };
}

function readReplyMode(): ClawConfig['replyMode'] {
  const value = process.env.CLAW_REPLY_MODE;
  if (value === 'openai' || value === 'codex') {
    return value;
  }
  return 'echo';
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

function readOptionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
