# Agent Runtime Unification — Changes From Current Implementation

Concrete change list from the current `codex/durable-agent-runtime` branch to the
target design in `agent-runtime-unification.md` (Decision Update: **checkpoint
durability**, ideal-first DX, no backward-compatibility constraint).

This file is the working checklist for Codex. Each item names the area, the
current state, the target, and the main files involved. Order is roughly
dependency order; do the durability collapse (Section 1) before the DSL polish
(Section 3) since it deletes the most code.

Legend: `[ ]` todo · `[~]` partially done · `[x]` done.

---

## 0. Headline decision (context for every change)

The branch has **two coexisting durability paradigms**:

- **legacy** (`DurableAgent` in `durable.ts`): full replay from the initial
  session + effect journal + middleware/hook replay-identity + `NondeterminismError`.
- **graph** (`executeAgentGraph` + graph `Durable*` state in `durable.ts`):
  **checkpoint + skip-prefix** — persist the whole session at suspend, resume
  from it, skip the deterministic prefix.

Target = **checkpoint only**. We delete the legacy replay system rather than
porting its journal. This reframes Codex's "durable.ts に残る journal logic の
本格移設" into "**delete** the replay journal; keep only the idempotency memo."

---

## 1. Durability: collapse to one checkpoint runtime

Maps to Codex remaining-work items: _durable legacy 実行の完全な GraphExecutor 化_,
_durable.ts journal logic_, _DurableAgent / GraphAgent 二重系の整理_.

Ordering (Decision Update 2, point 11): do **3.5 (decompose compatibility
template nodes) before or together with this section** — legacy agents
currently route through the generic `template` adapter node, so deleting legacy
execution first breaks that path. Tag the pre-deletion commit
(e.g. `pre-replay-removal`) so the replay implementation stays recoverable.

