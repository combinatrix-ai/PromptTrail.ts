# Replay-Diff Gated Self-Deploy

## Purpose

This document designs the machinery that lets claw validate a new version of
**itself** before promoting it: replay the real past requests held in the
durable store through the new build, diff its behavior against what actually
happened, confirm every difference is intended, confirm new fake requests
exercise the new behavior, and only then hand the single-writer lease from the
old process to the new one. It is the concrete mechanism behind the
"verified self-improvement" and blue/green discussion in
`claw-self-authoring.md` §9–§10.

Scope of this doc, the five pieces and how they connect:

1. **Recording extraction** — `StoredRun → Cassette + GoldenOutcome` (pure).
2. **Replay executor** — re-run an agent over a past run's inbox with externals
   served from the cassette, side effects sealed, emitting a `ReplayTrace`.
3. **Differ + scope** — classify each candidate-vs-golden difference as
   `same | intended | regression` against a declared change scope.
4. **Acceptance suite** — forward "fake request" tests for the *new* behavior.
5. **Lease handoff + immutable launcher** — orchestrate blue/green, take the
   verdict, and perform the cutover (single-writer lease, `runtime-bindings`
   §2 / roadmap durability §2), with drain, a health window, and auto-rollback.

`[x]` = decided, `[ ]` = open (collected in §9). It complements
`claw-self-authoring.md` (consumer), `positioning-and-claw-roadmap.md`
(durability §2 = the lease), and `agent-runtime-unification.md` (execution
engine the replay executor reuses).

Module ownership up front, because it drives every boundary below:

- **`@prompttrail/core`** owns the *general* capabilities: recording
  extraction, the replay executor, and the differ. These are useful far beyond
  deploy (regression tests, deterministic repro, debugging, eval).
- **claw** owns the *policy*: the change-scope declaration per deploy and the
  acceptance corpus.
- **the launcher** (a tiny separate, never-self-modified binary) owns the
  *irreversible* parts: lease handoff and rollback. Trust root.

---

## Review revisions (verified against code)

A code-grounded review (Codex, independently re-verified against the cited
files) found the first draft over-credited existing primitives. Corrections,
each confirmed in code — these supersede the optimistic claims in §1–§5 below:

- **The store records outputs, not requests or paths.** `StoredRun`
  (`durable.ts:128-142`) has agent/initial/result/once/outbox/inbox/
  providerSessions/cursor/context — **no executed node path and no model/tool/
  provider request envelopes.** So §1's "pure transform / reconstruct the
  request key from the message prefix" is **not** sound (prompt assembly
  depends on current code, capabilities, and tool defs; the manifest can't even
  detect closure-body edits, `graph.ts:190-194`). → A new **execution-time
  recording layer (B0)** must persist normalized `{nodePath, phase,
  normalizedRequest, normalizedResponse, toolDefsDigest, provider, callIndex}`
  records and node-enter breadcrumbs. Cassette keys hash the *persisted*
  request, never a recomputed one.
- **`Source.llm().mock()` is not a keyed replay seam.** It is sequential
  (cyclic index) or a `(session, options)` callback only (`source.ts:1304-1393`)
  — no request-key lookup, no miss classification. → B1 is a new **replay
  middleware**, not built on `.mock()`.
- **Tool/provider interception is fragmented, not "one new injection point."**
  Graph and native loops use `wrapToolCall` (`graph_executor.ts:1161`,
  `generate.ts:624`), but ai-sdk `generateText` tools run inside ai-sdk with no
  wrapper (`generate.ts:273`), and Codex/Claude/OpenAI/Gemini each have separate
  tool paths. → Replay must intercept at one unified boundary
  (`executePromptTrailTool`/capability) before B1.
- **No lease exists, and handoff needs fencing.** `DurableRunStore` has no
  lease (`durable.ts:213-250`); the only lock is in-process per conversation
  (`runtime_server.ts:138`). Checkpoint advances `graphCursor` optimistically
  (`checkpoint_continuation.ts:76`) and persists with no holder check, so a
  paused blue can double-write after handoff. → Every mutating store method and
  every delivery must require a **monotonic fencing token**, not just a lease.
- **Green can't resume blue's in-flight runs across a graph change.** Resume
  throws `AgentGraphVersionError` on manifest-hash mismatch (`durable.ts:1176`).
  → In-flight policy: blue keeps old-manifest runs until they finish (green
  takes only new + compatible runs), or add graph migration.
