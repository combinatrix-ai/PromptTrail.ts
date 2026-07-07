# Positioning and Claw Roadmap

## Purpose

This document records the competitive analysis done in June 2026 and the
strategic decisions derived from it: where PromptTrail sits relative to
LangGraph, Mastra, and the durable-execution runtimes; which durability
guarantees we add on top of the checkpoint model; and the roadmap for growing
`claw/` into a Hermes-equivalent personal agent whose behavior is defined by
typed, verified DSL code rather than markdown config.

It complements `agent-runtime-unification.md` (execution model) and
`runtime-bindings-discord-cron.md` (bindings). Where this document talks about
execution semantics, the unification doc is authoritative.

## Competitive Landscape (as of 2026-06)

Reference clones live in `references/` (gitignored): `langchainjs`,
`mastra`, `hermes-agent`, `temporal-sdk-typescript`, `restate-sdk-typescript`,
`inngest-js`.

### LangGraph (1.x, Python + JS)

- Authoring is imperative graph wiring (`add_node`/`add_edge`/`compile`).
  The artifact is declarative; the construction code is not. Subgraphs exist
  but require state-schema translation at boundaries.
- JS parity is no longer a weakness (1.0 shipped simultaneously with Python
  in Oct 2025; StateSchema supports Zod 4 / Standard Schema). "LangGraph JS is
  immature" is a stale argument; "it is a Python design transliterated to TS"
  still holds.
- Durability is checkpoint-based, same family as ours — **not** Temporal-style.
  The widely cited Diagrid critique ("Checkpoints Are Not Durable Execution")
  applies: OSS LangGraph is single-process, has no crash auto-resume, no
  multi-writer protection, no scheduler. Those live in the paid LangSmith
  Deployment platform (cron, background runs, task queues).

### Mastra (v1, Apache 2.0 since 2025-07)

- The closest TS competitor. Declarative chained workflows
  (`.then/.branch/.parallel`), Zod-or-Standard-Schema everywhere, snapshot
  based suspend/resume, batteries included (memory, RAG, scorers, studio,
  MCP both directions, many storage adapters).
- Workflows are a general-purpose engine: steps are plain async functions and
  LLM involvement is optional. Agent-as-step and workflow-as-tool composition
  is first-class. The generic "Workflow as Code" lane is already taken; our
  lane is **conversation as a first-class workflow** plus deeper durability.
- Their summarization answer is Observational Memory (early 2026): two
  background agents append to an observation log once raw history exceeds a
  token threshold; raw messages drop out of context but are never rewritten.
  Append-only is the part worth copying (see Memory below).
- License: core is Apache 2.0; code under `ee/` directories is under the
  Mastra Enterprise License. **Do not lift code from `ee/`.**

### Durable-execution runtimes (Temporal, Restate, Inngest, DBOS)

- All are framework-agnostic and positioning into AI (Temporal × OpenAI Agents
  SDK and Vercel AI SDK; Restate middleware for AI SDK; Inngest AgentKit).
  PydanticAI outsources durability to them entirely.
- We keep durability in-house because the conversation DSL and the durable
  runtime being one thing is the product. But what these runtimes actually
  sell is **operational guarantees**, not replay — see below.

### OpenClaw and Hermes (the claw target space)

- OpenClaw (TS, gateway-first, ~378k stars): behavior defined by 6+ markdown
  files injected into the system prompt (`SOUL.md`, `AGENTS.md`, `MEMORY.md`,
  `SKILL.md` per skill, ...). Documented failure modes: config "ball of mud",
  conflicting duplicated instructions, silent prompt truncation, a skill
  marketplace where an audit claims ~36% of skills contain injection payloads,
  40k+ publicly exposed instances, CVEs.
- Hermes Agent (Nous Research, Python, ~189k stars): runtime-first with a
  closed learning loop — after any complex task the agent autonomously writes
  a reusable skill from its own execution trace; a weekly Curator scores,
  merges, and prunes the skill library. Skills are still markdown prose.
  Their `hermes-agent-self-evolution` pipeline (GEPA-evolved SKILL.md gated by
  a 100% test pass + mandatory human review) is the nearest prior art for
  "self-modification behind a verification gate" — it validates the need but
  lacks a typed substrate.
- **The open lane**: nobody ships "agent behavior as a typed, compiled DSL
  that the agent itself writes, verified by typecheck + tests before
  activation". PromptTrail has the required parts already: serializable
  `AgentGraph`, manifest hashing, graph validation before execution, and
  (soon) binary effect declarations usable as capability bounds.

## Durability Stance: Checkpoint + Operational Guarantees

Checkpoint-not-replay (per the unification doc) is confirmed; full Temporal
semantics (determinism contract, event-sourced replay, task queues) remain a
non-goal. What we add instead are the operational guarantees that the OSS
checkpoint frameworks lack:

1. **Orphan auto-resume.** On server boot (and periodically), scan the run
   store for runs that were in-flight when a process died and resume them.
   OSS LangGraph requires a human to re-invoke; doing this automatically is a
   real differentiator. Requires §1.6 (async store) and a liveness marker on
   stored runs.
