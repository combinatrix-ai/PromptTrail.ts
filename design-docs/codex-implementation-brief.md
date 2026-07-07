# Codex Implementation Brief — Agent Runtime Unification

You are implementing the agent-runtime unification on branch
`codex/durable-agent-runtime` in the PromptTrail.ts monorepo. This file is your
directive. Backward compatibility is **not** a goal — replace, rename, and delete
freely where the design requires it.

## Authoritative sources (read first, in order)

1. `design-docs/agent-runtime-unification.md` — the design. The **Decision
   Update (2026-06)** and **Decision Update 2 (2026-06-10)** blocks at the top
   are authoritative and supersede any conflicting older text below them;
   where they disagree, **Decision Update 2 wins**. The **Rationale and
   Discussion** section explains _why_ each decision was made; read it so you
   don't re-litigate.
2. `design-docs/agent-runtime-unification-changes.md` — the concrete change
   checklist (numbered tasks with target files). This is your work queue.
3. `CLAUDE.md` (repo root) — project commands, code style, conventions.

If anything in older parts of the design doc contradicts the Decision Update or
this brief, the Decision Update / this brief win.

## Locked decisions (do not redesign these)

- **Durability = checkpoint, not replay.** Persist a session checkpoint at each
  node boundary; resume forward; skip completed nodes. **Delete** the legacy
  replay runtime, its model-effect journal, event replay, `NondeterminismError`
  detection, and the middleware/hook compound replay-identity machinery. Do not
  port them.
- **The run mode is named `checkpoint`, not `durable`.** The guarantee is
  at-least-once + remote dedup, never exactly-once; the name must say so.
  Option shape: `checkpoint?: true | RunStore | { store?: RunStore }` (no
  separate top-level `store` option; `runId` stays top-level; binding override
  `.checkpoint(...)` takes the same union). The resolved
  `effect.idempotencyKey` is handed to tool bodies as `ctx.idempotencyKey`;
  auto-wrap = `ctx.once(tool.name, session-identity, body)`.
- **The session log is the journal.** Model outputs and tool results are already
  persisted as session messages. The only _extra_ memoized thing is the
  dep-keyed effect memo below. Checkpoints persist session **deltas** (appended
  messages + vars/attrs diff + pointer); the run-store API is async
  (`Promise<void>`, awaited at effect boundaries); a monotonic session identity
  is added (Session has none today).