- **Trust-boundary contradiction in §5.** The pseudocode ran
  `green.replayDiffOverCorpus(...)` / `green.runAcceptance(...)` — green grading
  itself contradicts §6. Corrected below: the **trusted runner executes**
  replay, diff, scope, and acceptance against green as a *target* process.

**Revised build order:** **B0 (execution-time recording of normalized calls +
node breadcrumbs)** → B1 (positional replay on B0) → B2 (keyed replay + differ)
→ B3 (acceptance, trusted-runner-executed) → B4 (lease + fencing tokens) → B5
(launcher). Also unresolved before production: store-schema migration across
blue/green versions; replay clock/RNG injection (`Math.random`/`Date.now` used
directly today, `source.ts:452,967`); live-LLM diff pass bar (forbid live text
from gating in B1/B2); corpus privacy/redaction.

---

## 0. End-to-end shape

```
durable store ─(extract)─► Recording { Cassette, GoldenOutcome } per past run
                                   │
   past run.inbox ──► replayRun(green, cassette) ──► ReplayTrace(green)
                                   │
   GoldenOutcome(blue) ──► diffReplay ──► { same | intended ⊆ scope | REGRESSION }
                                   │
   fake requests ──► acceptanceRun(green) ──► pass / fail
                                   ▼
        verdict = (no REGRESSION over corpus) ∧ (acceptance pass)
                                   │
   launcher.probe(green)  (independent, trusted-root)  ──► ∧
                                   ▼
        store.lease.handoff(blue → green) ──► drain blue ──► health window
                                   │
                degraded? ──► lease.handoff(green → blue)  (auto-rollback)
```

The durable store is the asset that makes all of it possible: it is at once the
**request corpus**, the **golden answers**, and the **mock source** for the LLM
and tools.

---

## 1. Recording extraction (`StoredRun → Cassette + GoldenOutcome`)

`[!]` **Revised (see "Review revisions"):** a `StoredRun` carries enough for a
*weak golden transcript* (`inbox` requests, `result` message timeline with
`tool_use`/`tool_result` parts, `outbox` deliveries, `context`) — but **not**
the executed node path nor the normalized model/provider *requests*. The
cassette therefore cannot be a pure transform of today's `StoredRun`; it
consumes the **B0 recording layer** (normalized call records + node
breadcrumbs persisted at execution time). The keying below hashes the persisted
request, not a recomputed prefix.

Two products:

**Cassette** — the keyed record of every external interaction, used to make
replay deterministic:

```ts
interface Cassette {
  llm: Array<{ key: RequestKey; index: number; output: ModelOutput }>;
  tools: Array<{ key: ToolKey; index: number; result: CallToolResult }>;
  provider: Array<{ key: RequestKey; index: number; result: ProviderTurnResult }>;
}
```

`[x]` **Keys are reconstructed, not stored.** The store keeps *outputs*, not the
exact request that produced them — but each assistant output sits after a known
message prefix, and the Source's prompt assembly is deterministic, so the
request is recomputable. `buildCassette` walks blue's own timeline: for each
assistant step, `RequestKey = hash(prompt the Source would assemble from the
prefix + model + tool defs)`, value = the recorded output. For each `tool_use`,
`ToolKey = hash(toolName, args)`, value = the matching `tool_result`. The
`index` preserves call order for positional keying.

**GoldenOutcome** — the comparable summary of what blue *did* (this is the
golden side of the diff; it is a `ReplayTrace`-shaped projection of the
recording, so golden and candidate are the same type):

```ts
interface GoldenOutcome {
  nodes: string[];                 // executed node path (from the recorded run)
  llmCalls: { key; output }[];
  toolCalls: { name; args; result }[];
  structured: unknown[];           // structured outputs the run produced
  finalReply: Message[];           // the delivered assistant message(s)
  deliveries: AssistantDeliveryOutboxEntry[];  // from outbox
}
```

`[ ]` **Open: node-path fidelity in the recording.** The executed node path is
not stored verbatim today; it may need a lightweight per-run execution-path
breadcrumb persisted at checkpoint time (a list of node ids), or it is
reconstructed by replaying blue against its own cassette (all hits → exact path)
in §2. Reconstruct-by-replay is the cheaper first cut.

