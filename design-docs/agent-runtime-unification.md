# Agent Runtime Unification

## Purpose

This document defines the final API and implementation direction for unifying
`Agent`, the old durable-agent prototype, `Scenario`, and app bindings. Backward
compatibility is not a goal for this design. Existing APIs may be removed,
renamed, or replaced when they conflict with the final model.

The core decision is:

- `Agent` is the only public agent authoring surface.
- Durability is an execution mode, not a separate public agent type.
- Goal-oriented flows are `Agent.goal(...)`, not a separate `Scenario` class.
- App bindings stay in the app/runtime layer, not in the agent DSL.
- The durable node graph becomes the single execution engine for all agents.

## Decision Update (2026-06): Checkpoint Durability

This section is authoritative and supersedes any conflicting statement later in
this document. It records the decisions made after reviewing the current
implementation on `codex/durable-agent-runtime` against the ideal DX target.

The branch currently contains two coexisting durability paradigms:

- **legacy** durable agent: full replay from the initial session, with an effect
  journal, stable middleware/hook replay identity, and `NondeterminismError`
  detection.
- **graph** durable runtime (`executeAgentGraph` + `Durable*` in `durable.ts`):
  **checkpoint + skip-prefix**. On suspend it persists the whole session plus
  the suspended node path; on resume it restarts from the persisted session,
  skips the already-executed deterministic prefix, and re-enters loop children.

The final model is **checkpoint, not replay**. Concretely:

1. Durable execution persists a **session checkpoint at every node boundary**
   and resumes forward from the last checkpoint. Completed nodes are skipped;
   incomplete nodes are re-run.
2. The only journaled effect is an **idempotency-keyed memo for external
   writes**, so that a re-run node does not repeat a committed side effect.
   Model calls, hook/middleware results, and reads are **not** journaled.
3. Authors are under **no determinism obligation**. Middleware, hooks, models,
   and tool reads may differ between runs.
4. The legacy replay path, the effect journal for model calls, event replay,
   and `NondeterminismError` detection are **removed**, along with the
   middleware/hook compound replay-identity machinery that only existed to
   serve replay. Stable ids are still used as resume/skip coordinates and for
   idempotency keys, not for journal index validation.

DX decisions that follow from "ideal first" (backward compatibility is not a
goal):

- **One authoring form.** `Agent.create('name')` only. Node ids are
  **optional** and auto-derived from the structural path; explicit ids are
  required **only** at durable suspend/resume coordinates (`awaitInput`, goal
  interaction) and loops. `Agent.quick()` is removed; id-optional authoring
  replaces it.
- **Progressive disclosure.** `goal(...)` (intent, auto tool-loop) is the
  default layer; `turn(...)` (explicit `inbox`/`tools`/`awaitInput`) is the
  mechanism layer; raw graph nodes are the escape hatch. A high-level
  `assistant(...)` with registered tools auto-loops by compiling to
  `assistant` + `repeat(tools, assistant)` — it does **not** re-introduce a
  provider-internal tool loop.
- **Effect classification: the idempotency key is the only load-bearing
  requirement, and only for writes the author wants crash-safe.** The framework
  cannot detect that a tool body writes externally, and a crash-safe dedup key
  must be meaningful to the remote system, so only the author can supply it.
  Therefore:
  - A read/write `kind` taxonomy is **not** mandatory. Tools are already the
    effect boundary (the analog of a Temporal activity), and none of
    Temporal/Restate/Inngest force a read/write tag.
  - **Ephemeral runs are loose**: nothing must be declared. Authors add an
    `idempotencyKey` only on side effects that must not repeat — same
    honor-system posture as Temporal activities.
  - **Durable implies strict (decided).** The moment a run is durable, each tool
    must make one binary declaration: *safe to re-run* (read/compute) **or**
    *here is my idempotency key* (write). Tools that declare neither are a
    registration-time hard error. There is no separate `strict` flag — `durable`
    *is* the strict gear, so "durable" always means a real durable engine. There
    is **no strict opt-out in the first version**; an escape hatch is added only
    if a concrete need appears. This catches the "forgot to make my write
    idempotent" bug that Temporal leaves to the developer, with a single decision
    per tool rather than a full taxonomy.
  - `kind` remains optional sugar/metadata for retry/timeout/observability on
    top of that binary decision.
- **Framework components ship pre-classified; users declare only their own.**
  Framework-provided tools, hooks, and middleware carry their effect
  declarations baked in, so the strict gate only ever fires on author-written
  code. Effect classification is unified across tool/hook/middleware: anything
  that performs an external write must be keyed under strict durable; observers
  are idempotent by contract and exempt.
- **Edit tolerance is a non-goal; version mismatch fails fast.** Editing a
  durable agent that has in-flight runs is a version change, and resume fails
  fast — the same posture as Temporal, where editing workflow code breaks
  in-flight runs unless the author guards changes with explicit `patched()` /
  Build-ID pinning. PromptTrail does not promise auto-tolerant edits; explicit
  migration may be added later as the analog of Temporal patching. Because edit
  tolerance is not promised, node ids may be auto-derived freely, and the
  version gate's job is to *detect* the edit and fail safely.
- **The graph version gate is structural-only (a nicety, not a guarantee).**
  *(Superseded by Decision Update 2, point 8: edits invalidate resume and the
  hash includes serializable content.)*
  The manifest hash should cover node ids, types, graph paths, edges, tool
  names/activity, and handler ids — **not** node content (system text, source
  configuration). This is so a prompt tweak does not needlessly kill a resumable
  run (and under skip-prefix resume the edited prefix is skipped anyway); it is
  not a correctness requirement. (Current code hashes `node.data` wholesale in
  `createAgentGraphManifest`; narrow it to structural fields.)
