import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, PromptTrail, Source } from '@prompttrail/core';
import { discord, discordGateway } from '@prompttrail/discord';
import { SqliteRunStore } from '@prompttrail/store-sqlite';
import {
  createClawSkillAgent,
  createStatusSkill,
  registerBuiltinSkills,
  SkillRegistry,
  validateSkillRegistry,
} from './skills/index.js';

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
const startedAt = Date.now();
const version = readPackageVersion();

const clawDbPath =
  readOptionalString('CLAW_DB_PATH') ?? join(process.cwd(), '.data', 'claw.db');
const skillDbPath =
  readOptionalString('CLAW_SKILL_DB_PATH') ??
  join(process.cwd(), '.data', 'claw-skills.db');

// Persistent skill registry (design-docs/claw-self-authoring.md §7). Seeded
// with the hand-written skills on first boot; unknown refs warn but never crash.
const registry = new SkillRegistry(skillDbPath);
const skills = registerBuiltinSkills(registry, [
  createStatusSkill({ version, replyMode: config.replyMode, startedAt }),
]);
validateSkillRegistry(registry, skills);

// Static registry-dispatch graph: dispatch → conditional(matched skill | default).
const mainAgent = createClawSkillAgent({
  registry,
  skills,
  defaultReply: buildDefaultReply(config),
});

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
        console.log(
          `Skills: ${registry
            .listEnabled()
            .map((row) => row.id)
            .join(', ')}`,
        );
      },
    }),
  ],
});

await server.start();

/**
 * Build the default reply node(s) — the existing echo/openai/codex behavior,
 * run when no skill trigger matches. Validation is fail-fast at boot.
 */
function buildDefaultReply(cfg: ClawConfig): (agent: Agent) => Agent {
  if (cfg.replyMode === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('CLAW_REPLY_MODE=openai requires OPENAI_API_KEY.');
    }
    if (!cfg.openaiModel) {
      throw new Error('CLAW_REPLY_MODE=openai requires CLAW_OPENAI_MODEL.');
    }
    const openaiModel = cfg.openaiModel;
    return (agent) =>
      agent
        .system(
          'persona',
          'You are Claw, a concise Discord-native PromptTrail agent.',
        )
        .assistant(
          'reply',
          Source.llm().openai({ adapter: 'ai-sdk', modelName: openaiModel }),
        );
  }
  if (cfg.replyMode === 'codex') {
    return (agent) =>
      agent.codex('reply', {
        transport: {
          kind: 'websocket',
          url: cfg.codexAppServerUrl,
          timeoutMs: cfg.codexTimeoutMs,
        },
        cwd: cfg.codexCwd,
        model: cfg.codexModel,
        sandboxPolicy: { type: 'readOnly' },
        approvalPolicy: 'never',
      });
  }
  // echo
  return (agent) =>
    agent.assistant(
      'reply',
      (session) => `ack: ${session.getLastMessage()?.content ?? ''}`,
    );
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
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