---

## 2. Replay executor (`replayRun`)

`[x]` Re-run the target agent over a past run's inbox **through the real
execution engine**, substituting externals from the cassette and sealing side
effects. Reusing the production engine (not a parallel interpreter) is the whole
point: you are testing the actual code path, with only the leaves stubbed.

```ts
interface ReplayOptions {
  agent?: Agent;                                       // target; default run.agent
  cassette: Cassette;
  llm?: 'cassette' | 'live';
  tools?: 'cassette' | 'live';
  keying?: ('request-hash' | 'node-path' | 'positional')[];  // tried in order
  miss?: 'flag' | 'live' | 'error';
  clock?: number;                                      // pinned; random pinned too
}
interface ReplayTrace {
  nodes: string[];
  llmCalls: { key; hit: boolean; output: ModelOutput }[];
  toolCalls: { name; args; hit: boolean; result: CallToolResult }[];
  structured: unknown[];
  finalReply: Message[];
  wouldDeliver: AssistantDeliveryOutboxInput[];        // captured, never sent
  misses: { at: string; kind: 'llm' | 'tool' | 'provider' }[];
}
async function replayRun(run: StoredRun, opts: ReplayOptions): Promise<{
  trace: ReplayTrace; session: Session;
}>;
```

`[x]` **Interception via the existing middleware / execution-phase wrapper.**
The engine already wraps model/tool/provider calls (`prepareModelInput`,
`beforeModel`, the runtime middleware wrapper that `CodexTurn`/`ClaudeTurn`
route through). A `ReplayMiddleware` hooks those phases: when the target reaches
an LLM/tool/provider call, it assembles the request, computes the key under the
configured keying strategy, and serves the cassette entry — recording hit/miss
into the trace. `Source.llm().mock()` is the existing seam for the LLM leaf;
tool interception is the one genuinely new injection point (a replay-mode
capability that resolves tool calls from the cassette instead of executing).

`[x]` **Keying + miss is the heart (carried over from the prior design).**
`request-hash` → a hit means behavior was preserved at that step; a **miss is
the highest-signal diff — the exact point the target diverged from blue.**
`node-path` lets a changed *prompt* on the same logical node still draw a
recorded response and continue. `positional` is the v1 fallback (no divergence
assumed). Miss policy: `flag` (regression mode — record the divergence and keep
the recorded value or a sentinel to continue), `live` (fall through to the real
provider — for prompt/generation changes judged downstream), `error` (strict
reproduction — debugging/determinism checks).

`[x]` **Containment (dry-run).** A throwaway in-memory store; the real store is
read-only (corpus source); capabilities deny external writes; tools never
execute (served from cassette); deliveries are captured into `wouldDeliver`, not
sent; `clock`/random are pinned so non-LLM nondeterminism cannot manufacture
false diffs (the engine already blocks `Date.now`/`Math.random` in replay-shaped
contexts — extend that).

`[x]` **Cross-cutting use.** With `agent = run.agent`, `miss: 'error'` it is a
*determinism / regression-of-self* check and a "re-run this exact conversation"
debugger. With `agent = green` it is the deploy diff. Same primitive.

---

## 3. Differ + scope

`[x]` `diffReplay(golden: GoldenOutcome, candidate: ReplayTrace, scope:
ChangeScope) → DiffReport`. It compares across explicit **dimensions**, so a
difference is attributed to a *kind*, not a blob:

- **routing** — did it dispatch to the same skill / take the same conditional
  branch? (from `nodes`)
- **control-flow** — same executed node path (order + set).
- **tool-args** — same tool calls with the same arguments (the
  highest-value-to-protect signal; arg drift = silent behavior change).
- **structured** — structured outputs equal.
- **text** — final reply. Under cassette LLM this is exact; under live LLM this
  is semantic (LLM-judge) or skipped.