- [x] **1.0 Rename the run mode `durable` → `checkpoint`.** Flag, option types,
      and docs; "durable" overstates the guarantee (at-least-once + remote dedup,
      not exactly-once). Final option shape (Decision Update 3, point 12):
      `checkpoint?: true | RunStore | { store?: RunStore }`; the separate
      top-level `store` execute option is removed; `runId` stays top-level;
      binding override `.checkpoint(...)` takes the same union; `checkpoint: true`
      with no ambient store fails immediately with guidance. See §8.0.
      (`durable.ts`, `templates/agent.ts`, exports)
      Note: public surface only — internal `Durable*` machinery keeps its
      name until §1.1–1.3. `RunStore` is exported as an alias of
      `DurableRunStore`. App/binding checkpoint store overrides that differ
      from `PromptTrail.app({ store })` fail fast for now ("store overrides
      are not supported yet"); revisit with §1.3/§5.
- [x] **1.1 Delete the legacy replay path.** Remove the `DurableAgent` replay
      runtime, its model-call effect journal, the event-replay log, and
      `NondeterminismError` detection. Replace `journaled` per §8.1/§8.9: the memo
      becomes `ctx.once(name, dep, fn, { scope? })` — dep-keyed, no order check,
      scopes per §8.5. (`durable.ts`)
      Done (tag `pre-replay-removal` preserves the replay implementation):
      −5751/+335 lines; `DurableAgent`, `agent()` factory, `journaled`,
      journal state, `NondeterminismError`, `StoredRun.journal` all removed;
      `ctx.once` memo persists on `StoredRun.once.{run,conversation}`; direct
      `Agent.execute({ checkpoint })` now routes through graph checkpoint
      execution (progress toward §1.3). Left for later: observer replay
      vocabulary in `execution.ts` (`replayed`/`journaled` event policy) and
      `PromptTrailApp.replayEvents()` — still used by observer/delivery
      tests; fold into §1.2/§1.5.
- [x] **1.2 Remove replay-identity machinery.** Delete the middleware/hook
      compound replay-identity validation (phase + kind + id + declaration-order vs
      journal index). Keep stable ids only for (a) the structural version gate and
      (b) idempotency-memo keys. (`durable.ts`, `graph.ts`)
      Done: audit found no surviving journal-index validation after §1.1.
      Removed the dead `journaled` runtime event mode and the
      `live-and-journaled` observer policy (default is now `live-only`).
      Kept: `replayed` + `PromptTrailApp.replayEvents()` as a live explicit
      event re-emission API gated by `adopt-replayed`; whether
      `StoredRun.events` storage stays is a §1.5 decision.
- [x] **1.3 Collapse `DurableAgent` / `GraphAgent` into one graph runtime.**
      One agent type, one run store path, one resume path. (`durable.ts`,
      `templates/agent.ts`)
      Done: `GraphAgent` alias and `isGraphAgent` guard removed —
      `PromptTrailRegisteredAgent` is exactly `Agent`. Direct
      `Agent.execute({ checkpoint })` calls the shared
      `PromptTrailApp.executeCheckpointRun(...)`, which owns the store
      read and delegates to run/resume/send; the duplicate direct
      store-read branch in `Agent` is gone. Active substrate names
      (`DurableRunStore` etc.) stay until §1.4–1.6.
- [x] **1.4 Consolidate the checkpoint substrate** that survives: session
      checkpoint per node boundary, inbox cursor, suspended node path, idempotency
      memo for `external-write` only. Keep `collectGraphContinuationSkipNodes` /
      skip-prefix / `resumeFromNode` but factor it into a named, documented service
      (the current logic is subtle and under-named). (`durable.ts`, `graph_executor.ts`)
      Done: new `checkpoint_continuation.ts` service with the checkpoint-model
      doc comment and named contracts (`beginCheckpointGraphExecution`,
      `deriveCheckpointResumeCoordinate`,
      `computeCheckpointContinuationSkipNodes`,
      `recordCheckpointGraphCompletion`/`Suspension`,
      `createCheckpointOnceBoundary`). Behavior-preserving; no test changes.
      Noted for later: `external-read` activities also route through
      `ctx.once` today — revisit with §4.1's binary effect declaration.
- [x] **1.5 Drop persisted fields that only served replay** from `StoredRun`
      (journal sequence of model effects, event-history log). Keep session
      checkpoint, inbox+cursor, `graphSuspendedAt`, effect memo, outbox, context.
      (`durable.ts`)
      Done: `StoredRun.events`/`eventSeq` dropped, along with the §1.2
      holdovers they justified — `PromptTrailApp.events()`/`replayEvents()`,
      `ExecutionEvent.replay`, and the `replayPolicy`/`observerReceives`
      observer filter (no consumer outside the replay path; outbox delivery
      dedup keys on outbox index, not event seq). Event seq stays monotonic
      per run via an in-memory app counter so idempotency keys cannot collide
      across resumes within a process; durable cross-restart sequencing moves
      to §1.6.
- [x] **1.6 Make the run store async and persist deltas.**
      `DurableRunStore.set`/`persist` become `Promise<void>` and are awaited at
      effect boundaries; checkpoints persist session deltas (appended messages +
      vars/attrs diff + pointer), not full-session rewrites. Persist provider
      thread/session ids for `.codex`/`.claude` nodes so resume reconnects
      (Decision Update 2, points 7/9). See §8.7/§8.8. (`durable.ts`)
      Done in two halves. Async half: `DurableRunStore` writes return
      `Promise<void>`, every persist is awaited, and
      `createCheckpointOnceBoundary` awaits the memo persist before `once()`
      returns (closes the §8.8 sync-persist gap); ordering is locked by a
      controlled-delay-store test. Delta half: the store contract is
      write-granular (`create`/`patch`/`appendInbox`/`appendSessionDelta`/
      `recordOnce`/`upsertOutbox`; whole-run `set` removed), session content
      reaches the store only as `SessionCheckpointDelta` (appended messages +
      shallow vars diff, pointer = `Session.version`), and tests assert the
      full history is never rewritten after `create` and that delta versions
      chain contiguously. History REPLACEMENT (hook/middleware
      `replaceMessages`, subroutine squash) is handled by a
      `Session.historyRewrittenAtVersion` watermark: a persist whose baseline
      predates it emits a full-snapshot delta with `rewrite: true`. Graph
      patch/transform/squash/parallel-aggregate nodes now adopt
      handler-returned sessions through `adoptSessionResult` (diff +
      re-apply), so a handler that constructs a fresh `Session` can no longer
      reset or rewind the lineage identity the once-deps and deltas key on.
      Reads (`get`/`has`/`entries`) stay sync — deferred with async reads.
      Provider thread/session-id persistence moved to §1.8 where resume
      consumes it.
- [x] **1.7 Introduce a session identity.** `Session` has no version field
      (`transitionVersion` is legacy replay state) and loop counters are
      executor-local. Add a monotonic session identity/version used as the default
      `once` dep and the delta pointer. See §8.6. (`session.ts`, `durable.ts`)
      Done: `Session.version` — lineage-local monotonic identity, bumped by
      `addMessage`/`withVar`/`withVars` and non-empty execution transitions,
      preserved by type-only views, round-tripped through
      `toJSON`/`fromJSON`. Default tool once dep is now
      `idempotencyKey ?? session.version ?? parsedInput` (the old fallback
      deep-hashed the whole session — the §8.6 violation), and
      `stableSerialize` maps a `Session` inside explicit deps to its version.
      Event `sessionVersion` still means messages.length — left for §1.6b.
      Note for §4.1: two same-name tool calls in one assistant batch share a
      version, so the default dep dedupes them — same behavior as the old
      whole-session dep; the strict gate's idempotencyKey remains the answer
      for must-dedup writes.
- [x] **1.8 Provider-session resume for `.codex`/`.claude` nodes.** The
      provider owns the loop, so a crash mid-turn cannot be checkpointed. Primary:
      persist the provider thread/session id in the checkpoint and reconnect on
      resume (build on the existing Codex thread binding and Claude Agent session
      resume). Persist the provider id **immediately when the provider returns
      it** (not at turn completion) to minimize the unresumable window. Fallback
      when unresumable: **default `fail`** (provider-turn-unresumable error,
      fail-fast); `.codex({ onUnresumable: 'restart' })` opts into re-running the
      whole turn with a preamble message (`restartNotice` overrides the default
      text), capped by `maxRestarts` (default 1, counter persisted in run state).
      Best-effort, documented as such; vendor-internal tool side effects sit
      outside the idempotency memo and the docs must say so loudly.
      (`durable.ts`, `codex_app_server.ts`, `claude_agent.ts`)
      Done: `StoredRun.providerSessions` keyed by node path, written through
      the granular `DurableRunStore.recordProviderSession`; the runtime
      threads `providerSessions`/`recordProviderSession` from
      `resumeAgentRun` into both turn primitives. Codex persists the thread
      id right after `thread/start` (reconnect = existing `turn/start` with
      `threadId`); Claude persists from the event stream the moment a
      session id appears (reconnect = existing SDK `options.resume`).
      A failure while using a checkpoint binding maps to
      `ProviderTurnUnresumableError`; `onUnresumable: 'restart'` increments
      the persisted restart counter first, then re-runs on a fresh provider
      session with the notice prepended. Known gaps: real expired/refused
      provider response shapes are unverified against live APIs, and a crash
      before the first id write is indistinguishable from a fresh turn (no
      turn-started marker) — both acceptable per the best-effort posture.

## 2. Version gate: edits invalidate resume (broad hash)

**Decision reversed in review** (see main doc Decision Update 2, point 8): the
earlier "structural-only hash so a prompt tweak doesn't kill a run" stance is
dropped. An edited graph is in general **not resumable**; resuming across an
edit is author responsibility. A silent half-old/half-new run (edited suffix
runs new content against a prefix checkpointed under old content) is worse than
a fail-fast.

- [x] **2.1 Hash structure + serializable content.** Keep
      `createAgentGraphManifest` hashing node `data` where serializable (system
      text, source configuration) **plus** `path`, `id`, `type`, edges, tool names
  - effect declarations, handler ids. For non-serializable members (closures,
    handlers, provider clients) hash a stable id stand-in. Document that
    closure-body edits are undetectable by any hash. (`graph.ts`)
    Done: the gap was Template instances inside node `data` collapsing to
    `{ctor}` stand-ins — every embeddable template
    (CodexTurn/ClaudeTurn/System/User/Assistant/Structured/Loop/Conditional/
    Subroutine/Sequence/Parallel/Transform/GenerateMessages) now exposes
    `getManifestDescriptor()`. Provider clients stay constructor stand-ins
    (instance swap ≠ edit); secret-bearing config bags (Codex
    `transport`/`threadStart`/`turnStart`, Claude `sdkOptions`) reduce to
    edit-detecting fnv digests so their plaintext never enters the persisted
    manifest. Closure-body limitation documented on
    `createAgentGraphManifest` and pinned by a test.
- [x] **2.2 Keep fail-fast on mismatch**; migrations/force-continue stay out of
      scope (explicit migration = later, the Temporal `patched` analog).
      (`durable.ts`)
      Done: `assertGraphRunManifest` → `AgentGraphVersionError` was already in
      place; resume-after-option-edit now covered end-to-end by a test.

## 3. Agent DSL: one form, optional ids, layering

Maps to Codex item: _compatibility template node をさらに個別 graph node へ分解_.

- [x] **3.1 Make node ids optional.** Auto-derive from structural path
      (parent scope + node type + occurrence index). Authored ids still win. Update
      every node builder overload (final set per §9: `system/user/assistant/
transform/inbox/awaitInput/tools/loop/conditional/subroutine/parallel/
structured/codex/claude/goal`).
      (`templates/agent.ts`, `graph.ts`)
      Done: omitted id derives `<type>-<n>` (1-based per-type occurrence in
      the parent scope, deterministic, skips authored collisions); composes
      with the §3.4 expansion (`assistant-1-loop` etc.). Disambiguation rule:
      a single string to `.system/.user/.assistant/.goal` is CONTENT, never an
      id (ids need a second argument); `.inbox/.tools/.awaitInput` keep
      single-string-as-id. Documented: inserting/removing nodes shifts derived
      ids and intentionally invalidates resume — long-lived runs should use
      explicit ids. Agent NAME stays required (run identity + manifest).
- [x] **3.2 Delete `Agent.quick()`.** Id-optional `Agent.create('name')` replaces
      it. (`templates/agent.ts`, examples, exports)
      Done: ~161 call sites migrated; one graph engine for everything.
      Conditions accept both `(session) =>` and `({ session }) =>` shapes via
      a prototype-bridging context arg. e2e_real_api.test.ts still references
      quick at two sites (file is off-limits; fix when touched next).
- [x] **3.3 Registration-time durable gate (two gears, tied to run mode).**
      Ephemeral = loose: no declaration required (Temporal-style honor system).
      **Durable = strict automatically** (decided — no separate `strict` flag): each
      tool/hook/middleware that could write must declare one of _safe to re-run_
      (read/compute) or _here is my idempotency key_ (write); declaring neither is a
      hard error at `app.add(agent)` / durable marking. **No strict opt-out in v1** —
      durable is always strict. Also report nodes that need explicit ids
      (`awaitInput`, goal interaction, loops). Framework-provided components ship
      pre-classified, so the gate fires only on author code. Replace the
      resume-time-only failure mode. **Dynamic (MCP/provider-discovered) tools**
      cannot be seen at registration: the declaration attaches at _server/source
      registration_ (defaults + per-tool overrides), and a tool discovered at run
      time without a resolvable declaration under checkpoint mode fails the run at
      discovery — the gate is never silently bypassed (Decision Update 2, point 6).
      (`durable.ts`, `graph.ts`, `capabilities.ts`)
      Done: the gate lives in `createAgentGraphManifest` — every checkpoint
      path (app registration, direct checkpoint execute, resume validation)
      already flows through manifest creation, so that is the single choke
      point; ephemeral runs never reach it. Actionable errors name the
      agent/tool/handler and show both declaration forms. Auto-derived ids on
      resume-sensitive nodes (awaitInput, interactive goals) emit one
      aggregated console.warn per agent. MCP server capabilities gained
      `effects: { defaults, perTool }` and a discovery-time guard
      (`assertCheckpointDiscoveredToolEffectDeclaration`) — core has no
      in-process MCP discovery executor yet, so the guard is the mandatory
      seam for when one lands. The execution-time undeclared-tool assertion
      stays as defense in depth.
- [x] **3.4 Intent-layer auto tool-loop.** A top-level `assistant(...)` and every
      `goal(...)` auto-loops by compiling to `assistant` + `loop(tools, assistant)`.
      Pure sugar; no provider-internal loop. The manual layer is writing the
      `loop` yourself (the `turn` container is removed — §9.2). (`templates/agent.ts`)
      Done: compile-time expansion at `toGraph()` when registered tools exist
      and no manual `tools`/`loop` immediately follows; generated ids are
      deterministic (`<id>-loop`, `<id>-tools`) and the loop condition is the
      named `hasPendingToolCalls`, so checkpoint paths and the version gate
      stay stable. Goals gained the same inner tool loop per satisfaction
      attempt.
- [x] **3.5 Decompose remaining compatibility template nodes** into native graph
  nodes so nothing routes through the generic legacy `template` adapter node.
  (`graph_executor.ts`, `templates/agent.ts`)
  Done: the whole-tree `{ type: 'template' }` wrapper and the `'template'`
  node type are deleted; legacy trees compile per-kind to native nodes
  (loop/conditional/subroutine/user/messages/transform/structured/parallel/
  codexTurn/claudeTurn) with legacy lifecycle preserved via node metadata
  (`legacyTemplateLifecycle`, sibling-halt, warn-on-max-iterations).
  Completed with §3.4: `System` and `Assistant` leaves now compile to native
  `system`/`assistant` nodes — the executor carries the Source resolution,
  model middleware, validator retry, `raiseError`, and tool-result handling
  the templates had. The generic transform fallback survives only for
  unknown template types.
- [x] **3.6 Rename provider turn methods (decided).** `Agent.codexTurn(...)` →
      **`.codex(...)`** (Codex app-server), `Agent.claudeTurn(...)` →
      **`.claude(...)`** (Claude Agent SDK). Drops the "turn" collision and pairs
      with the raw-model side (`Source.llm().openai()`/`.anthropic()` = model, graph
      owns loop; `.codex()`/`.claude()` = vendor agent runtime, vendor owns loop).
      Update method names, option types stay `CodexTurnOptions`/`ClaudeTurnOptions`;
      internal `GraphNode.type` tags may stay `'codexTurn'`/`'claudeTurn'` or be
      renamed to match — author-facing surface is `.codex`/`.claude`.
      (`templates/agent.ts`, examples, exports)

## 4. Tools: idempotency key is load-bearing; classification optional

Rationale (Temporal/Restate/Inngest comparison): all three require an effect
_boundary_ but **none** require a read/write tag; idempotency is the developer's
responsibility. In PromptTrail the tool already _is_ the boundary, so the only
irreducible requirement is the **key**, and only for writes the author wants
crash-safe. `kind` is optional sugar. Strict mode (3.3) adds the binary gate
that replay systems get for free.

- [x] **4.1 Drop the `kind` taxonomy; the declaration is binary.** (Supersedes
      the earlier "key required iff external-write" shape — see §8.2 and Decision
      Update 2, point 4.) The type becomes
      `{ idempotencyKey: string | (input) => string } | { repeatable: true }`;
      keys may depend on input. `kind` survives only as optional retry/
      observability metadata. Enforcement of "declare one of the two" lives in the
      strict gate (3.3), not in the base type. (`tool.ts`)
      Done: `ExecutionEffectDeclaration` replaces
      `ExecutionDurableActivityOptions`/`ActivityKind` (arms made exclusive
      via `never`); all declarations migrated.
- [x] **4.2 Keep auto-wrap as the common path** (confirmed). The engine wraps a
      declared tool body in `ctx.once(tool.name, session-identity, body)` when a
      checkpoint boundary is present — a single-effect tool needs **no** `ctx.once`
      calls; explicit `ctx.once` remains for multiple nested boundaries or
      conversation scope. The resolved `effect.idempotencyKey` (string or
      `(input) => string`) is handed to the body as `ctx.idempotencyKey` for
      forwarding to the remote system. (`tool.ts`, `graph_executor.ts`)
      Done: keyed tools wrap in `once(toolName, resolvedKey, body)` with the
      resolved string as the memo dep AND as `ctx.idempotencyKey` (closes the
      §8.8 "key validated but never used" bug); repeatable tools deliberately
      bypass the memo and re-run on resume (the §1.4 open note — resolved);
      undeclared tools unchanged until the §3.3 gate. The §1.7
      session-version fallback dep for tools is structurally gone — there is
      no declared-but-keyless state anymore. Function keys appear in the
      manifest as named function stand-ins.
- [x] **4.3 Synchronous decision/transform handlers.** Type
      `conditional`/`loop` conditions, `goal.isSatisfied`, and `patch` handlers as
      synchronous (`=> boolean` / `=> Session`, drop the `| Promise<...>` variants)
      so IO can't be `await`ed into a decision and effects stay in tools. Add a cheap
      runtime guard that throws if a synchronous handler returns a thenable. No
      global IO sandbox. Open: whether `transform` handlers join this rule — they
      currently `await handler(session)` in `graph_executor.ts` and were omitted
      from the original list. (`templates/agent.ts`, `graph_executor.ts`, `tool.ts`)
      Done with §9.1 (the open question was resolved by Decision Update 3
      point 1: undeclared transform IS sync). Conditions were already
      sync-typed; `goal.isSatisfied` dropped its Promise variant; thenable
      guards added for transforms, graph conditions, and goal satisfaction.
- [x] **4.4 Unify effect classification across tool/hook/middleware** with the
      phase-split rule (Decision Update 3, point 10): transform phases
      (`beforeModel`/`prepareModelInput`/`afterModel`/`beforeTool`/`afterTool` +
      hook lifecycle phases) become synchronous by type (thenable guard, no
      declaration needed); wrapper phases (`wrapModelCall`/`wrapToolCall`) stay
      async and a handler defining one must carry the binary effect declaration
      (and gets `ctx.once`). External writes are keyed the same way as tools;
      observers stay exempt (idempotent by contract). (`interceptors.ts`,
      `tool.ts`)

## 5. App / sources: generic events, name disambiguation

- [x] **5.1 Generic `Trigger<TEvent>` for event sources** (renamed from the
      earlier `Source<TEvent>` plan — §9.8) and infer `TEvent` in the binding
      builder. Remove the closed
      `RuntimeBindingEvent = DiscordMessageEvent | CronEvent` union. (`runtime_bindings.ts`)
- [x] **5.2 Move platform sources to packages.** `discord` / `cron` become the
      first event-source packages, not core unions; `slack`/`github` add without
      editing core. (`runtime_bindings.ts`, `runtime_discord.ts`)
      Done: `@prompttrail/discord` (trigger/gateway, delivery driver, progress
      observer, typing presence, `./testing` mocks; owns `discord.js`) and
      `@prompttrail/cron` (`cron.schedule`, `./testing`). Core gained generic
      Trigger hooks (`defaultInput`/`eventAttrs`/`resolveDelivery`/
      `resolveContext`/`shouldDispatch`), an open `DeliveryTarget`
      (`platform: string`), and lost `runtime_discord`/`runtime_mocks` and the
      `discord.js` dependency; core binding coverage now runs on a generic
      fake trigger. Note: `claw` build was already broken by pre-§5.2 branch
      drift (imports the §1.1-deleted `agent` factory) — fix with §7.
- [x] **5.3 Resolve the "source" name collision.** Node content stays
      `Source.llm()`; app event wiring is **`app.on(eventSource, builder)`**
      (decided — rename the existing `.bind(...)` to `.on(...)`). The binding's
      delivery setter is `.reply(...)`. (`durable.ts`, `runtime_bindings.ts`,
      exports)
- [x] **5.4 App `defaults` are constructor-only (decided).** Accept `defaults`
      (durable, delivery, ...) only in `PromptTrail.app({ defaults })`; no mutable
      `.defaults(...)` setter. Resolution order: binding override > app defaults >
      built-in. Per-binding needs are met by binding-level overrides (`.durable(...)`,
      `.reply(...)`), not by mutating app state. (`durable.ts`)
- [x] **5.5 Defer binding-level middleware/hooks (decided).** v1 ships agent +
      app handler layers only; the ordering model keeps the binding slot reserved for
      a later release. Do not implement binding-level handler injection now.
      (`durable.ts`, `runtime_bindings.ts`)

## 6. Export hygiene

- [x] **6.1 Curate the package root.** `index.ts` currently `export *`s
      `runtime_bindings`, `runtime_discord`, `runtime`, `interceptors`, etc.,
      contradicting the doc's "no wildcard export of low-level modules." Move
      host/dispatch/mock and low-level template primitives behind submodules; keep
      `Agent`, graph helper types, `Parallel`, `Structured`, provider turn option
      types, and app authoring types at root. (`index.ts`, `package.json` exports)
      Done: root is an explicit list (zero `export *`); host/provider plumbing
      lives behind the existing subpaths (`runtime_server`, `runtime_dispatch`,
      `codex_app_server`, `claude_agent`, `graph_executor`, `templates`) — no
      new subpaths were needed. Provider conversion modules, execution
      internals (ObserverBus, transition helpers), interceptor runners, and
      tool execution helpers are no longer exported anywhere from root.
      public_api.test.ts now asserts the exact runtime key set, so a wildcard
      re-addition fails the suite.

## 7. Docs & examples

Maps to Codex item: _README/examples の全面更新_.

- [x] **7.1 Rewrite README** around the final API (checkpoint durability,
      id-optional authoring, `goal`-first, `app.on(...)`).
- [x] **7.2 Update examples** to id-optional `Agent.create`, `goal`/`turn`
      layering, and the new app/event API. (`examples/*.ts`)
- [x] **7.3 Migration notes** only where genuinely useful (no compatibility
      guarantee).
- [x] **7.4 Document the binding / routing DSL model** as its own section
      (README + a design doc). A binding is a **pure transform from a platform event
      to a normalized routing decision**; the fluent chain fills slots of a record,
      it is not an ordered pipeline. Cover:
  - Routing-as-data: `b.to().conversation().input().reply().where().context()`
    compiles to a `RuntimeBinding` struct (order-independent) and into the
    `RuntimeBundle` IR (inspectable / testable / serializable).
  - Resolvers, not literals: each slot holds an `(event) => value` function,
    evaluated per event; platform factories like `discord.perThread()` /
    `discord.toThread()` produce platform-agnostic resolver shapes so platform
    knowledge stays in the package, not in core.
  - Inbound/outbound symmetry: `.conversation(...)` = inbound identity (→ runId →
    which checkpoint to resume) vs `.reply(...)` = outbound identity (→
    `DeliveryTarget`), both projections of the same event. `.reply(...)` returns
    a delivery _description_ (data); actual sending is the App delivery driver +
    outbox, so bindings stay side-effect free.
  - Mental model = an HTTP router whose slots are event projections rather than
    fixed strings.

---

## Sequencing suggestion for Codex

(Reordered per Decision Update 2, point 11: decompose the compatibility
template nodes before deleting the legacy runtime they route through.)

1. Section 2 (version gate) — small, unblocks safe iteration on durable runs.
2. Item 3.5 (decompose compatibility template nodes into native graph nodes) —
   prerequisite for the legacy deletion.
3. Section 1 (durability collapse) — largest deletion; tag the pre-deletion
   commit first. Includes the §8 memo rewrite (`ctx.once`), the
   async/delta store (1.6), session identity (1.7), and provider resume (1.8).
4. Section 4 (tools typing: binary declaration, sync handlers) — needed by the
   lint in 3.3.
5. Rest of Section 3 (DSL: ids, quick removal, strict gate incl. MCP sources,
   auto-loop, `.codex`/`.claude` rename).
6. Section 5 (app/sources generics + naming).
7. Section 6 (exports), then Section 7 (docs/examples).

Each section should land with green tests; durable tests will shrink as replay
machinery is deleted in Section 1.

---

## 8. Memoization & checkpoint model (review refinements)

Outcome of a design review of the checkpoint/idempotency mechanics. These
refine — and in places correct — Sections 1, 2, and 4. Treat this section as
authoritative for the `durable.ts` memo rewrite.

### 8.0 Framing: `durable` overstates the guarantee

What the runtime actually does is "checkpoint the session and resume forward",
not exactly-once. **Decided:** rename the run flag `durable: true` →
`checkpoint: true` (or `checkpoint: store`) so the name matches the guarantee
(work item 1.0). The strict gate then reads as "this effect re-runs on resume —
acknowledge it", not "this is protected".

### 8.1 The memo primitive: `ctx.once(name, dep, fn)`

Replace the replay journal (`journaled` + `sequence`/`position` +
`NondeterminismError`) with a `useMemo`-style, dependency-keyed effect boundary:

```ts
ctx.once(name, dep, fn); // run-scoped (default)
ctx.once(name, key, fn, { scope: 'conversation' }); // once per conversation
// no forever scope: permanent uniqueness belongs in the author's DB / remote
```

- `name` = stable operation namespace (author string). `dep` = the dedup
  identity / invalidation key. Effective key = `(name, hash(dep))`.
- `dep = session` (the default, and what auto-wrap uses): re-run iff the session
  changed. The replay requirement becomes simply **"same session ⇒ same result"**.
- `dep = [session, x]`: also invalidate when `x` changes (the "re-fetch the
  latest, re-run if it differs" case).
- `{ scope: 'conversation' }`: once per key across the runs of one
  conversation ("welcome once per conversation"; periodic jobs embed the
  period in the key, e.g. `report:${date}`). Decision Update 3, point 11.

Why dep-keyed beats the old positional journal: it is content-addressed, so it
survives reordering and carries no determinism contract on author glue.

### 8.2 Drop the 3-way `kind`; the binary is key-vs-repeatable

`external-read` vs `compute` is a distinction without a difference for
durability (both = "no memo, re-run is safe"). The real axis is **repeatable vs
must-dedup**, and an idempotent write is repeatable while a counter/charge is
must-dedup — so `read`/`write` mis-frames it. Collapse the activity type:

```ts
type Effect =
  | { idempotencyKey: string | ((input) => string); retry?: RetryPolicy } // dedup via once()
  | { repeatable: true; retry?: RetryPolicy }; // re-run, no memo
// under checkpoint(strict): declaring neither is a registration-time error
```

The strict gate's value is only the forcing function (catch the forgotten-key
write); `{ repeatable: true }` is the explicit "I decided no key is needed"
assertion. `kind` survives, if at all, as optional retry/observability metadata.

### 8.3 Layering: session/stack is primary, `once()` is the residual patch

Resume is carried mostly **for free** by two mechanisms; the memo only closes
what they cannot:

1. **Session state** — the session log already records model/tool results, so
   on resume the standard model→tool loop does not re-issue completed calls.
   Automatic when the effect's record is (a) written to the session and (b)
   consulted by control flow (true for the standard loop; vars-driven custom
   loops must update the session themselves).
2. **Suspended node path / skip-prefix (stack)** — robust because it is the
   _persisted_ position, not a re-derived one.

The single thing these cannot cover is the **non-atomic gap between committing
the external effect and persisting the session checkpoint** (plus retry of a
partial success). That gap exists because the remote system and the session are
two stores (dual-write); no local mechanism closes it. Therefore:

- The guarantee is **at-least-once**, not exactly-once.
- **effective-once requires the remote to dedup on the idempotency key.** The
  framework's job is to carry the author's key to the remote; the local `once()`
  memo is best-effort over the gap. Do **not** document `once()` as exactly-once.
- Current ordering (effect → record memo → persist) is **at-least-once** (never
  drops a write); the opposite order would be at-most-once. at-least-once +
  remote dedup is the right default for external writes — state this explicitly.

### 8.4 Loops

`once(name, session, fn)` handles loops with no extra ceremony **iff the loop's
progress is in `dep`**: a progressing loop advances the session (and/or the loop
cursor), so the key differs per iteration ⇒ each iteration re-runs; a crash
mid-iteration resumes with the same session ⇒ that iteration dedups. Caveats:

- If the loop body writes nothing to the session, the loop cursor must be in
  `dep` explicitly (`[session, cursor]` or a data-derived key like the entity
  id). Prefer **data-derived** keys over positional indices (stable across
  resume). Verified: loop iteration counters today are executor-local variables
  (`let iterations` in `graph_executor.ts`), not session or store state — there
  is no persisted loop cursor to lean on without adding one.
- Two genuinely-identical effects at the same `dep` cannot be told apart from a
  re-run by any content key — the author must vary `dep` (the only irreducibly
  manual case).

### 8.5 Storage scope must be explicit (not inferred from dep)

Scopes are `run` (default) and `conversation` — there is **no forever scope**
(Decision Update 3, point 11; permanent business uniqueness = the author's DB
or the remote system's constraint, per 8.3).

- `once(name, dep, …)` → run journal, GC'd with the run.
- `once(name, key, …, { scope: 'conversation' })` → conversation state, lives
  across that conversation's runs, cleaned up with the conversation.

No TTL option and no standalone GC API: memo entries are co-located with the
scope owner's store record, so cleanup rides the store's retention policy.
Do not infer scope from "is session in the dep"; it is the explicit option.

### 8.6 Session keying is by version/identity, not deep content hash

Key on a stable session version, not a deep hash of the message history — O(1),
and "same session" is an identity check. **Correction (verified): `Session` has
no version field today** — `transitionVersion` lives on the legacy replay state
(`DurableExecutionState` in `durable.ts`) that this rewrite deletes. A monotonic
session identity must be _added_ (work item 1.7), serving as both the default
`once` dep and the delta pointer. This keying is only correct if **within-node
re-execution is deterministic**,
which holds when nodes are decomposed finely enough that a nondeterministic call
(model) and a dependent write never share a node. So §3.5 (decompose
compatibility nodes) and §1 (checkpoint granularity) are coupled: finer nodes ⇒
within-node replay is deterministic ⇒ content-addressed dedup is reliable.

### 8.7 Checkpoint granularity → persist a session _delta_

`store.set(runId, run)` currently rewrites the whole run per persist. Persisting
the full session at every node boundary is O(session) per node ≈ O(n²) over a
long run. Since Session is immutable append-only, persist a **delta** (new
messages + vars/attrs diff + pointer) → O(n) total while keeping per-node resume
granularity. The delta must include vars/attrs (a `transform`/`patch` may change
only vars/attrs, not messages), not just appended messages.

### 8.8 Concrete current-code bugs this rewrite must fix

- **`idempotencyKey` is validated but never used as the memo key.** Tool/handler
  activities memoize by graph-coordinate `stepId` (`durableToolEffectStepId`);
  `idempotencyKey` is only asserted-present for `external-write`. Under
  checkpoint this is unsound — the declared key must become the actual dedup
  identity (or be carried to the remote). See 8.1/8.3.
- **`DurableRunStore.set` / `persist` are synchronous `void`.** A real async
  store cannot persist the memo before the next effect runs, widening the 8.3
  gap permanently. Make the store API `Promise<void>` and `await` it in `once()`.
- **`runDurableActivityWithRetry` re-runs `fn` on any throw** → a partial success
  (committed-but-errored) double-writes with no crash. Reinforces 8.3: retry ⇒
  remote idempotency is mandatory, which is what the strict gate forces.

### 8.9 Net effect on Sections 1/2/4

- §1: "delete the journal, keep the idempotency memo" becomes "replace
  `journaled` (coordinate key + sequence/position + NondeterminismError + sync
  persist) with `ctx.once` (dep key, run/conversation scope option, no order
  check, async-awaited persist)". This is the hardest part of §1.
- §2: structural-only hash interacts with skip-prefix to produce a silent
  half-old/half-new run on a content edit; closures/handlers cannot be hashed
  anyway. Accepted as author-responsibility (edit ⇒ no resume), but document it.
- §4: the activity type collapses to the 8.2 binary; `ctx.once` replaces
  `ctx.durable.memo/activity` as the public effect boundary.

---

## 9. Final authoring vocabulary (review decisions)

Outcome of the vocabulary review (main doc Decision Update 3). These reshape
the §3 DSL work; do them as part of §3.

- [x] **9.1 Unify `transform`** (absorbs `patch` and `messages` nodes — both
      removed). Pure form is synchronous (`(session) => Session`, thenable guard);
      `{ effect }` declaration (8.2 binary) unlocks the async form
      `async (session, ctx) => Session` with `ctx.once` available. This is the
      graph-invoked effect step (tools remain model-invoked). "patch" survives
      only as the noun for hook/middleware session patches.
      (`templates/agent.ts`, `graph_executor.ts`, `graph.ts`)
      Done: effect transforms route through the same checkpoint boundary as
      tools (the `durableToolExecution` channel, now a discriminated
      tool/transform context); keyed transforms resolve their key from the
      session, auto-wrap in `once(nodeId, key, handler)`, and hand the key to
      the handler as `ctx.idempotencyKey`. Note the cost contract: a keyed
      transform memoizes its resulting Session in the once store — keep keyed
      transforms small or put big payloads in tools. All 21 patch/messages
      call sites migrated to pure transforms.
- [x] **9.2 Remove the `turn` node** (verified: runtime-wise a bare sequence).
      `inbox`/`awaitInput`/`tools` become ordinary nodes available in any builder
      scope. (`templates/agent.ts`, `graph_executor.ts`)
      Done: `'turn'` node type and builder deleted; former turn children
      flatten into the parent scope (paths lose the turn segment).
      Conditional branches flatten too — branch membership moves to
      `data.branches` id lists, which makes authored ids unique per
      conditional ACROSS both branches (duplicate ids now fail graph
      validation loudly; §3.1 auto-ids will make this a non-issue). Legacy
      `Sequence` lifecycle wrapping survives via an internal
      `legacySequence` transform marker — dissolves with §9.4.
- [x] **9.3 Remove `repeat`; `loop` everywhere** (verified implementation-
      identical pre-condition loops). (`templates/agent.ts`)
      Done: confirmed both compiled to the same `loop` node and runtime path;
      `loop(id, builder, condition, options)` signature kept.
- [x] **9.4 Remove the authoring `sequence` node; rename the IR container to
      `scope`.** Top level and all builders are implicit sequences. `subroutine`
      compiles to `scope` + session policy. (`graph.ts`, `graph_executor.ts`)
      Done: `Agent.sequence(...)` deleted (bodies inline); `'subroutine'` node
      type replaced by `'scope'` — with session-policy data it behaves as the
      old subroutine (defaults unchanged until §9.5), without it it just runs
      its children. The `legacySequence` transform marker dissolved into plain
      `scope`. Paths keep their ids; only node types changed in manifests.
- [x] **9.5 Fix `subroutine` defaults to actually isolate** (current defaults
      `retainMessages: true` + `isolatedContext: false` make it a sequence).
      Options become entry projection (`init`) / exit projection (`squash`) +
      shortcuts; proposed defaults: enter fresh, append sub-messages on exit.
      (`templates/agent.ts`, `graph_executor.ts`)
      Done: options are exactly `init?`/`squash?` — the old
      retainMessages/isolatedContext/initWith/squashWith shortcuts removed
      rather than aliased. Defaults: enter a fresh empty session (system
      prompts must be re-established inside or via `init`), exit by appending
      sub-added messages to the parent with parent vars kept.
- [x] **9.6 Document run-per-event as the standard shape.** Event-driven
      agents end after one inbound event; continuity = app-layer conversation
      resume. No infinite graph loops; `awaitInput` is mid-flow only. (README,
      examples)
- [x] **9.7 Remove `Agent.run` references** (doc phantom; `execute({ input })`
      only).
- [x] **9.8 Consistency renames:** `ctx.durable.*` →
      `ctx.once` (scope option per §8.5); `app.source()` → `app.gateway()`; event-source
      type = `Trigger<TEvent>` (not `Source<TEvent>`/`EventSource`);
      `.durable(...)` overrides → `.checkpoint(...)`; `app.activity()` →
      `app.presence()`. (`durable.ts`, `runtime_bindings.ts`, `runtime_discord.ts`,
      exports)

---

## 10. Post-sweep follow-ups (noted while writing the final docs)

All checklist items above are done. Small API frictions surfaced by the §7
documentation pass, left for a future polish round:

- ~~`activity:` vs `effect:`~~ — done: tools declare `effect:` everywhere
  (PromptTrailTool, Tool.create, manifests, gate wording).
- ~~Id-less handler overloads~~ — done: `.assistant((session) => ...)` and
  `.system(source)` typecheck; single non-string argument is content/source.
- Loop conditions type more cleanly as `({ session }) => ...` than the
  prototype-bridged `(session) => ...` compatibility shape — consider
  retiring the bridge once examples/docs only show the destructured form.
- ~~`Agent.execute` return shape~~ — done (plan B): a per-call `checkpoint`
  option returns the full `DurableRunResult` envelope; without it execute
  returns `Session`. Typing follows the option (overloads + union fallback).
  Note: an agent configured via the fluent `.checkpoint(...)` default but
  executed without a per-call option still returns `Session` — types cannot
  see fluent state, so runtime matches the signature.
- ~~`RuntimeDispatchContext.channelPrompt`~~ — done: typed field deleted
  (zero core consumers; the open `Record` carries platform keys untyped).
- ~~`e2e_real_api.test.ts` quick references~~ — fixed; the real-API suite
  passes 13/13 against live OpenAI/Anthropic.
- **DECIDED (user, 2026-06-11): native adapters are vendor-loop surfaces;
  checkpoint requires explicit non-durability consent.** The native
  OpenAI/Anthropic/Gemini adapters run a provider-internal tool loop
  (function calls execute inside `generateText` with no durable boundary;
  only the final assistant message reaches the session). We do NOT try to
  surface toolCalls/tool_result from them — like `.codex`/`.claude`, the
  vendor owns the loop. Instead, the §3.3 gate is extended: a checkpoint
  agent containing a node whose source uses a native adapter WITH tools
  fails registration unless the source declares `toolLoop: 'vendor'` — an
  explicit acknowledgment that those tool executions sit outside the once
  memo and the whole turn re-runs on resume (self-heal / best-effort).
  Keyed tools still forward `ctx.idempotencyKey` for REMOTE dedup, which is
  the only effective-once mechanism anyway (Decision Update 2, point 2);
  what the vendor loop loses is only the local memo. The acknowledgment is
  source config, so it lands in the manifest via §2 automatically. The
  ai-sdk adapter keeps surfacing tool calls/results on the session
  (graph-visible path).
- `Source.llm().addTool/withTool/withTools` now adapt raw ai-sdk tools on
  entry (previously a raw ai-sdk tool was silently dropped from the request
  by every downstream path); `toAiSdkToolSet` throws instead of skipping.
