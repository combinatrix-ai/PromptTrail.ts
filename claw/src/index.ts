import 'dotenv/config';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import {
  PromptTrail,
  agent,
  collectCodexTurnResult,
  createCodexAppServerWebSocketClient,
  memoryStore,
} from '@prompttrail/core';
import type { Session } from '@prompttrail/core';
import { discord, discordGateway } from '@prompttrail/discord';

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

const runtime = PromptTrail.app({
  name: 'claw-discord',
  store: memoryStore(),
  defaults: {
    checkpoint: true,
  },
})
  .agent('main', mainAgent)
  .on(discord.messages(), (binding) =>
    binding
      .where(discord.notBot())
      .toAgent('main')
      .conversation(
        discord.sessionKey({
          groupSessionsPerUser: true,
          threadSessionsPerUser: false,
        }),
      )
      .reply(discord.replyToOriginThread())
      .defaults({
        behavior: {
          allowedChannels: config.allowedChannels,
          freeResponseChannels: config.freeResponseChannels,
          requireMention: config.requireMention,
          threadRequireMention: config.threadRequireMention,
          autoThread: false,
        },
        toolsets: ['discord'],
      }),
  );
const bundle = runtime.bundle('claw-discord');

const codexThreadIds = new Map<string, string>();

const server = PromptTrail.server({
  bundle,
  runtime,
  presence: { kind: 'typing' },
  errorMessage: 'Claw failed to handle that message.',
  adapters: [
    discordGateway({
      token: config.token,
      stripBotMention: true,
      onReady(readyClient) {
        console.log(`Claw Discord bot logged in as ${readyClient.user.tag}`);
        console.log(`Allowed channels: ${config.allowedChannels.join(', ')}`);
        console.log(`Reply mode: ${config.replyMode}`);
      },
    }),
  ],
});

await server.start();

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