`[x]` **Classification against a declared scope.** Every deploy carries a
`ChangeScope` — a predicate describing the *intended* blast radius
(e.g. "only runs whose routing touches `refund-triage`; only the text dimension
of the `support` channel"). For each diffed run:

```
no difference                         → same
difference ⊆ scope                    → intended
difference ⊄ scope (or unexplained)   → REGRESSION   ← blocks release
```

So "what should stay the same stayed the same, and only what was meant to change
changed" becomes a machine-checkable assertion. Optionally, `intended` diffs are
further asserted against a *forward* expectation (the new behavior the scope
promised), turning intent from "permitted" into "confirmed".

`[x]` **Differ and executor are separate** (the executor only emits comparable
traces). The differ and the `ChangeScope` schema live in core; the *value* of
the scope for a given deploy is authored by claw/the supervisor.

`[ ]` **Open: scope expressiveness.** How rich `ChangeScope` may be (a set of
node ids + dimensions, vs an arbitrary predicate over `(run, diff)`). An
arbitrary predicate is itself code the gate must trust — so it is trusted-root
authored or itself gated.

---

## 4. Acceptance suite (fake requests, forward)

`[x]` Past requests cannot exercise behavior that postdates them, so the new
capability is validated by **synthetic forward tests**: a corpus of
golden-transcript fake requests, each asserting the *new* intended behavior
(routes to the new skill, calls the right tool with the right args, replies
within budget, terminates).

`[x]` **Trusted-root owned.** The acceptance corpus and the assertion harness
are owned by the immutable side, not by the mutable build under test — otherwise
a broken green could ship with a weakened self-check (the gate-weakening
failure). Green *runs* the corpus against itself; it cannot edit it.

`[x]` Runs on the same `replayRun` containment (dry-run, sealed side effects):
acceptance is just `replayRun` with a *synthetic* run (a constructed inbox) and
`miss: 'live'` if the new behavior is genuinely new LLM output, plus assertions
on the resulting `ReplayTrace` (routing/tool/structured dimensions, which are
deterministic even when text is live).

---

## 5. Lease handoff + immutable launcher

`[x]` **The cutover is a single-writer lease handoff, not LB traffic.** claw is
a stateful event consumer; two live processes double-respond and double-commit.
The store gains a lease (holder id + expiry, heartbeat-renewed — roadmap
durability §2 / `runtime-bindings` §2). Only the lease holder responds.

```ts
interface RunStoreLease {
  acquire(holder: string, ttlMs: number): Promise<boolean>;
  renew(holder: string): Promise<void>;        // heartbeat
  handoff(opts: { from: string; to: string }): Promise<void>;  // atomic
  current(): Promise<string | undefined>;
}
```

`[x]` **The launcher is the trust root and the decision-maker.** A tiny,
never-self-modified parent process. Green proposes *evidence* (the verdict);
the launcher *decides and executes*. It never lets green self-promote.

```ts
// immutable launcher — claw cannot modify this
async function deploy(newTag) {
  const green = launch(newTag, { mode: 'canary' });   // silent: no lease, sealed effects
  await green.ready();

  // the TRUSTED RUNNER (not green) executes replay/diff/acceptance against
  // green as a target process — green cannot grade itself (see Review revisions)
  const replay = await runner.replayDiffOverCorpus(green, change.scope); // §1–§3
  const accept = await runner.runAcceptance(green, fakeRequests);        // §4
  const probe  = await launcher.probe(green, knownProbes);              // independent check

  const ok = replay.every(r => r.kind !== 'REGRESSION') && accept.ok && probe.ok;
  if (!ok) { green.kill(); return report(replay, accept); }      // blue keeps serving

  await blue.stopAcceptingNewEvents();                 // drain; in-flight is checkpointed
  await store.lease.handoff({ from: blue, to: green }); // atomic cutover
  // green now holds the lease; unfinished runs resume from the store

  if (!await healthyFor(green, window))                // post-cutover health window
       { await store.lease.handoff({ from: green, to: blue }); green.kill(); } // rollback
  else { blue.drainAndExit(); current = green; }
}
```

`[x]` **Durability is what makes drain lossless.** In-flight runs at cutover are
checkpointed in the store; green resumes them after taking the lease — zero
dropped conversations. This is precisely the §1/§1.6b durability built earlier.

`[x]` **Blue stays warm through the health window** so rollback is another
instant lease handoff, not a cold restart.

---

## 6. Trust boundaries (the non-negotiables)

`[x]` Green **cannot weaken its own verification.** The following live in the
trusted root (launcher / immutable package / separate credentials), outside what
a self-authored or self-modified claw can edit:

- the differ and the `ChangeScope` *schema* (claw authors a scope *value*; it
  cannot change what "regression" means),
- the acceptance corpus and harness,
- the corpus sampling policy (no silent truncation — logged),
- the lease and its handoff,
- the launcher, its independent probe, and the rollback logic.

`[x]` The launcher's probe is **independent** of green's self-report — green
provides evidence, the launcher re-verifies with its own probes before the
handoff. "Green proposes, launcher disposes."

---

## 7. Module & process boundaries

```
@prompttrail/core
  replay.ts   buildCassette(run) ; replayRun(run, opts) ; Cassette/ReplayTrace
  diff.ts     diffReplay(golden, candidate, scope) ; ChangeScope schema ; DiffReport
  durable     RunStoreLease added to DurableRunStore (acquire/renew/handoff/current)
              + the tool-result mock injection point used by replay

claw
  change-scope declaration per deploy ; acceptance corpus (golden transcripts) ;
  the supervisor command that runs replay-diff + acceptance and emits a verdict

@prompttrail/launcher   (new, tiny, immutable — trust root)
  blue/green orchestration ; independent probe ; lease handoff ; health window ;
  auto-rollback ; last-known-good tag
```

`[x]` core stays provider-agnostic and dependency-light; the launcher is the
only never-self-modified executable.

---

## 8. Build sequencing

`[ ]` **B1 — Recording extraction + replay executor v1 (core).**
`buildCassette` and `replayRun` with **positional** keying, `agent = run.agent`,
`miss: 'error'`, full containment, `ReplayTrace`. Acceptance test: every stored
run replays to an identical trace against its own cassette. Ships value alone
(deterministic repro + debugging) and is the substrate for everything else.

`[ ]` **B2 — Keying + differ (core).** Add `request-hash` / `node-path` keying
and `miss: 'flag'`; add `diffReplay` + `ChangeScope`. Now green-vs-blue
divergence is detectable and classifiable.

`[ ]` **B3 — Acceptance suite.** The forward fake-request corpus + harness,
trusted-root owned, on the `replayRun` containment.

`[ ]` **B4 — Lease (core/durable).** `RunStoreLease` on the store family; only
the lease holder responds; heartbeat + handoff. This is roadmap durability §2
and unblocks at-least-once + orphan-resume too.

`[ ]` **B5 — Launcher.** The immutable parent: canary launch, independent probe,
verdict consumption, lease handoff, health window, auto-rollback.

Rationale: B1 is independently useful and de-risks the engine interception; B4
(the lease) is the long pole shared with the broader durability roadmap;
the launcher (B5) is last because it composes the others.

---

## 9. Open questions

- **Node-path in the recording** — persist an execution-path breadcrumb at
  checkpoint vs reconstruct-by-replaying-against-own-cassette (§1).
- **Scope expressiveness** — node-id+dimension set vs arbitrary trusted-root
  predicate (§3).
- **Live-LLM diffing** — when a change is to generation/prompt, the text
  dimension needs semantic comparison (LLM-judge) or human spot-check; what the
  pass bar is (§2/§3).
- **Corpus sampling** — targeted (touching the change) + random %, with the
  sampled set logged; how large, how to weight (§0/§6).
- **Tool-mock injection API** — the one new interception seam in core; its shape
  (a replay capability vs a Source-like tool wrapper) (§2).
- **Lease semantics** — TTL, heartbeat interval, fencing token to defeat a
  paused blue resuming and double-writing (§5; ties to roadmap §2).
- **Privacy** — replaying real user requests through a new build is dry-run and
  sealed, but the corpus still contains user content; retention/access of the
  recording used for replay.

---

## 10. Decisions summary

- `[x]` The durable store is corpus + golden + LLM/tool mock source; recording
  extraction is a pure `StoredRun → Cassette + GoldenOutcome` transform.
- `[x]` Replay re-runs the target through the **real** engine with externals
  served from the cassette and side effects sealed; keying + miss policy make
  divergence the signal.
- `[x]` The differ classifies each difference `same | intended | regression`
  against a declared `ChangeScope`; executor and differ are separate; both in
  core.
- `[x]` Acceptance (fake-request) suite validates the new behavior forward and
  is trusted-root owned.
- `[x]` Cutover is a single-writer lease handoff; the immutable launcher
  decides and executes; green only provides evidence; blue stays warm for
  instant rollback; durability makes drain lossless.
- `[x]` core owns replay/diff/lease; claw owns scope+acceptance values; the
  launcher is the immutable trust root.
- `[x]` Build order **B0 (recording layer)** → B1 (replay v1) → B2
  (keying+differ) → B3 (acceptance) → B4 (lease+fencing) → B5 (launcher). B0
  detailed in the appendix.

---

## Appendix B0 — Recording layer (detailed design)

The review established that replay cannot read what it needs from today's
`StoredRun`. B0 adds a minimal, opt-in recording layer at the boundaries that
**already funnel every call**, plus node breadcrumbs. It reuses the existing
wrapper machinery — no parallel interpreter.

### The unified boundaries (confirmed in code)

Codex flagged tool interception as "fragmented." Reading the code, the
*middleware wrapping* is fragmented but the **execution funnels are single**:

- **Tool calls → `executePromptTrailTool` (`tool.ts:87`).** Every path calls it:
  graph tools (`graph_executor.ts:1204`), native loops (`generate.ts:775`),
  ai-sdk tools (`ai_sdk_tools.ts:56`), and Codex/Claude/OpenAI/Gemini provider
  tools (`codex_app_server.ts:1037`, `claude_agent.ts:182`,
  `openai_responses.ts:741`, `google_gemini.ts:1015`). The context here already
  carries `durable`/`effect`/`idempotencyKey`. → record + replay hook this one
  function; each of the call sites threads a `recorder` handle + `nodePath` into
  the context (uniform, mechanical — the *logic* stays in one place).
- **Model/provider calls → the `wrapModelCall` phase.** Assistant
  (`model_runtime.ts:62-78`), Codex (`codex_turn.ts:380`), and Claude
  (`claude_turn.ts:328`) all route the provider invocation through
  `runRuntimeMiddlewareWrapper({ phase: 'wrapModelCall', call })`, so one
  built-in **recording middleware** there captures the **response** for all
  three uniformly. **Caveat (verified):** `ModelRuntimeRequest` is `{ session }`
  only (`model_runtime.ts:12-14`); the system prompt, tool definitions, and
  model params live inside the per-node `call` closure, **not** in the request
  the middleware sees. So a wrapModelCall middleware cannot digest the *full*
  provider request from the session alone — request-hash keying would be unsound
  if it hashed only the session. → Either thread the resolved `LLMOptions`
  (system + `toolDefsDigest` + params) into `ModelRuntimeRequest` so the single
  middleware can hash the full request, or capture inside each `call` closure
  (3 sites, each with the full payload). Threading into the request keeps the
  one-middleware design; pick that unless it proves leaky.
- **Node path → graph executor.** `executeGraphNode(node, nodePath, state)`
  (`graph_executor.ts:390`) has the path in hand but emits only run/model/tool
  events. → add a **node-enter breadcrumb** (path + node type + chosen branch).

### Record schema (persisted, durable)

```ts
interface NodeBreadcrumb  { seq; nodePath; nodeType; branch?; at }
interface ModelCallRecord {
  nodePath; callIndex; provider;        // 'assistant' | 'codex' | 'claude' | ...
  requestDigest;                        // hash of the normalized request AT RECORD TIME
  request?: NormalizedModelRequest;     // messages + system + toolDefsDigest + params (full only)
  response: ModelOutput; at;
}
interface ToolCallRecord  {
  nodePath; callIndex; toolName; argsDigest;
  input?: unknown;                      // parsed input (full only)
  result: CallToolResult; effect?; at;
}
```

`[x]` **Keys are computed at record time from the real request** — not
recomputed from a message prefix (the review's blocker). Replay digests the
candidate's live request the same way: `request-hash` = `requestDigest` match;
`node-path` = `(nodePath, callIndex)` match. Both keyings come from the record,
so divergence is well-defined.

### Storage

`StoredRun` gains `recording?: { nodes; model; tool }`; `DurableRunStore` gains
`appendRecord(runId, record)` (async; fenced under B4). `store-common`'s
reconstruction and the conformance suite extend by one collection + one case
(so all five backends inherit it). Provider-turn raw replay (Codex/Claude)
needs `retain: 'full'` (`codex_turn.ts:443`) — opt-in, since summarized
retention drops the raw result.

### Recording control (volume + privacy)

`[x]` `RecordLevel = 'off' | 'decisions' | 'full'`, per agent/run, default
`off`:

- `decisions` — node breadcrumbs + tool calls (name/argsDigest/result) +
  structured outputs + model `requestDigest`/response. Cheap; powers the
  deterministic diff dimensions (routing / control-flow / tool-args /
  structured).
- `full` — adds normalized model request bytes + parsed tool input, needed for
  `request-hash` keying and faithful replay. Larger and sensitive — this is the
  privacy surface, so it is retention-bounded + redaction-policied.

claw records `full` for a sampled fraction of runs plus always for the routes a
pending deploy will replay.

### Determinism injection

`Math.random` / `Date.now` are used directly today (`source.ts:452,967`;
`graph_executor.ts:350`). B0 adds a `RuntimeClock` / `RuntimeRng` the recorder
captures and the replayer pins, and bans direct use on replay-critical paths.

### What B0 unblocks

The §1 cassette becomes a real transform of the **recording** (not the message
prefix); §2 keying is sound (it hashes the persisted request); §3
routing/control-flow diffs have a golden node path; B1 positional replay is
"feed the records in order to the same agent and assert an identical trace."

### B0 work items

1. `recorder` handle + `nodePath` on `ToolExecutionContext`; record/replay
   branch inside `executePromptTrailTool`.
2. built-in recording middleware on `wrapModelCall` (covers assistant/codex/
   claude).
3. node-enter breadcrumb in `executeGraphNode`.
4. `StoredRun.recording` + `appendRecord` across the store family +
   store-common reconstruction + conformance case.
5. `RecordLevel` plumbing + `RuntimeClock`/`RuntimeRng`.

### B0 — round-2 code verification (findings)

A second pass read the provider/tool paths directly. Results, each grounded:

- **Tool funnel is split by tool kind.** `executePromptTrailTool` covers
  PromptTrail tools and ai-sdk-wrapped tools (the ai-sdk wrapper's `execute`
  calls it, `ai_sdk_tools.ts:55-60`). But `kind: 'builtin'` and `kind: 'mcp'`
  tools carry `executionMode: Exclude<ExecutionMode, 'prompttrail'>`
  (`capabilities.ts:105-108`) — they execute **provider-/MCP-side, outside**
  `executePromptTrailTool`. → Record/replay PromptTrail+ai-sdk tools at the
  funnel; builtin/MCP tool calls and results ride the **model/provider
  response** and are captured by the `wrapModelCall` response side, with the
  differ extracting their args from the response, not from tool records.
- **Internal loops do many model turns inside one `wrapModelCall`.** The native
  streaming tool loop iterates `maxToolRounds`, calling the provider each round
  inside a single outer model call (`generate.ts:600-656`); Codex/Claude turns
  loop internally too. So a `wrapModelCall` recorder captures the node's
  **aggregate output**, not each internal turn (tools inside are still recorded
  individually via `wrapToolCall`→`executePromptTrailTool`, `generate.ts:715-733`).
  → **Decision:** B1 replays at **node-output granularity** — the cassette entry
  for a model node is the full message delta it produced, and replay
  short-circuits the whole node/loop with that recorded output. Per-internal-turn
  replay (to localize divergence *inside* a loop) is a later refinement needing
  stream-level interception.
- **Node breadcrumbs are sufficient for control-flow.** `executeGraphNode`
  dispatches scope/loop/conditional/parallel/structured/tools/transform/
  codexTurn/claudeTurn, each with `nodePath` (`graph_executor.ts:392-454`). A
  breadcrumb of `{seq, nodePath, nodeType, branch}` reconstructs: conditional
  branch (which child entered), loop iterations (repeated body entries by seq),
  scope/subroutine entry, and parallel (entered set; order is nondeterministic →
  compare as a set).
- **Byte/file content breaks faithful replay.** `makeContentPartsPersistenceSafe`
  rewrites `bytes` parts to `prompttrail://omitted-bytes/...`
  (`content_parts.ts:131-146`) and `providerFile` references expire
  (`content_parts.ts:60-86`). A persisted run with image/file input cannot be
  re-digested or re-sent faithfully (two different images both hash as
  "omitted"). → Record a stable `bytesDigest` at record time for keying, and for
  v1 **exclude/flag byte-or-file-content runs** from the replay corpus.
- **Records are a separate collection, not a session delta.** Like `outbox` and
  `once`, recording is append-only run-scoped state, not session content — a
  `StoredRun.recording` collection with `appendRecord`, fenced under B4, rather
  than folding into `appendSessionDelta`.

**Verdict:** B0 is implementable. The two scoping calls baked into B1 are
node-output-granularity replay (not per-internal-turn) and excluding
byte/file-content runs from the corpus; the model-request capture must thread
resolved `LLMOptions` into `ModelRuntimeRequest`; builtin/MCP tools are captured
via the model response. (Model-request capture and the keying model are
corrected by the round-3 cross-check below.)

### B0 — round-3 cross-check (independent Opus review, verified)

A second independent reviewer (Opus) re-verified round-2 against the same code.
The fundamentals held; it **corrected several points**, each re-confirmed here:

- **Model-request capture is three normalizers, not one.** Codex/Claude use a
  separate `TurnModelRequest` (`codex_turn.ts:468-473`, `claude_turn.ts:396`)
  with no `LLMOptions` — not `ModelRuntimeRequest`. Request-hash keying is
  **per-provider** (assistant via LLMOptions threaded into `ModelRuntimeRequest`;
  Codex/Claude via their own turn request + provider config), not one unified
  hash function.
- **"Model node = one request" is loose even without tools.**
  `LlmSource.getContent` re-calls the model in a validator-retry loop
  (`source.ts:1497-1518`), and Structured runs once per attempt
  (`structured.ts:118-121`) — N model turns inside one `wrapModelCall`. Confirms
  node-output-granularity replay; the recorder must not assume one turn per node.
- **Loop and parallel break the `(nodePath, callIndex)` keying.**
  Loop/goalAttempts re-run `executeChildren` under the **same** `nodePath`
  (`graph_executor.ts:562,692`), so iterations collide — breadcrumbs must be a
  **seq-ordered stream**, not a `nodePath→record` map. `executeParallelNode`
  (`958-990`) calls `executeSource` (not `executeGraphNode`) under one nodePath,
  so it emits **no per-branch breadcrumbs** and runs **deterministically
  sequentially** — parallel branches are reconstructed from model/tool record
  *order*, not a breadcrumb set (and the round-2 "order nondeterministic" was
  wrong).
- **`bytesDigest` at record time is unimplementable.**
  `makeMessagePersistenceSafe` runs in the **`Session` constructor**
  (`session.ts:18,244-251`), so bytes are placeholders on every `addMessage`;
  the recorder sees `request.session`, never the real bytes. → drop record-time
  bytesDigest; v1 relies solely on **excluding byte/file-content runs from the
  corpus** (capture upstream of Session construction only if faithful byte
  replay is later needed).
- **Threading `nodePath`/recorder is not uniformly "mechanical."**
  `ToolExecutionContext` has no `nodePath` (`capabilities.ts:32-42`), and the
  provider tool funnels (`anthropic_messages.ts:985`, `openai_responses.ts:741`,
  `google_gemini.ts:1015`) run as vendor-loop callbacks with no nodePath/`durable`
  in scope — threading there crosses the provider API boundary. The graph
  tools-node path does have it (`graph_executor.ts:1198`); the two regimes differ.
- **Wider determinism inventory:** `crypto.randomUUID`/`Date.now` seed the
  `eventScopeId` (`graph_executor.ts:~354`) that feeds idempotency keys
  (`model_runtime.ts:119`); pin it too if replay compares idempotency keys.
  (Recording does **not** perturb `once` — keys are pure functions of input,
  `tool.ts:144-154`.)
- **Tool-funnel bypass set** is builtin + mcp + `skill` (skills map to
  `runtime`, `capabilities.ts:227-228`), though skills are not tool *calls* so
  the practical bypass remains builtin/MCP.

**Corrected verdict:** B0 is sound *in shape* and implementable, but round-2's
"no remaining blocker" was too strong. Three things to fix before coding:
1. **Per-provider request normalization** (assistant vs Codex vs Claude), not
   one unified request hash.
2. **Seq-ordered breadcrumb keying** with explicit loop (shared nodePath) and
   parallel (no breadcrumbs, sequential, reconstruct from record order)
   handling — not `(nodePath, callIndex)`.
3. **Drop record-time `bytesDigest`**; v1 = corpus exclusion of byte/file runs.