- **Effects are localized to boundaries via synchronous decision handlers.**
  Under checkpoint there is no determinism obligation, but to keep external
  effects inside the keyed boundary (tools/assistant), the decision/transform
  handlers — `conditional`/`loop` conditions, `goal.isSatisfied`, `patch` — are
  **synchronous by type** (`=> boolean`, not `=> boolean | Promise<boolean>`),
  so IO cannot be smuggled into a condition via `await`. Authors fetch in a
  tool, stash in the session, and read it synchronously in the condition. This
  matches the existing intent ("`isSatisfied` must be deterministic with respect
  to the session"). A cheap runtime guard rejects a thenable returned from a
  synchronous handler. A full Temporal-style global IO sandbox is explicitly out
  of scope — unnecessary without replay.
- **Event sources are generic.** `Source<TEvent>` (event source) is parameterized
  and bindings infer `TEvent` from it; the closed
  `RuntimeBindingEvent = DiscordMessageEvent | CronEvent` union is removed so new
  platforms are added as packages without editing core.
- **Resolve the "source" name collision.** Node content supply (`Source.llm()`)
  and app event sources are different concepts and must not share a name. App
  event wiring moves under `app.on(...)` / a distinct namespace.

## Decision Update 2 (2026-06-10): Checkpoint Semantics Review

Authoritative; supersedes conflicting statements in the Decision Update above
and in the body below. Outcome of a deep review of the checkpoint/idempotency
mechanics (full reasoning and the code findings that motivated each point are
in `agent-runtime-unification-changes.md` §8).

1. **Run-mode naming: `durable` → `checkpoint`.** What the engine actually
   provides is "persist a checkpoint, resume forward" — not exactly-once. The
   run flag is renamed `checkpoint: true` (or `checkpoint: store`) so the name
   states the real guarantee, and the strict gate reads as "this effect re-runs
   on resume — acknowledge it", not "this is protected".
2. **Guarantee level: at-least-once + remote dedup.** The external commit and
   the memo/checkpoint persist are a dual-write to two stores; no local
   mechanism closes the crash window between them, and activity retry re-runs
   `fn` after a partial success even without a crash. Local memoization is
   therefore best-effort; **effective-once requires the remote system to honor
   the idempotency key** (Stripe-style). Documentation must not describe the
   memo as exactly-once. The effect→memo→persist ordering (at-least-once,
   never drops a committed write) is the chosen default and must be stated.
3. **Memo primitive: `ctx.durable.once(name, dep, fn)` and
   `ctx.durable.onceGlobal(name, key, fn)`.** Replaces the coordinate-keyed
   journal (`journaled` + `sequence`/`position` + `NondeterminismError`) and
   the `ctx.durable.memo/activity` pair. `name` is the stable operation
   namespace; `dep` is the dedup identity, `useMemo`-deps style — effective key
   `(name, hash(dep))`. Default `dep` is the session identity ("same session ⇒
   reuse, changed session ⇒ re-run"); `[session, x]` adds invalidation inputs;
   `onceGlobal(name, userid, fn)` is once-per-key across runs. Scope is
   explicit, never inferred from the dep: `once` = run-scoped journal, GC'd
   with the run; `onceGlobal` = cross-run store that requires a TTL/GC policy.
   *(Superseded in part by Decision Update 3, point 11: `onceGlobal` is
   removed; scope becomes an explicit `'run' | 'conversation'` option on
   `ctx.once`, with no forever scope and no TTL.)*
4. **Effect declaration collapses to a binary; the `kind` taxonomy is
   dropped.** `external-read` vs `compute` is a distinction without a
   difference (both = re-run is safe), and the real axis is *must-dedup* vs
   *repeatable* — an idempotent write is repeatable, a counter increment is
   must-dedup, so read/write mis-frames it. The declaration becomes
   `{ idempotencyKey: string | (input) => string }` **or**
   `{ repeatable: true }`; under checkpoint mode declaring neither is a
   registration-time error (the forcing function that catches a
   forgotten-key write). Keys must be allowed to depend on input
   (`charge:${orderId}`), so a static-string-only key type is insufficient.
   The gate covers tools and author hooks/middleware (the handler-level
   durable boundary already exists in code); observers stay exempt. `kind`
   survives only as optional retry/observability metadata.
5. **Resume layering: session + suspended path are primary; `once()` is the
   residual patch.** The session log already records model/tool results, so on
   resume the standard model→tool loop does not re-issue completed calls; the
   persisted suspended node path supplies the position without re-derivation.
   The only gap these cannot cover is the dual-write window of point 2 — that
   is what `once()`/the remote key exist for. Custom vars-driven loops must
   write their progress into the session for this layering to hold.
6. **Dynamic (MCP/provider-discovered) tools declare at the source.** The
   strict gate is registration-time for static tools, but MCP servers expose
   tools only at run time. Decision: the effect declaration attaches at
   *server/source registration* (defaults + per-tool overrides), and a tool
   discovered at run time without a resolvable declaration under checkpoint
   mode **fails the run at discovery** — the gate is never silently bypassed.
7. **`.codex(...)` / `.claude(...)` under checkpoint: provider-session resume
   is primary.** The provider owns the loop, so PromptTrail cannot checkpoint
   mid-turn. The checkpoint therefore persists the provider thread/session id,
   and resume **reconnects to the provider session** (the branch already has
   Codex thread binding and Claude Agent session resume to build on). Fallback
   when the provider session cannot be resumed: re-run the whole provider turn
   with an explicit "this turn was interrupted and restarted" preamble message
   — best-effort, and documented as such. Vendor-internal tool side effects are
   outside the idempotency memo; this limitation must be stated loudly.
   Fallback specifics (decided): **default is `fail`** — re-running a vendor
   turn re-runs undeclared side effects, so it requires the same explicit
   opt-in posture as the strict gate. `.codex({ onUnresumable: 'restart' })`
   opts in; `restartNotice` overrides the framework's default preamble text;
   `maxRestarts` (default 1, counter persisted in run state) caps repeated
   restarts, after which the run fails with a provider-turn-unresumable error
   (same fail-fast family as the graph-version error). "Unresumable" = thread
   expired, provider refused resume, or crash before the id was persisted —
   which is why the provider thread/session id must be **persisted immediately
   when the provider returns it**, not at turn completion.
8. **Version gate (supersedes "structural-only"): edits invalidate resume.**
   Decision: an edited graph is in general **not resumable**; resuming across
   an edit is author responsibility. The manifest hash therefore covers
   structure **and serializable node content** (system text, source
   configuration), with stable ids standing in for non-serializable members
   (closures, handlers, provider clients). Closure-body edits are undetectable
   by any hash — documented limitation; durable runs that span code edits are
   unsupported in v1 (explicit migration remains a later addition).
9. **Checkpoints persist session deltas, and the store API becomes async.**
   Session is immutable and append-only, so persist per node boundary the
   appended messages + a vars/attrs diff + a pointer (O(n) total instead of
   O(n²) full-session rewrites). The delta must include vars/attrs because
   `transform`/`patch` may change only those. `DurableRunStore.set`/`persist`
   are currently synchronous `void`, which a real async store cannot implement
   honestly; the store API becomes `Promise<void>` and the engine awaits
   persistence at effect boundaries.
10. **A session identity must be introduced.** `Session` currently has no
    version field (`transitionVersion` lives on the legacy replay state being
    deleted), and loop iteration counters are executor-local variables, not
    session or store state. The rewrite adds a monotonic session
    identity/version usable as the default `once` dep and as the delta
    pointer. Loops whose bodies do not advance the session need data-derived
    deps (preferred) or a persisted loop cursor. Session keying is by this
    identity, not a deep content hash — O(1), and correct because within-node
    re-execution is deterministic once nodes are decomposed finely enough that
    a nondeterministic call and a dependent write never share a node.
11. **Sequencing correction.** Decompose the remaining compatibility template
    nodes (changes §3.5) **before or together with** deleting the legacy
    runtime (changes §1) — legacy agents currently route through the generic
    `template` adapter node, so deleting legacy execution first breaks that
    path. Tag the pre-deletion commit so the replay implementation stays
    recoverable.

(Both open questions noted in earlier drafts are resolved by Decision Update
3: transforms by point 1, handler declarations by point 10.)

## Decision Update 3 (2026-06-10): Final Authoring Vocabulary

Authoritative; supersedes conflicting statements in the body below (including
the Turns section and the node-form lists). Outcome of a full review of the
authoring vocabulary. Decision Updates compose; where they conflict, the
highest-numbered wins.

1. **`transform` is the single programmatic node**, absorbing `patch` and
   `messages` (both removed). Two forms:
   - `.transform(id?, (session) => Session)` — pure and **synchronous**; no
     declaration needed because IO is impossible by type (a returned thenable
     throws at runtime).
   - `.transform(id?, { effect }, async (session, ctx) => Session)` — the
     binary effect declaration (Decision Update 2, point 4) **unlocks** the
     async handler and `ctx.once`. This is the graph-invoked effect step the
     DSL previously lacked (tools are model-invoked; an agent had no way to
     run a declared programmatic effect such as "fetch and stash before the
     model runs").
   This resolves the open transform question: undeclared transform is sync;
   declared transform is the effect step. "patch" survives only as the noun
   for session patches returned by hooks/middleware.
2. **The `turn` node is removed.** Verified: it has no runtime semantics
   (`executeChildren` once — a sequence) and existed only to scope the
   inbox/awaitInput/tools vocabulary at the type level. `inbox`, `awaitInput`,
   and `tools` become ordinary nodes. The "who owns the loop" contrast
   becomes: a `loop` you write (graph owns it) vs `.codex()` / `.claude()`
   (vendor owns it). The word "turn" leaves the authoring surface entirely.
3. **`repeat` is removed; `loop` is the only loop word.** Verified
   implementation-identical (both pre-condition while via `executeLoopNode`).
   `loop(id?, condition, builder, options?)` everywhere.
4. **The explicit `sequence` node is removed from authoring.** The agent top
   level and every container builder are already implicit sequences, so
   grouping/reuse/id-prefixing have no remaining need for a named node
   (and "edits invalidate resume" removed the id-stability motivation). The
   internal graph IR container node is named **`scope`** — it creates the id
   scope that auto-derived ids reference, and optionally a session scope.
5. **`subroutine` is the only named container besides control flow**, and its
   defaults are fixed to actually isolate. (Verified wart: current defaults —
   `retainMessages: true`, `isolatedContext: false` — make a bare
   `.subroutine()` behave exactly like a sequence.) It compiles to a `scope`
   node carrying a session policy: entry projection (`init`), exit projection
   (`squash`), plus declarative shortcuts. Proposed defaults: enter fresh,
   append sub-messages on exit (settle exact defaults at implementation).
6. **Run-per-event is the standard long-running shape.** An event-driven agent
   is a top-level implicit sequence that handles one inbound event and ends;
   conversation continuity is the app layer's job (same conversation id →
   checkpoint resume). An infinite `loop(() => true, ...)` graph is an
   anti-pattern. `awaitInput` is for mid-flow input only (e.g. goal
   interaction), not for "keep the conversation open".
7. **`Agent.run` does not exist and is not added.** The earlier doc example
   using `.run('Hi')` was a phantom; `execute({ input })` is the only
   execution verb.
8. **Consistency renames** (following Decision Update 2):
   - `ctx.durable.*` → **`ctx.once`** (the `durable` namespace is stale after
     the checkpoint rename; memo scopes per point 11).
   - `app.source(...)` → **`app.gateway(...)`** (removes the last "source"
     collision with `Source.llm()`).
   - The event-source type is **`Trigger<TEvent>`**, not `Source<TEvent>`
     (`EventSource` collides with the web/Node global); `app.on(trigger, ...)`.
   - Binding/agent-level `.durable(...)` overrides → **`.checkpoint(...)`**.
   - `app.activity(...)` (typing indicators) → **`app.presence(...)`**.
9. **Final authoring vocabulary**:
   - Leaf/protocol nodes: `system`, `user`, `assistant`, `transform`, `tools`,
     `inbox`, `awaitInput`, `structured`.
   - Containers: `loop`, `conditional`, `subroutine`, `parallel`.
   - Intent: `goal`. Vendor turns: `.codex()`, `.claude()`. Registration:
     `.tool()`.
   - GraphNode.type drops `turn`, `patch`, `messages`, `template`;
     `sequence` becomes `scope`; `codexTurn`/`claudeTurn` tags become
     `codex`/`claude`.
10. **Handler phases follow the same sync/async rule as `transform`.**
    Transform phases (`beforeModel`, `prepareModelInput`, `afterModel`,
    `beforeTool`, `afterTool`, and the hook lifecycle phases) become
    **synchronous by type** (`(ctx) => Patch | void`, thenable guard) — IO is
    impossible there, so **no effect declaration is needed** and the typical
    session-patch-only handler carries zero ceremony. Wrapper phases
    (`wrapModelCall`, `wrapToolCall`) are inherently async; a handler that
    defines a wrapper phase must carry the binary effect declaration and gets
    `ctx.once`. This rides the existing `ExecutionWrapperPhase` type split and
    resolves the "lighter default for session-patch-only handlers" question:
    they get no-declaration not by exemption but because IO is typed out.
11. **Memo scopes are `run` and `conversation`; there is no forever scope.**
    `onceGlobal` is removed. The single primitive is
    `ctx.once(name, dep, fn, { scope?: 'run' | 'conversation' })`, default
    `'run'`. Rationale: permanent business uniqueness ("welcome this user
    once, ever") is author-database / remote-constraint territory, not
    framework memo state — consistent with "remote dedup is authoritative"
    (Decision Update 2, point 2). With run-per-event, the `conversation`
    scope covers the real cross-run cases ("once per conversation"; periodic
    jobs embed the period in the key, e.g. `report:${date}`, so no TTL is
    needed). There is **no TTL option and no standalone GC API**: memo
    entries are co-located with their scope owner's store record (run /
    conversation), so cleanup rides the store's retention policy. An explicit
    "conversation close" trigger can be added later as an immediate-retention
    hook; it is not a v1 concept.
12. **Checkpoint option shape:**
    `checkpoint?: true | RunStore | { store?: RunStore }` — `true` uses the
    ambient default store (app), a bare store is shorthand for `{ store }`,
    and the object form hosts future options. The separate top-level `store`
    execute option is removed (no more "durable: true but forgot the store"
    split); `runId` stays top-level (run identity, not checkpoint config).
    Binding override: `.checkpoint(...)` with the same union. Confirmed from
    the same review: the declared `effect.idempotencyKey` (string or
    `(input) => string`) resolves per call and is handed to the tool body as
    `ctx.idempotencyKey` for forwarding to the remote system; auto-wrap uses
    `ctx.once(tool.name, session-identity, body)` so a single-effect tool
    body stays plain.

## Rationale and Discussion (2026-06)

This records *why* the decisions above were reached, including the alternatives
considered and the reference systems compared (`references/temporal-sdk-typescript`,
`references/restate-sdk-typescript`, `references/inngest-js`). It is design
history; the Decision Update above is the authoritative outcome.

### Why checkpoint, not replay

The branch had two coexisting durability paradigms. A review first mis-diagnosed
the graph runtime as "missing model-call journaling, therefore unsound." Reading
`durable.ts` corrected this: the graph runtime is **checkpoint + skip-prefix**
(persist the whole session at suspend; resume from it; skip the completed
prefix), which is sound *without* journaling model calls. So the real question
was not a bug but a paradigm choice: keep the legacy **replay** runtime or the
graph **checkpoint** runtime.

Replay (Temporal/Restate/Inngest) imposes a global determinism obligation on
author code: every effect needs a stable journal coordinate, control flow must
be deterministic, middleware/hooks must be named and order-stable, and provider
integration must route through the journal. The payoff is small storage, replay
debugging, and automatic once-only effects. Checkpoint imposes none of that
— "we save your session and move forward, write whatever code you want" — at the
cost of losing free replay-debugging. (The "small storage" edge mostly vanishes
for agents; see the convergence note below — the session log already *is* the
effect journal.)

For a framework whose thesis is *lightweight authoring, durability as a flag*,
checkpoint is the better fit; replay is the right call only for expert,
mission-critical exactly-once orchestration (Temporal's niche). Decision:
checkpoint, and **delete** the replay machinery rather than port it.

#### Replay and checkpoint converge for agents

A later re-examination softened "replay is bad" to "replay and checkpoint
converge for this domain," for two reasons worth recording.

First, **the effects replay would journal are already persisted as session
messages.** A model response is an assistant message; a tool result is a tool
message. So PromptTrail's checkpoint *already journals* exactly what replay
would — the session log *is* the effect journal. Durability does not throw away
journaling; it keeps it (as messages) and only drops *re-execution on resume*.
With model/tool effects captured this way, the sole remaining difference is the
resume mechanic:

- **checkpoint**: skip completed nodes, restore the session, run each node
  **once across the run's lifetime**, move forward.
- **replay**: re-execute completed nodes too, short-circuiting their effects
  against the journal and **matching** the result.

For agents the control-flow glue (e.g. `session.hasToolCalls()`) is a pure
function of the session, so re-running it (replay) yields the same answer as
skipping it (checkpoint) — the two are observably isomorphic. What replay buys
on top is nondeterminism *detection* and history-replay *debugging*; what it
costs is a determinism contract on re-run glue. Agents are intrinsically
nondeterministic and the model output is captured either way, so the detection
is worth less here while the determinism tax is real. Net: a genuine tilt to
checkpoint (forward-only, no determinism contract), not a knockout. The one
replay asset worth keeping — history-replay debugging — can be recovered as a
debug harness over saved session snapshots *without* imposing a determinism
contract on production runs.

#### Prior art: replay is for imperative code, checkpoint is for graphs

Checkpoint-style durable execution is well-precedented, and the split tracks the
shape of the computation:

- **Replay camp** (re-derive an arbitrary imperative call stack via deterministic
  re-execution): Temporal/Cadence, Azure Durable Functions, Restate, Inngest.
  Replay is the trick that makes *ordinary imperative code* durable — you cannot
  portably snapshot a running stack, so you rebuild it by replaying.
- **Checkpoint camp** (persist state at each boundary, resume forward, do not
  re-run user code from the top): AWS Step Functions, Google Cloud Workflows,
  Azure Logic Apps (state-machine snapshot at each transition); DBOS Transact
  (records each step's output, skips completed steps on recovery); Trigger.dev v3
  (checkpoint-resume); and most relevantly **LangGraph**, whose `checkpointer`s
  (Memory/Sqlite/Postgres savers) snapshot graph state after each super-step and
  resume from the latest checkpoint (with earlier checkpoints enabling
  time-travel). OpenAI Agents SDK sessions are similarly state-persistence based.

The key point: when the computation is already an explicit **graph /
state-machine**, the nodes are natural checkpoint boundaries and resume
coordinates, so replay's stack-reconstruction trick is unnecessary. PromptTrail
is a graph, so checkpoint is the natural, well-precedented lineage — and the
closest peer in the same domain (LangGraph, agent graphs) chose checkpoint, not
replay. Replay frameworks look ubiquitous only because they target the different
problem of making arbitrary imperative functions durable.

### Why the idempotency key is the only hard requirement

Under checkpoint, the one hazard is a re-run node repeating a committed external
write. The framework cannot statically detect that a tool body writes (it is an
arbitrary async function), and a crash-safe dedup key must be meaningful to the
remote system — so only the author can supply it. That makes the **key** the
single irreducible thing a user must provide, and only for writes they want
crash-safe.

A read/write **taxonomy**, by contrast, is *not* required: re-running a read is
harmless, and the reference systems confirm the posture — Temporal, Restate, and
Inngest all require an effect *boundary* (activity / `ctx.run` / `step.run`) but
none require a read/write tag, leaving idempotency to the developer. In
PromptTrail the **tool is already that boundary** (the analog of a Temporal
activity), so forcing a `kind` taxonomy would be ceremony the references show is
unnecessary.

Why then offer **strict durable mode** (one binary decision per tool)? Because
replay systems get a free forcing function — an unmarked effect re-executes
loudly on every replay or throws in the sandbox, so mistakes surface
immediately. Checkpoint removed that forcing function, so an undeclared write
fails only *silently* in the rare crash-mid-node window. Strict mode restores a
forcing function at the lowest possible ceremony: "is this tool safe to re-run,
or here is its key?" — one decision, not a taxonomy. This is strictly *more*
helpful than Temporal, which leaves write-idempotency entirely to trust.

### Why edit tolerance is a non-goal

A concern was raised that auto-derived ids would not survive graph edits to
in-flight runs. Checking the references showed this is unsolved everywhere:
Temporal does **not** auto-tolerate workflow edits — authors must wrap changes in
explicit `patched()` / `deprecatePatch()` markers or pin runs to a Build ID /
Worker Deployment (`references/temporal-sdk-typescript/packages/workflow/src/workflow.ts`).
Holding PromptTrail to "auto-tolerant edits" was therefore a *higher* bar than
Temporal. Dropping that bar simplifies the design: ids can be auto-derived
freely, and the version gate's role is simply to detect an edit and fail fast
(explicit migration, the analog of Temporal patching, can come later). This is
why the structural-only hash is framed as a nicety (don't kill a run over a
prompt tweak), not a correctness guarantee.

### Why synchronous decision handlers instead of an IO sandbox

The question arose of whether durable mode should error on arbitrary async/IO,
like Temporal's workflow sandbox. Under checkpoint the *determinism* rationale
for that ban evaporates (no replay). The only remaining reason to restrict IO in
author code is to keep effects inside the keyed boundary so they are
crash-protected. A full global IO sandbox (replacing `Date`/`Math.random`/timers
/network) is heavy, runtime-specific, and brittle — overkill here. The
type-level equivalent achieves the same goal at zero runtime cost: make the
decision/transform handlers (`conditional`/`loop` conditions, `goal.isSatisfied`,
`patch`) **synchronous**, so IO cannot be `await`ed inside them and naturally
flows into tools. This also just enforces the design's pre-existing intent that
`isSatisfied` be deterministic over the session. Neither approach is
bullet-proof (a determined author can fire-and-forget a promise), but the type
version removes the *accidental* path and makes the right way the easy way.

## Final Vocabulary

| Term         | Meaning                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`      | A named, reusable graph of prompt, model, tool, goal, and control nodes.                                                          |
| `App`        | Owns stores, sources, routing, execution, resume, locks, and delivery.                                                            |
| `Binding`    | Maps platform events to an agent, conversation id, input, and defaults.                                                           |
| `Run`        | One execution instance of an agent for a conversation/task.                                                                       |
| `Durable`    | Renamed `checkpoint` (Decision Update 2): session deltas are persisted at node boundaries and resumed forward. Execution is at-least-once; keyed effects are deduped best-effort locally and authoritatively by the remote system. |
| `Goal`       | A high-level agent node that loops model/tool/user interaction until a satisfaction condition succeeds or attempts are exhausted. |
| `Middleware` | Changes model/tool requests, results, or session patches through deterministic phases.                                            |
| `Hook`       | Observes lifecycle phases and may return explicit session patches.                                                                |
| `Observer`   | Receives emitted facts and may perform idempotent presentation/metrics side effects.                                              |

The old `DurableAgent`, `DurableTurnBuilder`, `Scenario`, and
`MemoryDurableRuntime` concepts are not final public APIs. `RuntimeBundle` can
remain as an internal/exportable structural runtime IR, but it should not be the
ordinary authoring API.

## Public API

### Agent Definition

Agents are named. The name is required because app bindings, run metadata,
events, graph versions, and generated ids need a stable root.

The package root exports the final authoring surface only. It must not
wildcard-export the low-level template implementation module. Public root
exports include `Agent`, graph helper types, and the final helper templates
such as `Parallel` and `Structured`; implementation primitives such as
`System`, `User`, `Assistant`, `Sequence`, `Loop`, `Subroutine`,
`Conditional`, `Transform`, `GenerateMessages`, `TemplateBase`, and
`Composite` stay behind the `templates` submodule for internal and advanced
use. `.codex(...)` and `.claude(...)` are `Agent` fluent methods (renamed from
`codexTurn`/`claudeTurn`); the `CodexTurn` and `ClaudeTurn` classes are
low-level template implementations and are not package-root exports. Graph structure and manifest helpers may be root
exports, but graph executor internals such as `executeAgentGraph`,
`GraphExecutionOptions`, and `GraphExecutionSuspended` stay behind the
`graph_executor` submodule for internal and advanced runtime use. Any submodule
named here must also be a real package export; hiding a symbol from the root
must not make the advanced import path unavailable in built packages. Provider
turn options such as `CodexTurnOptions` and `ClaudeTurnOptions` may be root
types because they are part of the `Agent.codex(...)` and
`Agent.claude(...)` authoring surface; provider adapter constructors and
conversion helpers stay behind `codex_app_server` and `claude_agent`
submodules. Runtime host, dispatch, and mock helpers are also low-level
submodules; root may expose adapter authoring types needed by
`PromptTrail.app(...).source(...)`, `.delivery(...)`, `.activity(...)`, and
`.adapter(...)`, but not direct host/dispatch/mock helper values.

```ts
// Intent layer: top-level assistant auto-loops over tool calls.
const assistant = Agent.create('assistant')
  .system('You are a concise project assistant.')
  .tool('lookup', lookupTool)
  .inbox()
  .assistant(Source.llm().openai({ api: 'responses' }));

// Mechanism layer: the same agent with the tool loop written out.
const explicit = Agent.create('assistant')
  .system('You are a concise project assistant.')
  .tool('lookup', lookupTool)
  .inbox()
  .assistant('model', Source.llm().openai({ api: 'responses' }))
  .loop(
    'tool-loop',
    ({ session }) => session.hasToolCalls(),
    (loop) =>
      loop
        .tools()
        .assistant('model', Source.llm().openai({ api: 'responses' })),
  );
// Conversation continuity is the app layer's job (run-per-event); there is
// no trailing awaitInput and no infinite loop in the graph.
```

Node ids are optional and auto-derived from the structural path (see the
Decision Update); when authored they are not display labels but stable graph
coordinates used by durable resume/skip and the structural version check.
Explicit ids are required only at suspend/resume coordinates and loops.

Common node forms:

```ts
// Final node forms (Decision Update 3). All ids optional.
Agent.create('name')
  .system(content)
  .user(contentOrSource)
  .assistant(sourceOrHandler, options)
  .transform(handler)                          // pure, sync
  .transform(id, { effect }, asyncHandler)     // declared effect step
  .inbox(options)
  .awaitInput(id)                              // mid-flow input only
  .tools(options)
  .goal(id, goal, options)
  .conditional(condition, thenBuilder, elseBuilder)
  .loop(id, condition, builder, options)
  .subroutine(id, builder, options)            // isolating by default
  .codex(options)
  .claude(options);
```

Node ids are **optional**. When omitted they are auto-derived from the
structural path (parent scope + node type + occurrence within scope), so the
content-first style still works without ceremony:

```ts
await Agent.create('helper')
  .system('You are helpful.')
  .user('Hello')
  .assistant()
  .execute();
```

There is one authoring form. `Agent.quick()` is removed — id-optional authoring
replaces it. Auto-derived ids are sufficient for ephemeral runs and for durable
runs that do not span an edit. Explicit ids are required only at durable
suspend/resume coordinates (`awaitInput`, goal interaction) and loops, and the
registration-time lint reports exactly which nodes need them when an agent is
marked durable.

Current implementation gap: `Agent.create(name)` already requires a stable
name (keep this), but node ids are still mandatory and `Agent.quick()` still
exists. Target: make node ids optional with path-derived defaults and delete
`Agent.quick()`.

The old static content-first helpers `Agent.system(...)`, `Agent.user(...)`,
and `Agent.assistant(...)` are not final public APIs.

### Tools

Tools are registered on agents and can be used by both low-level turns and
goal nodes.

```ts
// A read: re-running it is harmless — declare it repeatable.
const lookupTool = Tool.create({
  description: 'Load a customer record.',
  inputSchema: z.object({ id: z.string() }),
  effect: { repeatable: true, retry: { maxAttempts: 3 } },
  execute: ({ id }) => loadCustomer(id),
});

// A write that must not repeat: declare a key (input-dependent).
const chargeTool = Tool.create({
  description: 'Charge an order.',
  inputSchema: z.object({ orderId: z.string() }),
  effect: { idempotencyKey: ({ orderId }) => `charge:${orderId}` },
  execute: ({ orderId }, ctx) => chargeOrder(orderId, ctx.idempotencyKey),
});

const agent = Agent.create('support')
  .tool('lookup', lookupTool)
  .tool('charge', chargeTool);
```

The tool `effect` declaration is the default boundary for the tool call. In the
common case this declarative metadata is enough: the engine auto-wraps the tool
body in `ctx.once(tool.name, dep, ...)` (default `dep` = the session
identity) whenever a checkpoint boundary is present, so a single-effect tool
body stays plain. Explicit `ctx.once` calls are needed only for **multiple
nested** effect boundaries inside one tool body or for conversation-scoped
(`{ scope: 'conversation' }`) dedup. The resolved key is also handed to the tool
body (`ctx.idempotencyKey`) so it can be forwarded to the remote system —
which is where effective-once is actually enforced (Decision Update 2,
point 2).

The only load-bearing requirement is the **idempotency key**, and only for a
write the author wants crash-safe (see Rationale). The declaration is binary:

```ts
// Decision Update 2: the kind taxonomy is dropped. The declaration is binary —
// must-dedup (key, which may depend on input) or repeatable. Declaring neither
// is a registration-time error under checkpoint mode.
type Effect =
  | { idempotencyKey: string | ((input: unknown) => string); retry?: RetryPolicy }
  | { repeatable: true; retry?: RetryPolicy };
```

Mode behavior:

- **Ephemeral = loose:** nothing must be declared. Add an `idempotencyKey` only
  on side effects that must not repeat — Temporal-style honor system.
- **Checkpoint = strict (automatic, no separate flag):** each tool must declare
  one of `repeatable: true` or `idempotencyKey`; a tool declaring neither is a
  registration-time hard error. One binary decision per tool, not a taxonomy.
  No strict opt-out in v1 — checkpoint always means a real durable engine.
- Framework-provided tools/hooks/middleware ship pre-classified, so the strict
  gate only fires on author-written code. Dynamic (MCP) tool sources carry the
  declaration at server registration (Decision Update 2, point 6).

Current implementation: `Tool.create(...)` accepts `inputSchema` as the only
schema key; the old `parameters` compatibility alias is intentionally rejected.
`Tool.create({ activity })` stores the activity as a first-class
`PromptTrailTool.activity` field and also mirrors it in metadata for
introspection. `executePromptTrailTool(...)` passes `ctx.activity` into tool
bodies and wraps execution in `ctx.durable.activity(tool.name, activity, ...)`
when the caller supplies a durable boundary. Graph tool nodes pass agent/app
`context` and the tool activity into tool execution. Full graph-durable
journaling of tool bodies is still covered by the first-implementation scope
below.

### Turns

> **Superseded by Decision Update 3.** The `turn` node is removed: it had no
> runtime semantics beyond executing its children once, and existed only to
> scope the `inbox`/`awaitInput`/`tools` vocabulary. Those are now ordinary
> nodes; `repeat` is unified into `loop`; the conversation loop lives at the
> app layer (run-per-event). This section is kept as design history.

`turn(...)` is the low-level durable control surface. It replaces the old public
`DurableAgent.turn(...)` API.

```ts
const agent = Agent.create('main')
  .system('system', 'You are a long-running assistant.')
  .turn('main', (turn) =>
    turn
      .inbox('inbound')
      .assistant('reply', Source.llm().openai())
      .repeat(
        'tool-loop',
        ({ session }) => session.hasToolCalls(),
        (loop) => loop.tools('tools').assistant('reply', Source.llm().openai()),
      )
      .awaitInput('next'),
  );
```

Turn node vocabulary:

- `inbox(id, options?)`: consume pending inbound messages into the session.
- `assistant(id, sourceOrHandler, options?)`: run a model/provider turn.
- `tools(id, options?)`: run tool calls from the previous assistant message.
- `repeat(id, condition, builder, options?)`: repeat the nested block while
  the condition is true.
- `awaitInput(id)`: suspend until new inbound input exists.
- `patch(id, handler)`: apply a deterministic session patch.

The current `steer` name should not be final. `inbox` is clearer because the
node consumes runtime inbox entries. If a non-consuming peek is needed later, it
should be named `peekInbox`.

`repeat(...)` is a pre-condition loop and is nested instead of "repeat the
previous block" so replay coordinates are explicit and authors can see exactly
which nodes loop. The common model/tool loop is one initial `assistant(...)`
followed by `repeat(..., loop => loop.tools(...).assistant(...))`.

Inside a `turn(...)`, assistant nodes produce one model response and tool
execution belongs to the `tools(...)` node. Provider adapters and `Source.llm()`
must not run an internal tool loop when compiled into a graph turn; they may
still expose provider-native tool-call encoding and streaming, but graph
execution owns the tool-call loop and the `beforeTool`/`wrapToolCall`/`afterTool`
phases.

This is the mechanism layer. At the intent layer, a top-level `assistant(...)`
(and every `goal(...)`) **auto-loops** over tool calls. The auto-loop is pure
authoring sugar that compiles to `assistant` + `repeat(tools, assistant)`; it
does not re-introduce a provider-internal loop. Authors only drop into
`turn(...)` when they need explicit control over inbox consumption, the loop
condition, or suspend points.

#### `turn(...)` vs `.codex(...)` / `.claude(...)`

These are different node kinds (the graph models them as distinct
`GraphNode.type`s — `'turn'` vs the provider node types). They are sibling
nodes, not nested variants. The authoring methods are deliberately named to make
the distinction obvious (the old `codexTurn`/`claudeTurn` names are dropped to
avoid the "turn" collision).

- `turn(...)` is a **provider-agnostic control-flow container**. The author
  composes `inbox`/`assistant`/`tools`/`repeat`/`awaitInput` inside it, and
  **graph execution owns the loop, the suspend coordinates, and the
  before/after-tool phases**. The inner `assistant` node can use any
  `Source.llm()` provider.
- `.codex(...)` / `.claude(...)` are **single provider-native nodes** that
  delegate a whole turn to a backend that runs its own agent loop / session
  (`.codex` → the Codex app-server; `.claude` → the Claude Agent SDK). You do
  not compose `inbox`/`tools`/`repeat` inside them; **the provider owns the loop
  and session**. They sit at the raw-node layer.

So the distinction is *who owns the loop*: `turn` = you (the graph);
`.codex`/`.claude` = the provider. The naming also pairs with the raw-model
side: `Source.llm().openai()` / `.anthropic()` call the model (graph owns the
loop), while `.codex()` / `.claude()` hand the turn to the vendor's agent
runtime (vendor owns the loop). There is no "`.codex` inside a `turn`"
relationship.

### Goals

`Scenario` becomes `Agent.goal(...)`.

```ts
const research = Agent.create('research')
  .system('system', 'You are a research assistant.')
  .tool('search', searchTool)
  .goal('collect-question', 'Get the user research question', {
    interaction: 'required',
  })
  .goal('research-topic', 'Research the topic thoroughly', {
    maxAttempts: 6,
    // Synchronous by design — see "synchronous decision handlers".
    isSatisfied: ({ session, goal }) => hasEnoughSources(session, goal),
  })
  .goal('final-answer', 'Provide a comprehensive answer');
```

Goal options:

```ts
interface GoalOptions<TVars, TAttrs> {
  interaction?: 'none' | 'optional' | 'required';
  maxAttempts?: number;
  tools?: readonly string[] | Record<string, Tool>;
  model?: Source<ModelOutput> | AssistantHandler<TVars, TAttrs>;
  // Synchronous by design: a decision handler cannot `await` IO. Fetch in a
  // tool, stash in the session, read it here synchronously. (See Decision Update:
  // effects are localized to boundaries via synchronous decision handlers.)
  isSatisfied?: (ctx: GoalSatisfactionContext<TVars, TAttrs>) => boolean;
  onUnsatisfied?: 'retry' | 'continue' | 'halt';
}

interface GoalSatisfactionContext<TVars, TAttrs> {
  session: Session<TVars, TAttrs>;
  goal: string;
  attempt: number;
  context?: Record<string, unknown>;
}
```

Goal semantics:

- A goal is a graph node, not a separate agent type.
- A goal compiles to a stable subgraph:
  - `goalId/prompt`: goal prompt/input node
  - `goalId/attempts`: retry loop node
  - `goalId/attempts/model`: assistant/model node
  - `goalId/attempts/tools`: tool execution node
  - `goalId/attempts/check`: satisfaction check node
  - `goalId/attempts/interaction`: optional user interaction node
- `model` defaults to `Source.llm()`.
- `maxAttempts` defaults to the graph executor's loop limit.
- If `isSatisfied` is omitted, a goal is satisfied after one model/tool attempt,
  except that `interaction: 'required'` still requires an input turn first.
- `interaction: 'required'` means the goal must ask for user input before it can
  be satisfied.
- `interaction: 'optional'` permits user input tools but does not require them.
- `interaction: 'none'` forbids user input tools.
- `isSatisfied` must be deterministic with respect to the session. External
  work belongs in model/tool/middleware phases, not in the goal satisfaction
  check.
- Interactive goals use `awaitInput` internally. The suspend step id is derived
  from the goal subgraph path, for example
  `research-topic/attempts/interaction`.

There is no final `Scenario` export.

### Direct Execution

Direct execution remains useful for scripts and tests.

```ts
const result = await agent.execute({
  input: 'Review this repository.',
});

const checkpointed = await agent.execute({
  runId: 'task:review-repo',
  input: 'Review this repository.',
  checkpoint: store,
});
```

Final `Agent.execute` takes one options object. It does not take
`Session | undefined` as the first positional argument.

```ts
interface AgentExecuteOptions<TVars, TAttrs> {
  runId?: string;
  input?: string | InboundInput;
  session?: Session<TVars, TAttrs>;
  // true = use the ambient default store (app context); a bare RunStore is
  // shorthand for { store }; the object form is the home of future options.
  checkpoint?: true | RunStore | { store?: RunStore };
  context?: Record<string, unknown>;
  observers?: readonly ObserverLike[];
  signal?: AbortSignal;
}
```

`checkpoint: true` uses the ambient default store (the app's); with no ambient
default it fails immediately with a message pointing at `checkpoint: store`.
`runId` stays top-level — it is run identity, not checkpoint configuration,
and is meaningful for ephemeral observability too. Execution without
`checkpoint` is ephemeral. The binding-level override is `.checkpoint(...)`
with the same union.

Implementation note: direct `Agent.execute({ checkpoint: true })` has no
app-level default store, so direct execution passes the store directly
(`checkpoint: store`) or sets it once via `agent.checkpoint({ store })`.
Direct checkpointed graph execution accepts one inbound
input per call; follow-up input is appended by executing the same named agent
again with the same `runId` and store. For direct graph execution only, `input`
is materialized by `GraphExecutor` when the graph has no `inbox`, `awaitInput`,
or dynamic `user` node. Materialization happens after leading top-level
`system` nodes so authored system context still precedes user input. Graphs with
explicit inbound consumers keep `input` in the runtime inbox. Direct durable
graph execution threads per-call `observers`, `strictObservers`, and
`observerDeliveryBindings` into the temporary app runtime used for the run.

### App Runtime

The app is the only host for event sources, bindings, delivery, and durable
conversation resumption.

```ts
const app = PromptTrail.app({
  store: sqliteStore('./prompttrail.db'),
  defaults: {
    checkpoint: true,
    delivery: Delivery.origin(),
  },
})
  .agent(assistant)
  .on(discord.messages(), (binding) =>
    binding
      .where(discord.notBot())
      .where(discord.inChannels(['general', 'news']))
      .to(assistant)
      .conversation(
        discord.sessionKey({
          groupSessionsPerUser: true,
          threadSessionsPerUser: false,
        }),
      )
      .input((event) => event.content)
      .reply(discord.replyToOriginThread())
      .context((event) => ({
        platform: 'discord',
        channelId: event.channelId,
      })),
  )
  .on(cron.schedule('0 9 * * *'), (binding) =>
    binding
      .name('daily-review')
      .to(assistant)
      .conversation((event) => `cron:${event.job.id}`)
      .input('Review open tasks and post a concise summary.')
      .reply(discord.channel('news')),
  );

await app.start();
```

App event wiring is `app.on(eventSource, binding)` (decided). The name `on`
disambiguates app event sources from the node-content `Source.llm()` — the two
"source" concepts never share a verb. `to(...)` accepts an `Agent` instance or
an agent name. Passing an agent instance registers it if needed and stores its
name in the binding.

The final API should not require a separate `bundle` object for ordinary use.
However, the app should still compile bindings into a structural
`RuntimeBundle` IR. Tests, mocks, servers, and deployment wiring can consume
that IR. `PromptTrail.runtimeBundle(...)` remains the explicit low-level IR
builder for those cases; ordinary app authoring stays on
`PromptTrail.app(...).on(...)`. The old root `app(...)` shortcut and
`manualSource()` helper are not package-root APIs; low-level test/runtime
utilities may still import them from the durable submodule. The bundle keeps
live agent instances and resolver functions, so it is not a JSON serialization
boundary.

### Sources, Adapters, and Delivery

Event sources and delivery drivers are app/runtime concerns.

```ts
const app = PromptTrail.app({ store })
  .gateway(discordGateway({ token }))
  .delivery(discordDelivery({ token }))
  .presence(discordTypingPresence({ token }));
```

(Decision Update 3 renames: `.source(...)` → `.gateway(...)` so the last
"source" collision with `Source.llm()` disappears; `.activity(...)` →
`.presence(...)`. The event-source type is `Trigger<TEvent>`.)

Event sources are generic: an event source is `Source<TEvent>` (distinct in name
from the node-content `Source.llm()`), and a binding infers `TEvent` from the
source it is bound to. The closed
`RuntimeBindingEvent = DiscordMessageEvent | CronEvent` union is removed; new
platforms (`slack`, `github`, ...) ship as packages without editing core, and
`discord`/`cron` are just the first such packages. The two "source" concepts
must not share a public name — node content stays `Source.llm()`, app event
wiring moves under `app.on(...)` / a distinct event-source namespace.

Bindings never call platform APIs directly. They only normalize routing:

- source event
- filters
- agent
- conversation id
- input
- run defaults
- delivery target
- context

The app facade owns user-facing composition. Internally it should preserve two
layers:

- runtime/executor: graph execution, store, session checkpoint, idempotency
  memo, inbox cursor, events
- server/host: sources, bindings, per-conversation locks, delivery, activities

The app/server host owns:

- per-conversation locks
- inbox append
- durable resume
- model/tool execution
- final delivery outbox
- delivery retry
- observer delivery binding state

## Runtime Semantics

### One Engine

All agents compile to one graph representation. Ephemeral execution runs the
same graph without persisting checkpoints; durable execution persists a session
checkpoint at every node boundary.

The final implementation should not keep separate template and durable engines.
The current template primitives can become authoring helpers, but execution
must flow through the graph executor.

```ts
Agent DSL -> AgentGraph -> GraphExecutor
                         -> EphemeralRunState   (no persistence)
                         -> DurableRunState     (session checkpoint + idempotency memo)
```

### Graph Model

```ts
interface AgentGraph {
  name: string;
  version: string;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  tools: Record<string, Tool>;
  middleware: readonly MiddlewareDefinition[];
  hooks: readonly HookDefinition[];
  observers: readonly ObserverLike[];
}

interface GraphNode {
  id: string;
  // Final type set (Decision Update 3): turn/patch/messages/template are
  // removed, sequence is renamed scope (subroutine compiles to scope plus a
  // session policy), and the provider tags are codex/claude.
  type:
    | 'system'
    | 'user'
    | 'assistant'
    | 'transform'
    | 'tools'
    | 'inbox'
    | 'awaitInput'
    | 'goal'
    | 'scope'
    | 'loop'
    | 'conditional'
    | 'parallel'
    | 'structured'
    | 'codex'
    | 'claude';
  data: unknown;
}
```

Local node ids are unique within their parent scope. Full graph paths are
unique within an agent. Nested ids are represented as graph paths at compile
time, not derived from array positions.

### Graph Versioning

Every durable run stores (checkpoint model):

- agent name
- graph version/hash (structural)
- graph manifest (structural)
- latest **session checkpoint** (the resume state)
- suspended node path
- inbox + inbox cursor
- idempotency-keyed effect memo (external writes only)
- final delivery outbox
- run context

There is no model/tool effect journal and no event-replay log. Resume restarts
from the session checkpoint, not from the initial session.

If the registered agent graph does not match the stored graph version, resume
must fail with a graph-version error unless an explicit migration or
force-continue policy is provided.

First implementation: graph durable runs persist the generated graph manifest
and compare the stored manifest hash against the currently registered agent
before resume. Migrations and force-continue are not implemented; mismatches
fail fast with a graph-version error.

The graph manifest is a verification artifact, not an executable snapshot.
Nodes may contain closures, `Source` instances, provider clients, and handlers
that cannot be serialized. Execution code always comes from the currently
registered agent. Per Decision Update 2 (which supersedes the earlier
structural-only stance): **edits invalidate resume**, so the manifest hash
covers as much as it can detect —

- graph version/hash
- node ids, node types, and graph paths
- edge/control structure
- tool names and tool effect declarations
- middleware/hook ids and declaration order
- **serializable node content** (system text, source configuration)
- stable ids standing in for non-serializable members (closures, handlers,
  provider clients)

Closure-body edits are undetectable by any hash; this is a documented
limitation, and durable runs that span code edits are unsupported in v1.

### Durable Step Coordinates

Under checkpoint durability, stable ids are **resume/skip coordinates**, not
journal indexes. They derive from graph paths:

```txt
agentName/nodeId                 # skip-prefix + resume coordinate
agentName/turnId/awaitInput      # suspend point
agentName/goalId/interaction     # suspend point
```

Effect-memo keys are **not** graph coordinates (Decision Update 2): the memo is
keyed by `(name, hash(dep))` from `ctx.durable.once(name, dep, fn)` —
content-addressed, so it survives resume and path changes — and global dedup is
keyed by the author's key under `{ scope: 'conversation' }`, which is also
what the remote system dedups on.

Ids must not include array positions or generated anonymous names. Auto-derived
ids from the structural path are sufficient for ephemeral runs and for durable
runs that do not span an edit. Authors should give explicit ids to the nodes
whose resume position must survive edits: `awaitInput`, goal interaction points,
and loops.

### Middleware and Hook Ordering

Handlers still run in a deterministic layer order:

1. agent middleware/hooks
2. app middleware/hooks
3. binding middleware/hooks
4. runtime internal middleware/hooks

Each handler should have a stable id, which is recorded in the structural
manifest so that adding/removing/reordering handlers registers as a graph
version change:

```ts
Middleware.create('channel-policy', { beforeModel(...) { ... } });
Hook.create('audit', { onRunStart(...) { ... } });
```

Under checkpoint durability there is **no replay-identity compound key and no
per-handler journal index**. Handlers are not replayed; they simply run forward
on each resume. The previous prototype's compound replay-identity validation
(phase + handler kind + handler id + declaration order, checked against journal
indexes) is removed. Stable ids matter only for the structural version gate.
Anonymous handlers are allowed for ephemeral runs and force a structural id when
an agent is marked durable (surfaced by the registration-time lint).

### Effect Boundaries

Durable mode (checkpoint) persists:

- the session checkpoint at each node boundary (this already captures inbox
  consumption, model results, tool results, and session transitions from
  hooks/middleware/patches/goals — they live in the session)
- the inbox cursor and suspended node path
- an idempotency-keyed effect memo for `external-write` activities only

It does **not** journal model calls, tool reads, or hook/middleware results for
replay. A re-run node re-executes those effects; the idempotency memo prevents a
committed external write from repeating.

Observers are not part of session state. They receive live events only; there is
no replayed-event adoption policy because there is no replay.

Final assistant delivery is always an engine-owned outbox entry. Handlers do
not call a general `outbox.send(...)` API in the first final design.

## Implementation Plan

Backward compatibility is not required, so implementation should replace the
split runtime instead of layering more adapters over it.

### Phase 1: Define Graph IR

- Add `AgentGraph`, `GraphNode`, `GraphEdge`, `GraphExecutor`.
- Make `Agent` a graph builder instead of a `Template` wrapper.
- Make node ids optional with path-derived defaults; require explicit ids only
  at durable suspend/resume coordinates and loops (enforced by the
  registration-time lint, not by mandatory authoring).
- Remove `Agent.quick()`; id-optional `Agent.create('name')` covers ephemeral
  content-first examples.
- Remove or stop exporting `DurableAgent`, `DurableTurnBuilder`, `Scenario`,
  and `MemoryDurableRuntime`. `DurableAgent` may remain as an internal legacy
  implementation while graph execution becomes authoritative.
- Stop root-exporting legacy durable tool-only context/activity aliases once
  `ToolExecutionContext` and `ExecutionDurableActivityOptions` cover the
  public tool API.
- Define the structural `RuntimeBundle` IR that app bindings compile to.

### Phase 2: Map Existing Semantics to Graph Nodes

- Create a complete node mapping table for:
  - system/user/assistant/messages/patch
  - transform
  - structured output
  - validation
  - parallel
  - loop/conditional/subroutine
  - codexTurn/claudeTurn
  - provider-native model turns
- Decide which nodes are durable-compatible in the first implementation and
  which are ephemeral-only.
- Define how `Source.llm()` disables internal tool loops when graph `tools()`
  owns tool execution.
- Unify `DurableTool` and `Tool` into one public tool type with durable
  activity metadata.
- Current implementation note: `structured` and `parallel` graph nodes now
  execute through `GraphExecutor` without routing through the template adapter
  entrypoint. They share source execution and aggregation helpers with the
  legacy templates to keep observable message semantics aligned. `codexTurn`
  and `claudeTurn` graph nodes also bypass the generic template adapter
  entrypoint by calling shared turn execution helpers from `GraphExecutor`.

### Phase 3: Make GraphExecutor the only durable runtime (checkpoint)

Per the Decision Update, this phase **removes** the legacy replay runtime rather
than porting its journal. The graph runtime is already checkpoint-based; the work
is to delete the parallel replay system and the machinery that only served it.

- Delete the legacy `DurableAgent` replay path, its effect journal for model
  calls, event-replay log, and `NondeterminismError` detection.
- Delete the middleware/hook compound replay-identity validation; keep stable
  ids only for the structural version gate and idempotency-memo keys.
- Keep and consolidate the checkpoint substrate: session checkpoint per node
  boundary, inbox cursor, suspended node path, and the idempotency-keyed effect
  memo for `external-write` activities.
- Collapse the `DurableAgent` / `GraphAgent` dual system into one graph runtime.
- Execute both ephemeral and durable runs through `GraphExecutor`.
- Scope: graph-authored direct and app runs already execute through
  `GraphExecutor` in both ephemeral and durable modes, with store-backed session
  checkpoint persistence, inbox resume, observer event persistence, assistant
  delivery materialization, and graph manifest validation. Unified tools expose
  `activity`, graph tool calls pass `ctx.activity`, and graph-authored durable
  runs persist nested `ctx.durable.memo/activity` boundaries through the graph
  tool composite step. The remaining work is to **delete** the legacy replay
  runtime, not to port its journal.
- Preserve (checkpoint) durable concepts:
  - run store
  - session checkpoint per node boundary
  - inbox cursor + suspended node path
  - idempotency-keyed effect memo (external writes only)
  - suspend/resume (skip-prefix)
  - model/tool progress events (live only)
  - session patch events
  - final delivery outbox
- Remove (replay-only) concepts: model-effect journal sequence, event replay,
  nondeterminism errors.

### Phase 4: Rebuild Agent DSL on Graph IR

- Implement `system/user/assistant/messages/patch` graph nodes.
- Implement `turn` nodes with `inbox/repeat/assistant/tools/awaitInput`.
- Implement `goal` nodes by compiling to a stable subgraph.
- Implement `loop/conditional/subroutine` as graph control nodes.
- Current implementation note: non-durable top-level legacy `Agent.quick()`
  execution now enters `GraphExecutor` through a legacy `template` node that
  preserves existing template lifecycle semantics. Nested legacy Agent
  templates that receive a parent runtime also enter `GraphExecutor` through
  the same compatibility node while preserving parent event sequencing.
  Under the checkpoint decision, the legacy durable template path is **deleted**
  (Phase 3), not kept until ported. Compatibility template nodes are decomposed
  into native graph nodes.
- Remove template-only execution paths.

### Phase 5: Rebuild App API

- Make `PromptTrail.app(...)` the primary runtime constructor.
- Add fluent `.agent(...)`, `.source(...)`, `.delivery(...)`, `.activity(...)`,
  and `.on(eventSource, builder)` methods. The binding method is `on`, not
  `bind` (decided), to keep app event sources verbally distinct from
  `Source.llm()`.
- Remove ordinary need for `PromptTrail.runtimeBundle(...)` while keeping
  `RuntimeBundle` as the app's structural runtime IR.
- Allow `.to(agentOrName)`.
- Convert current runtime server adapter pipeline into app internals while
  preserving the internal runtime/server separation.

### Phase 6: Documentation and Examples

- Rewrite README around the final API.
- Move old API references to migration notes only if useful.
- Update examples to id-optional authoring; add explicit ids only at
  suspend/resume coordinates and loops.
- Keep provider capability docs but align examples with `AgentGraph`.

## Non-Goals

- Preserving current `Agent.create().user('text')` as the main API.
- Preserving `Scenario.system(...).step(...)`.
- Preserving public `DurableAgent`.
- Preserving the legacy replay runtime, its model/effect journal, event replay,
  or `NondeterminismError` detection (superseded by checkpoint durability).
- Imposing any determinism obligation on author code (models, middleware, hooks,
  tool reads may vary between runs).
- Exposing general user-authored outbox sends before final assistant delivery
  outbox is stable.

## Resolved Decisions (2026-06)

> Note: Decision Update 2 (2026-06-10) revises several entries below — the run
> mode is renamed `checkpoint`; the effect declaration is the binary
> key-vs-repeatable (no kind taxonomy); the version hash includes serializable
> content (edits invalidate resume, superseding "structural-only"); the memo
> primitive is `ctx.once` (run/conversation scopes). Where this list conflicts
> with a Decision Update, the highest-numbered Decision Update wins.

- Durability is **checkpoint**, not replay. Legacy replay machinery is removed.
- One authoring form; node ids are optional/auto-derived; `Agent.quick()` is
  removed.
- The idempotency key is the only load-bearing effect requirement (writes the
  author wants crash-safe). A read/write taxonomy is not mandatory. If
  `external-write` is declared, the type requires the key.
- Two gears tied to the run mode (decided): **ephemeral = loose** (no
  declaration, Temporal-style honor system); **durable = strict** automatically
  (no separate flag) — each tool declares one of *safe to re-run* or *here is my
  key* as a registration-time hard error. No strict opt-out in v1, so "durable"
  always means a real durable engine.
- Framework-provided tools/hooks/middleware ship pre-classified; the strict gate
  fires only on author-written code.
- Edit tolerance is a non-goal: editing a durable agent with in-flight runs is a
  version change and resume fails fast (the Temporal posture). Auto-derived ids
  are therefore fine; the structural-only version hash is a nicety, not a
  guarantee.
- Decision/transform handlers (`conditional`/`loop` conditions,
  `goal.isSatisfied`, `patch`) are synchronous by type so effects stay inside
  the keyed boundary; no global IO sandbox.
- Event sources are generic `Source<TEvent>`; the closed binding-event union is
  removed; the node-content vs event-source name collision is resolved.
- `durable` implies strict automatically (ephemeral = loose). No separate
  `strict` flag, and **no strict opt-out in the first version** — durable is
  always strict so it always means a real durable engine. An escape hatch is
  added only if a concrete need appears.
- App `defaults` (durable, delivery, ...) are **constructor-only**
  (`PromptTrail.app({ defaults })`); there is no mutable `.defaults(...)` setter.
  Resolution order is binding override > app defaults > built-in defaults, so
  per-binding needs are met by a binding-level override rather than mutating app
  state. This keeps configuration declarative and order-independent.
- Binding-level middleware/hooks are **deferred** past the first version; v1
  ships agent + app layers only. The handler ordering model already reserves the
  binding slot, so adding it later is low-cost.
- App event wiring is `app.on(eventSource, builder)` (not `.bind`); the binding
  delivery setter is `.reply(...)`.
- The goal node keeps the name `goal`.
- Provider turn nodes are renamed `codexTurn` → **`.codex(...)`** (delegates to
  the Codex app-server) and `claudeTurn` → **`.claude(...)`** (delegates to the
  Claude Agent SDK). This removes the "turn" collision and pairs cleanly with the
  raw-model side: `Source.llm().openai()` / `.anthropic()` call the model and the
  graph owns the loop; `.codex()` / `.claude()` hand the whole turn to the
  vendor's agent runtime, which owns the loop/session.

## Open Decisions

All major API decisions are now resolved (see above). Remaining items are
deferred refinements, not blockers:

- When to add explicit migration (the analog of Temporal `patched()` / Build-ID
  pinning) for graph-version mismatch. Decided for now: fail fast; migration is a
  later addition, not first-implementation scope.
- Whether binding-level middleware/hooks (deferred from v1) graduate in a later
  release, and the exact escape-hatch shape if a strict opt-out is ever needed.
