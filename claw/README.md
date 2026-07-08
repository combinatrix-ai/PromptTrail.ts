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
`design-docs/claw-self-authoring.md`. **Phase 0** lands the registry-dispatch
skeleton — no code-generation. **Phase 1** (below) adds authoring + the
verification gate on top of it.

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

## Skills (Phase 1): verified self-authoring

**Phase 1** adds the meta layer: claw can now **author, verify, and activate its
own skills at runtime**, gated by `tsc` + `vitest` before anything goes live.
The parent graph still never recompiles — a new skill is a registry row plus an
in-process map entry (the Phase 0 payoff).

### The loop

```
!skill <instruction>              (in a privileged authoring channel only)
  → synthesize   instruction → a TypeScript skill module (staging dir)
  → gate         typecheck → smoke → graph-validate → capability  (all must pass)
  → hot-load     promote source + built artifact to the durable skills dir,
                 dynamic-import, register into the map + registry (no restart)
  → confirm      reply with the provenance summary (id, gate stages, manifest hash,
                 how to disable) — or, on failure, the failed stage + captured detail
```

### Skill module format (single TypeScript file)

`claw/src/skills/skill-module.ts` defines the shape a synthesized
`staging/<id>.ts` must export:

```ts
import type { Agent, Source } from '@prompttrail/core';
export const meta = { id, name, description };
export const trigger = { channels?: string[]; startsWith?: string; regex?: string };
export const examples: string[]; // >=1 trigger examples; the smoke harness runs each
export function behavior(agent: Agent, reply: Source<string>): Agent {
  return agent.system('...').assistant('reply', reply);
}
```

Two deliberate constraints keep the gate tractable:

- The **trigger is data** (channels + `startsWith`/`regex`), evaluated by the
  framework-owned dispatcher. Arbitrary `when` predicates are Phase 2 (a
  predicate is itself code the gate would have to reason about).
- **`behavior` takes the reply `Source` as a parameter.** Production injects
  claw's configured source (LLM in openai mode, echo otherwise); the gate
  injects a mock source, so the smoke harness never touches the network. Because
  the module imports core only as `type`, the compiled artifact has **zero**
  runtime import of `@prompttrail/core` — pure data plus a builder over the
  caller-supplied `agent`/`reply`.

The synthesizer (`authoring.ts`) has two implementations behind one interface:
`llmSynthesizer` (claw's configured OpenAI model, wired only in openai reply
mode) and `templateSynthesizer` (deterministic, used in tests and echo mode).

### The verification gate (`claw/src/skills/gate.ts`)

Stages run in order — cheapest/most-deterministic first — and **all** must pass;
each records a result persisted with the skill row as provenance
(`{ passed, stages: [{name, ok, detail}], manifestHash?, durationMs }`):

1. **typecheck** — `tsc --noEmit` on the module in a staging dir, as a
   **subprocess** with a ~30s timeout. Non-zero exit → failure, stderr captured.
2. **smoke** — a **framework-owned** vitest harness (regenerated by the gate
   every run; the author cannot weaken it) imports the module and runs
   `behavior(Agent.create(...))` against every declared example with a mock
   reply source, asserting: no throw, a 10s wall-clock cap per example, and a
   non-empty string reply. Run as a **subprocess** (`vitest run`, ~60s timeout).
3. **graph-validate** — build the module (`tsc --outDir`), import it in-process,
   call `behavior`, then `validateAgentGraph` + `createAgentGraphManifest`;
   record the manifest hash (excluded from the parent manifest, §8).
4. **capability** — walk the built graph. Phase 1 skills are **read-only**:
   any tool registration, or any tool/transform carrying an `idempotencyKey`
   (external-write) effect, is rejected. This is the Phase-1 capability ceiling,
   relaxed in Phase 2 with an explicit elevation step.

### Security posture

- **Privileged channel.** Authoring fires only from `CLAW_AUTHORING_CHANNELS`
  (and, if set, `CLAW_AUTHORS`). Unset ⇒ authoring is disabled entirely; a
  normal message can _invoke_ skills but never _author_ them. This is the §6
  authorization boundary against prompt-injection self-modification. Gating is
  enforced both on the dispatch trigger and (defense in depth) inside the
  behavior. One authoring run at a time (a trivial mutex).
- **Read-only ceiling.** The capability stage enforces prompt-only,
  no-external-write behavior for self-authored skills.
- **Subprocess isolation with timeouts.** The untrusted stages (typecheck,
  smoke) run in child processes with explicit timeouts, and provider API keys
  are stripped from the child environment so a stray `Source.llm()` fails fast
  instead of reaching the network. Note: **full network/filesystem sandboxing of
  the gate subprocess is platform work, tracked for Phase 2** — Phase 1 relies
  on the injected mock reply source + key-stripping as the network mitigation.

### Persistence, versions, and restart

On gate pass the skill is promoted (tier `staged`) into `CLAW_SKILLS_DIR`
(default `.data/skills/`): the `.ts` source and built `.js` artifact are copied
there, an immutable version row keyed `(id, manifestHash)` is appended, and the
skill-row `activeVersion` pointer is set (rollback = move the pointer, Phase 2).
On **restart** the boot loader re-imports every enabled non-builtin skill from
its durable source through the same gate-import path, re-running the full gate
**only if the source hash changed** (otherwise it trusts the prior gate and
imports the built artifact directly). Seeded Phase-0 skills are tier `builtin`.

### Tests (Phase 1)

`gate.test.ts` and `authoring.test.ts` cover: the gate rejecting bad TypeScript
(typecheck), a throwing behavior (smoke), and an `idempotencyKey` write effect
(capability); the happy path passing end-to-end and dispatching afterwards;
restart reload (fresh registry + skills dir → skill still dispatches); the
parent manifest hash staying unchanged after authoring; and authoring firing
only in the privileged channel/author allowlist. The subprocess-backed tests
locate `tsc`/`vitest` from the workspace `node_modules`.