- **Memo primitive: `ctx.once(name, dep, fn, { scope?: 'run' | 'conversation' })`**
  replaces `journaled` (coordinate keys + sequence/position checks) and
  `ctx.durable.memo/activity`. Dep-keyed, content-addressed, no order
  validation. Default scope = run (GC'd with the run); `'conversation'` = once
  per key across that conversation's runs (cleaned up with the conversation).
  **No forever scope, no TTL, no standalone GC API** — permanent uniqueness
  belongs in the author's DB / the remote system; memo entries co-locate with
  their scope owner's store record.
- **Effect declaration is binary; the `kind` taxonomy is dropped.**
  `{ idempotencyKey: string | (input) => string }` or `{ repeatable: true }`.
  Ephemeral = loose (no declaration). **Checkpoint = strict automatically** (no
  separate flag, no opt-out in v1): declaring neither is a registration-time
  hard error for author tools/hooks/middleware; observers exempt;
  framework-provided components ship pre-classified. Dynamic (MCP) tools
  declare at _server/source registration_; an undeclared tool discovered at run
  time under checkpoint fails the run at discovery. Handler phases: transform
  phases (beforeModel/prepareModelInput/afterModel/beforeTool/afterTool + hook
  lifecycle) are **synchronous by type** — no declaration needed, IO is typed
  out; wrapper phases (wrapModelCall/wrapToolCall) stay async and a handler
  defining one must carry the binary declaration (and gets `ctx.once`).
- **Edit tolerance is a non-goal — and edits invalidate resume.** The
  version-gate hash covers structure **plus serializable node content**, with
  stable-id stand-ins for closures/handlers (supersedes the earlier
  structural-only stance). Closure edits are undetectable; documented
  limitation. No migration in v1.
- **`.codex`/`.claude` under checkpoint: provider-session resume is primary**
  (persist the thread/session id **immediately on receipt**, reconnect on
  resume). If unresumable, **default = fail** (provider-turn-unresumable
  error); `onUnresumable: 'restart'` opts into a full turn re-run with a
  preamble (`restartNotice` overridable, `maxRestarts` default 1 with a
  persisted counter). Best-effort and documented.
- **Synchronous decision handlers.** `conditional`/`loop` conditions,
  `goal.isSatisfied`, and `patch` are synchronous by type so IO can't be
  `await`ed into a decision. Add a runtime guard that throws if a sync handler
  returns a thenable. No global IO sandbox.
- **One authoring form.** `Agent.create('name')`; node ids optional/auto-derived
  from the structural path; explicit ids required only at suspend/resume
  coordinates (`awaitInput`, goal interaction) and loops. Delete `Agent.quick()`.
- **Naming (final):** app event wiring is `app.on(trigger, builder)` (not
  `.bind`); binding delivery setter is `.reply(...)`. Goal node stays `goal`.
  Provider turn methods are `.codex(...)` (Codex app-server) and `.claude(...)`
  (Claude Agent SDK), renamed from `codexTurn`/`claudeTurn`.
- **Final authoring vocabulary (Decision Update 3):** `transform` absorbs
  `patch`/`messages` (pure = sync; `{ effect }` unlocks async + `ctx.once`);
  the `turn` node is removed (`inbox`/`awaitInput`/`tools` are ordinary
  nodes); `repeat` is removed (`loop` only); the authoring `sequence` node is
  removed (implicit everywhere; IR container = `scope`); `subroutine` defaults
  fixed to actually isolate; direct execution uses `execute({ input })`.
  Run-per-event is the standard long-running shape (no infinite graph loops;
  `awaitInput` is mid-flow only). Renames: `ctx.once`,
  `app.gateway()`, `Trigger<TEvent>`, `.checkpoint(...)` overrides,
  `app.presence()`.
- **Generic event sources.** `Trigger<TEvent>` (renamed from the earlier
  `Source<TEvent>` plan); remove the closed
  `RuntimeBindingEvent = DiscordMessageEvent | CronEvent` union; platforms are
  packages.
- **App `defaults` are constructor-only.** No mutable `.defaults(...)` setter.
  Resolution: binding override > app defaults > built-in.
- **Deferred (do NOT build in v1):** binding-level middleware/hooks; strict
  opt-out; version migration. The handler ordering model reserves the binding
  slot for later.

## Working agreement

- **Match existing conventions** (`CLAUDE.md`): TypeScript strict, single quotes,
  semicolons, trailing commas, 80-col, factory `.create()` pattern, immutable
  Session/Vars/Attrs.
- **TDD where practical:** for a bug fix or behavior change, write/adjust a
  failing test first, then make it pass.
- **Keep the gate green after every task.** Before considering a task done, run:
  - `pnpm -C packages/core typecheck`
  - `pnpm -C packages/core test`
  - `pnpm lint:check` and `pnpm format:check`
  - (`pnpm check` runs the combined set.)
- **Builds must stay intact:** `pnpm -r build`. Any symbol hidden from the root
  must remain importable from its named submodule (see the export-surface rules
  in the design doc); update `packages/core/package.json` `exports` accordingly.
- **Small, reviewable commits**, one change-list section per commit (or finer).
  Reference the change-list item id in the commit message
  (e.g. `runtime: checkpoint collapse (changes 1.1–1.5)`).
- **Durable test suite will shrink** as replay machinery is deleted — that is
  expected; update/remove replay-specific tests rather than preserving them.
- If a decision is genuinely ambiguous or you find a design contradiction, stop
  and write the question into `design-docs/agent-runtime-unification-changes.md`
  under a `## Questions for review` heading rather than guessing.

## Execution order (from the change list)

Do the sections in this order; each must land green before the next.

1. **§2 Version gate: broad hash (structure + serializable content).** Small,
   unblocks safe durable iteration. (`graph.ts`)
2. **§3.5 Decompose compatibility template nodes into native graph nodes.**
   Prerequisite: legacy agents still route through the generic `template`
   adapter node, so this must land before the legacy deletion.
   (`graph_executor.ts`, `templates/agent.ts`)
3. **§1 Durability collapse to one checkpoint runtime.** Largest deletion; tag
   the pre-deletion commit first. Delete legacy replay; rewrite the memo to
   `ctx.once` per changes §8; async/delta store, session identity,
   provider-session resume. (`durable.ts`, `graph_executor.ts`, `session.ts`)
4. **§4 Tools: binary effect declaration; sync decision handlers.** Needed by
   the strict gate. Includes §4.3 sync handlers + thenable guard. (`tool.ts`,
   `templates/agent.ts`, `graph_executor.ts`)
5. **§3 (rest) Agent DSL:** optional ids, delete `quick()`, strict gate incl.
   MCP source declarations (§3.3), intent-layer auto tool-loop,
   `.codex`/`.claude` rename. (`templates/agent.ts`, `graph.ts`, `graph_executor.ts`)
6. **§5 App / sources:** generic `Trigger<TEvent>`, `.on(...)` rename,
   `app.gateway()`/`app.presence()` renames, constructor-only `defaults`,
   platform-source packaging. Do **not** build binding-level handlers.
   (`runtime_bindings.ts`, `durable.ts`)
7. **§6 Export hygiene:** curate the package root; submodule the low-level
   surface. (`index.ts`, `package.json`)
8. **§7 Docs & examples:** rewrite README around the final API; update examples
   to id-optional authoring, `goal`/`turn` layering, `app.on`, `.codex`/`.claude`;
   document the binding/routing DSL model (§7.4).

## Definition of done

- All change-list items in §§1–7 are checked off, with the green gate
  (typecheck + test + lint + format + build) passing on the branch.
- No remaining references to the legacy replay runtime, `NondeterminismError`,
  model-effect journaling, `journaled`/sequence-position validation,
  `ctx.durable.*` as public API (replaced by `ctx.once`), the
  `external-read`/`external-write`/`compute` kind taxonomy as a required
  declaration, `Agent.quick()`, `codexTurn`/`claudeTurn`
  authoring methods, the `turn`/`repeat`/`sequence`/`patch`/`messages`
  authoring nodes, `app.source()`/`app.activity()` (renamed
  `gateway`/`presence`), the closed binding-event union, or `.bind(...)` app
  wiring.
- Root exports match the curated surface in the design doc; every hidden symbol
  is still reachable via its named submodule and the package builds.
- README and examples compile and reflect the final API.