2. **Single-writer lease per conversation.** Two processes resuming the same
   run must not double-commit side effects. The in-process conversation lock
   in `runtime_server.ts` is not enough; the run store needs a lease
   (holder id + expiry, renewed by heartbeat) so resume is store-arbitrated.
3. **Durable timers and signals.** `sleep('7d')` that survives restarts
   (persist wake-at, scheduler re-arms on boot) and external signals that
   wake a suspended run. `awaitInput` is half of signals already; timers
   should unify with the cron trigger plumbing rather than grow a second
   scheduler.
4. **Async store first.** Change-list §1.6 is the prerequisite for all of the
   above and for at-least-once itself. Nothing in this section starts before
   it lands.

Ordering: these go into the change list _after_ §1 (durability collapse)
completes. This document only fixes the direction.

## Schema Strategy

- Zod is already a hard dependency (tools, structured output). Extend, don't
  introduce.
- Accept **Standard Schema** at every schema intake point (tool input,
  structured output, and new surfaces) with Zod as the documented default.
  Upgrade the dependency range to support Zod 4 (`^3.25 || ^4`), matching the
  ecosystem (Mastra, LangGraph JS StateSchema).
- Add **optional vars/attrs schemas** (`Session.create({ varsSchema })`).
  Today vars typing is compile-time only; under checkpoint durability vars
  round-trip through the store, so runtime validation on resume catches
  checkpoint corruption and schema drift. Opt-in; gradual typing stays.

## Memory: Append-Only Compaction

Summarization must not rewrite history. `session.messages` is the effect
journal under the checkpoint model, and `ctx.once` deps may hash the session;
destructive rewriting breaks both. The design rule:

- Compaction is an explicit, checkpointed transform that **appends** a summary
  (observation log entry) and advances a context-assembly pointer. Raw
  messages leave the _prompt_, never the _journal_.
- This is Mastra's Observational Memory shape translated into our model, and
  it keeps prompt-cacheability (append-only prefix) for free.
- RAG/semantic recall is commodity and low priority; it can be built later as
  a source or middleware without new core machinery.

A dedicated memory design doc should be written before implementation.

## Claw Roadmap: Hermes-Equivalent with Verified Self-Improvement

Claw is the acceptance test for the framework. Each step below dogfoods a
core capability; ordering follows core readiness.

1. **Persistent run store** (SQLite first, Postgres later) — lands together
   with §1.6/§1.7. Claw currently loses everything on restart, including the
   Codex thread map.
2. **Dissolve `generateReply`** — replace the hand-written echo/OpenAI/Codex
   switch with `.assistant()` / `.codex()` nodes; Codex thread lifecycle moves
   into core per §1.8. Claw should reduce to agent definition + bindings.
3. **Cron triggers** — implement the `cron.schedule()` binding for real
   (morning summaries, reminders); doubles as the durable-timer testbed.
4. **Memory** — the append-only compaction transform plus persistent
   conversation-scoped facts.
5. **Typed skill self-authoring** — the differentiator:
   - A skill is a TS module exporting a PromptTrail template (likely a
     subroutine), not a markdown file.
   - The agent gets an author tool: write skill code → `tsc` typecheck →
     `vitest` run → manifest hash assigned → hot-load into the running
     bundle. Any gate failure means the skill never activates.
   - Effect declarations (`idempotencyKey` / `repeatable`) double as
     capability bounds on what a self-authored skill may do.
6. **Second channel** (Slack or Telegram) — validates that
   `runtime_bindings` is not Discord-shaped.

Positioning phrase for claw: **verified self-improvement** — Hermes's learning
loop with a typechecker and test gate where Hermes has prose.

The full mechanism design for this section lives in `claw-self-authoring.md`
(skill = trigger + behavior subroutine + provenance; registry-dispatch over a
static graph; the pre-activation gate; phased Phase 0/1/2 roadmap).

## Security Posture

Self-authoring is arbitrary code execution by construction, and the OpenClaw
record shows what defaults do at scale. Constraints from day one:

- Self-authored skills run only after passing the verification gate; no
  direct-to-prompt prose skills.
- Skills declare effects; undeclared external writes are a registration-time
  error under checkpoint (already the unification-doc rule) and the same
  declaration bounds skill capabilities.
- Claw network surfaces bind to localhost by default; channel adapters are
  the only ingress.
- Skill provenance is recorded (authored-by, trace that motivated it, gate
  results) so the library is auditable and prunable, Curator-style.

## Open Questions

- **Manifest hash vs. self-modification.** v1 policy is fail-fast on graph
  version mismatch with no migration. A self-improving agent edits its graph
  frequently, so long-lived conversations will collide with this. Candidate
  escape hatch: skills as subroutines whose hash is excluded from the parent
  graph's manifest, so skill evolution does not invalidate parent resumes.
  Decide when skill self-authoring is designed in earnest; do not foreclose
  it in §2 implementation.
- **Skill packaging.** Single TS file vs. directory module; where tests live;
  whether the gate runs in-process (ts-morph + vitest API) or as a sandboxed
  subprocess.
- **Graph migration** for running conversations is out of scope for v1 but
  should get a design doc once the above two are settled.
