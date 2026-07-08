import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, PromptTrail, Source } from '@prompttrail/core';
import { cron, cronGateway } from '@prompttrail/cron';
import { discord, discordGateway } from '@prompttrail/discord';
import { SqliteRunStore } from '@prompttrail/store-sqlite';
import {
  createAuthorSkill,
  createClawSkillAgent,
  createStatusSkill,
  createSupervisorSkill,
  findClawRoot,
  llmSynthesizer,
  loadStagedSkills,
  quarantineScan,
  registerBuiltinSkills,
  skillToRow,
  SkillRegistry,
  templateSynthesizer,
  validateSkillRegistry,
  type GateOptions,
  type SkillLoaderContext,
  type SkillReplySource,
  type SkillSynthesizer,
  type SupervisionConfig,
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

// Phase 1: authoring + verification gate (design-docs/claw-self-authoring.md
// §4-§6, §10). The reply source is injected into every self-authored skill's
// behavior; the gate uses its own mock source, so this only affects live skills.
const skillsDir =
  readOptionalString('CLAW_SKILLS_DIR') ??
  join(process.cwd(), '.data', 'skills');
const gateOptions: GateOptions = {
  clawRoot: findClawRoot(),
  stagingRoot: join(skillsDir, 'staging'),
};
const replySource = buildSkillReplySource(config);
const synthesizer: SkillSynthesizer =
  config.replyMode === 'openai' && config.openaiModel
    ? llmSynthesizer({ modelName: config.openaiModel })
    : templateSynthesizer;
const loaderContext: SkillLoaderContext = {
  registry,
  skills,
  skillsDir,
  replySource,
  gateOptions,
};

// Restart reload: re-import every enabled self-authored skill from its durable
// source through the same gate-import path (full re-gate only if source changed).
await loadStagedSkills(loaderContext);

// Phase 2 supervision thresholds (design-docs/claw-self-authoring.md §9-§10).
// The health wrapper auto-promotes a clean canary and auto-quarantines a skill
// past the failure threshold; both are registry writes off the hot path.
const supervisionConfig: SupervisionConfig = {
  promoteAfter: readInteger('CLAW_PROMOTE_AFTER', 20),
  quarantineAfter: readInteger('CLAW_QUARANTINE_AFTER', 3),
  supervisorChannel: readOptionalString('CLAW_SUPERVISOR_CHANNEL'),
};

// Register the trusted authoring entry point ONLY when a privileged channel is
// configured (§6 authorization boundary). Without CLAW_AUTHORING_CHANNELS, `!skill`
// does nothing — a normal message can invoke skills but never author them. The
// supervisor commands share the same privileged channel/author gating.
const authoringChannels = readList('CLAW_AUTHORING_CHANNELS', []);
const authors = readList('CLAW_AUTHORS', []);
if (authoringChannels.length > 0) {
  const authorSkill = createAuthorSkill({
    loaderContext,
    synthesizer,
    authoringChannels,
    authors,
  });
  const supervisorSkill = createSupervisorSkill({
    loaderContext,
    supervisorChannels: authoringChannels,
    authors,
  });
  for (const builtin of [supervisorSkill, authorSkill]) {
    skills.set(builtin.id, builtin);
    const row = skillToRow(builtin);
    const existing = registry.get(builtin.id);
    if (existing) {
      // Keep channel narrowing current with the env; respect a manual disable.
      row.enabled = existing.enabled;
    }
    registry.upsert(row);
  }
}

validateSkillRegistry(registry, skills);

// Static registry-dispatch graph: dispatch → conditional(matched skill | default).
const mainAgent = createClawSkillAgent({
  registry,
  skills,
  defaultReply: buildDefaultReply(config),
  supervision: supervisionConfig,
});

// Optional scheduled supervisor: a cron scan that quarantines skills already
// over the failure threshold (catches skills that failed while idle). Wired only
// when CLAW_SUPERVISOR_CRON is set (design-docs §9 scheduled mode).
const supervisorCron = readOptionalString('CLAW_SUPERVISOR_CRON');
const scanAgent = Agent.create('supervisor-scan')
  .inbox('inbound')
  .transform('scan', { effect: { repeatable: true } }, (session) => {
    const quarantined = quarantineScan(registry, supervisionConfig);
    const summary =
      quarantined.length > 0
        ? `supervisor scan: quarantined ${quarantined.join(', ')}`
        : 'supervisor scan: no skills over threshold';
    console.log(summary);
    return session.addMessage({ type: 'assistant', content: summary });
  });

const store = new SqliteRunStore({
  agents: supervisorCron
    ? { main: mainAgent, 'supervisor-scan': scanAgent }
    : { main: mainAgent },
  path: clawDbPath,
});

const runtime = PromptTrail.app({
  name: 'claw-discord',
  store,
  defaults: {
    checkpoint: true,
  },
}).agent('main', mainAgent);

// Scheduled supervisor cron binding (opt-in).
if (supervisorCron) {
  runtime
    .agent('supervisor-scan', scanAgent)
    .on(cron.schedule(supervisorCron), (binding) =>
      binding
        .name('supervisor-scan')
        .toAgent('supervisor-scan')
        .conversation(({ job }) => `cron:${job.id}`)
        .input('quarantine scan'),
    );
}

runtime.on(discord.messages(), (binding) =>
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
    ...(supervisorCron ? [cronGateway()] : []),
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

/**
 * The reply `Source` injected into every self-authored skill's `behavior`
 * (design-docs §2). In openai mode this is the configured LLM; otherwise a
 * degenerate echo callback so template-authored skills still terminate in
 * echo/dev mode. The verification gate never uses this — it injects its own
 * mock source — so no self-authored skill can reach the network during gating.
 */
function buildSkillReplySource(cfg: ClawConfig): SkillReplySource {
  if (cfg.replyMode === 'openai' && cfg.openaiModel) {
    return Source.llm().openai({
      adapter: 'ai-sdk',
      modelName: cfg.openaiModel,
    });
  }
  return Source.callback(async () => '(echo mode: skill reply)');
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
