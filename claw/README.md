# Claw Discord Bot

Claw is a dogfooding Discord bot for the PromptTrail runtime bindings work. It
uses the real `PromptTrail.app(...).on(discord.messages(), ...)` API and a real
`discord.js` gateway client.

## Setup

Create an application and bot in the Discord Developer Portal, then enable:

- `MESSAGE CONTENT INTENT`
- `SERVER MEMBERS INTENT` is not required for this initial bot.
- `PRESENCE INTENT` is not required.

Invite the bot with at least:

- `Send Messages`
- `Read Message History`
- `View Channels`

For local smoke testing:

```bash
cp claw/.env.example claw/.env
```

Fill in `DISCORD_TOKEN`, then run:

```bash
pnpm -C packages/core build
pnpm -C packages/store-sqlite build
pnpm -C packages/discord build
pnpm -C claw dev
```

By default `CLAW_REPLY_MODE=echo`, so the bot replies without calling an LLM.
For OpenAI-backed replies:

```bash
CLAW_REPLY_MODE=openai
OPENAI_API_KEY=...
CLAW_OPENAI_MODEL=...
```

For Codex App Server-backed replies:

```bash
CLAW_REPLY_MODE=codex
CODEX_APP_SERVER_URL=ws://127.0.0.1:8390
# Optional. If omitted, Codex App Server chooses its default model.
CLAW_CODEX_MODEL=
```

Codex mode starts one Codex thread per PromptTrail conversation id while the bot
process is alive. It uses a read-only sandbox and `approvalPolicy: "never"` so a
Discord message cannot trigger repository writes or approval prompts.

## Routing

The bot uses these binding defaults:

- Parent channel conversations are per Discord user.
- Thread conversations are shared by all participants.
- Allowed channels come from `DISCORD_ALLOWED_CHANNELS`.
- If `DISCORD_REQUIRE_MENTION=false`, messages in allowed/free-response
  channels wake the agent without mentioning the bot.
- If `DISCORD_THREAD_REQUIRE_MENTION=false`, active threads can continue
  without mentioning the bot.

This is intentionally close to the Hermes-style scenario in
`design-docs/runtime-bindings-discord-cron.md`.

## Skills (Phase 0)

Claw is being grown into a self-authoring meta-agent per
`design-docs/claw-self-authoring.md`. **Phase 0** (this code) lands the
registry-dispatch skeleton — no code-generation yet.

A **skill** is a plain TypeScript value (`claw/src/skills/types.ts`):

- `trigger` — `{ channel?, predicateKey, when(content, ctx) }`, the routing
  predicate the dispatcher reads.
- `behavior` — `(agent) => agent`, a subroutine body that produces the reply.
- `provenance` — `{ authoredBy, motivation, createdAt }` for audit/pruning.

### Registry-dispatch graph

The main agent has one **static** shape, regardless of how many skills exist:

```
dispatch (transform)  → record the first matching skill id in a session var
route (conditional)   → then: run that skill's behavior subroutine
                        else: the default echo/openai/codex reply
```

Adding, enabling, or disabling a skill is a **registry row** change, never a
graph recompile — so the parent graph's manifest hash is stable and long-lived
conversations keep resuming (design §3/§8). A test asserts the parent manifest
hash does not change when registry rows are added.

### Persistence & health

The `SkillRegistry` (`claw/src/skills/registry.ts`) is a separate SQLite store
(its own file, default `.data/claw-skills.db`, override via
`CLAW_SKILL_DB_PATH`). Rows carry the serializable subset (channel +
`predicateKey` + `behaviorRef`); the executable `when`/`behavior` live in an
in-process map keyed by skill id, joined at runtime. Unknown `behaviorRef`s warn
at boot but never crash. Every skill invocation is instrumented into a per-skill
health record (invocations, successes, consecutiveFailures, lastError,
lastLatencyMs); no supervisor/tiers yet.

### Seeded skill

On first boot claw seeds one hand-written skill, `status`: a message beginning
with `!status` (any channel) replies with the bot's version, reply mode, and
uptime, e.g. `claw v0.0.1 | reply-mode: echo | uptime: 42s`.

### Tests

```bash
pnpm -C claw test        # dispatch, persistence, health, disabled, manifest stability
pnpm -C claw typecheck
```
