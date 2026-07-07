import 'dotenv/config';
import { join } from 'node:path';
import { Agent, PromptTrail, Source } from '@prompttrail/core';
import { discord, discordGateway } from '@prompttrail/discord';
import { SqliteRunStore } from '@prompttrail/store-sqlite';

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

let mainAgent: Agent;

if (config.replyMode === 'echo') {
  mainAgent = Agent.create('main').assistant(
    'reply',
    (session) => `ack: ${session.getLastMessage()?.content ?? ''}`,
  );
} else if (config.replyMode === 'openai') {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('CLAW_REPLY_MODE=openai requires OPENAI_API_KEY.');
  }
  if (!config.openaiModel) {
    throw new Error('CLAW_REPLY_MODE=openai requires CLAW_OPENAI_MODEL.');
  }
  mainAgent = Agent.create('main')
    .system(
      'persona',
      'You are Claw, a concise Discord-native PromptTrail agent.',
    )
    .assistant(
      'reply',
      Source.llm().openai({ adapter: 'ai-sdk', modelName: config.openaiModel }),
    );
} else {
  // codex
  mainAgent = Agent.create('main').codex('reply', {
    transport: {
      kind: 'websocket',
      url: config.codexAppServerUrl,
      timeoutMs: config.codexTimeoutMs,
    },
    cwd: config.codexCwd,
    model: config.codexModel,
    sandboxPolicy: { type: 'readOnly' },
    approvalPolicy: 'never',
  });
}

const clawDbPath =
  readOptionalString('CLAW_DB_PATH') ?? join(process.cwd(), '.data', 'claw.db');

const store = new SqliteRunStore({
  agents: { main: mainAgent },
  path: clawDbPath,
});

const runtime = PromptTrail.app({
  name: 'claw-discord',
  store,
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
