# Claw Bot

Claw is a dogfooding bot for the PromptTrail runtime bindings work. It uses the
real `PromptTrail.app(...).on(discord.messages(), ...)` API and a real
`discord.js` gateway client, and — as the second channel that validates
`runtime_bindings` is not Discord-shaped — an optional `telegram.messages()`
binding backed by `@prompttrail/telegram`'s dependency-free long-polling client.

Claw boots with **Discord, Telegram, or both**. Set `DISCORD_TOKEN`,
`TELEGRAM_TOKEN`, or both; startup fails fast only when neither is present. Both
channels share the same dispatch/skills agent — a message from either platform
routes to the same `main` agent, with the conversation id derived from the
platform's own `sessionKey`.

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

## Telegram channel

Set `TELEGRAM_TOKEN` (a bot token from [@BotFather](https://t.me/BotFather)) to
add a Telegram gateway. `@prompttrail/telegram` implements the same generic
`RuntimeAdapter` contract as `@prompttrail/discord` with no heavy SDK — it talks
to the Bot API over plain HTTPS long-polling (`getUpdates`) using the global
`fetch` on Node 22+.

- Conversations key on the chat id via `telegram.sessionKey({ groupSessionsPerUser: true })`:
  DMs are naturally per-user; group chats get one conversation per user.
- `TELEGRAM_ALLOWED_CHATS` (comma-separated numeric ids or `@usernames`, empty =
  any) restricts which chats the bot processes.
- `TELEGRAM_REQUIRE_MENTION=true` requires an `@botusername` mention in group
  chats and strips it from the input; DMs never require a mention.
- Replies go back to the originating chat (`telegram.replyToChat()`), threaded to
  the source message in groups, and are chunked to Telegram's 4096-char limit.

```bash
TELEGRAM_TOKEN=...
TELEGRAM_ALLOWED_CHATS=
TELEGRAM_REQUIRE_MENTION=false
```

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

## Skills (Phase 2): supervision & lifecycle

**Phase 2** adds the **control plane** beside the data plane (the dispatcher):
trust tiers, automatic promotion/quarantine, an on-demand supervisor command
surface, rollback via an active-version pointer, and a full provenance/audit
trail. The governing rule from `design-docs/claw-self-authoring.md` §9 holds:
**instrument every skill run, but never proxy them through a blocking
supervisor.** The supervisor is human-authored, trusted, in-repo code _outside_
the self-authoring loop; nothing here recompiles the parent graph.

### Trust tiers

```
builtin        hand-written, trusted (status, author-skill, supervisor)
staged         gate-passed, not yet activated (transient — authoring moves on immediately)
  │  activate
  ▼
canary         LIVE and dispatching, but closely watched + read-only ceiling
  │  auto: N clean invocations (CLAW_PROMOTE_AFTER)
  ▼
trusted        auto-promoted; still read-only in Phase 2 (write elevation deferred)
  ↘  auto: K consecutive failures (CLAW_QUARANTINE_AFTER), or !quarantine
quarantined    dispatcher SKIPS it (like disabled); !restore → canary
```

**Canary is live.** Phase 1's "activated" state is exactly canary: a
gate-passed skill dispatches immediately, but is flagged for close watching and
capped at the read-only ceiling. The authoring flow now records the
`staged → canary` transition explicitly (both steps audited); the persisted tier
is the terminal `canary`.

- **Auto-promotion** (`canary → trusted`) and **auto-quarantine**
  (`* → quarantined`) are evaluated in the **health wrapper** after each
  invocation — cheap, data-plane, off the blocking path. Both are registry
  writes. Builtin skills are never touched.
- **Rollback = an active-version pointer.** Every gated build keeps an immutable
  per-version artifact under `<skillsDir>/versions/<id>.<hash>.js`. `!rollback`
  repoints `activeVersion` to the previous version row and rebinds the in-process
  behavior — instant, and (because the skill subroutine hash is excluded from the
  parent manifest, §8) it disturbs neither the parent graph nor live
  conversations.

### Supervisor commands

A built-in, trusted `supervisor` skill (registered only when
`CLAW_AUTHORING_CHANNELS` is set, sharing the same privileged channel/author
gating as `!skill`). All are read-only w.r.t. capabilities:

| Command            | Effect                                                                       |
| ------------------ | ---------------------------------------------------------------------------- |
| `!skills`          | List every skill: id, name, tier, enabled, invocations, failures, hash short |
| `!promote <id>`    | One step: `staged → canary`, or `canary → trusted` (trust tier **only**)     |
| `!quarantine <id>` | Force `→ quarantined`; the dispatcher stops matching it                       |
| `!restore <id>`    | `quarantined → canary`, resetting the consecutive-failure streak             |
| `!rollback <id>`   | Move the active-version pointer to the previous version; error if none       |
| `!why <id>`        | Last error/latency, failure counts, gate summary, recent audit entries       |

`!skills` and `!why` also drain any buffered supervisor notices (below).

### Provenance / audit surface

Every tier transition appends a row to `skill_audit`
(`skillId, from, to, reason, actor, at`); `actor` is `auto` for supervisor logic
or the author/supervisor id for a command. `!why` shows the most recent entries;
`!skills` and `!why` expose the live health + version state. This is the
auditable trail of every promote/demote/rollback the design calls for.

### Supervisor invocation modes (§9)

- **On-demand** — the commands above.
- **Scheduled** — set `CLAW_SUPERVISOR_CRON` (a cron expression) to wire a cron
  binding (via `@prompttrail/cron`'s `cron.schedule` + `cronGateway`) that runs
  the quarantine scan, catching skills that crossed the failure threshold **while
  idle** (the reactive path only fires on invocation).
- **Reactive** — when the health wrapper trips the quarantine threshold it
  **buffers a pending notice** rather than posting to a channel directly.
  Delivering a message to `CLAW_SUPERVISOR_CHANNEL` from inside the wrapper is
  awkward in claw's message-triggered binding model — the wrapper runs while
  replying to the _triggering_ message and has no handle to a different channel —
  so the notice is written to a durable `skill_notices` row and surfaced by the
  next `!skills`/`!why` command or scheduled scan (then marked delivered). This
  keeps the supervisor strictly off the hot path.

### Env vars

| Var                     | Default | Meaning                                       |
| ----------------------- | ------- | --------------------------------------------- |
| `CLAW_PROMOTE_AFTER`    | `20`    | Clean invocations before `canary → trusted`   |
| `CLAW_QUARANTINE_AFTER` | `3`     | Consecutive failures before `→ quarantined`   |
| `CLAW_SUPERVISOR_CHANNEL` | (unset) | Channel a reactive notice is intended for     |
| `CLAW_SUPERVISOR_CRON`  | (unset) | Cron expr for the scheduled quarantine scan   |

### Capability elevation is deferred

Phase 2 does **not** grant write capability. The verification gate still rejects
any external-write effect (`idempotencyKey`) and any tool registration, so the
read-only ceiling holds for **every** self-authored skill at **every** tier.
`!promote` raises the _trust_ tier (how closely a skill is watched), never the
_capability_ ceiling. Write elevation with an explicit human-confirmation step
(§6/§9) is left to a later pass.

### Deferred to later passes

- **Capability elevation** (self-authored write effects) — see above.
- **Curator** — the scoring/merging/pruning pass over the skill library (§10) is
  explicitly a later pass and is not implemented here.
- **Git as audit archive** (§9 open question) — one commit per gated version for
  human-reviewable diffs. Live tier/health/pointer state stays in the durable
  store; the git export is out of scope for now.

### Tests (Phase 2)

`supervisor.test.ts` covers: the tier lifecycle (`staged → canary` on activate,
`canary → trusted` after N clean runs, auto-quarantine after K failures, the
dispatcher skipping a quarantined skill, `!restore` resetting the failure
streak); rollback moving the pointer so the _previous_ version's behavior
dispatches again (author v1, author v2 same id, `!rollback` → v1 replies);
supervisor command channel/author gating; audit rows written on every
transition; and the scheduled scan quarantining a skill that failed while idle.
