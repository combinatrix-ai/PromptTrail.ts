# PromptTrail Execution Interception System

This document defines the target design for four related concepts:

- Durable execution
- Hook
- Middleware
- Event / Observer

The design goal is an OpenClaw/Hermes-style runtime where Discord, cron, and
other external sources wake durable conversations, while PromptTrail can still
support LangChain-like middleware, PyTorch-Lightning-like hooks, live runtime
events, Discord progress rendering, and resumable execution.

## Reference Framework Decisions

PromptTrail should borrow the durable boundary ideas, not the full programming
model, from current durable execution frameworks.

Temporal TypeScript separates deterministic workflow code from Activities.
Workflow code uses deterministic timers/random/helpers and schedules Activities
for external work. The workflow package docs explicitly recommend workflow
`sleep()` for timers and `proxyActivities()` for Activities, while queries may
not mutate variables or use Activities/Timers. This maps to PromptTrail as:

- normal `Agent` execution stays lightweight and non-durable by default
- durable execution must expose explicit effect boundaries
- external side effects should be Activities or outbox sends, not hidden inside
  arbitrary hooks

ReState makes the effect boundary more ergonomic with `ctx.run(name, fn)`. Its
context docs say the operation result is stored and not re-run later, while also
calling out the small crash window where an action may re-run if failure happens
between successful execution and persisting the result. It also has reliable RPC
and one-way sends that are journaled and not duplicated when a handler is
re-invoked. PromptTrail should adopt that honesty:

- `durable.activity()` may re-run across the crash-after-effect-before-journal
  window
- activities require idempotency/adoption when they perform external writes
- final assistant delivery should be modeled as a reliable send/outbox, not a
  best-effort observer

Inngest exposes explicit `step.run()` boundaries and ships lint rules that
disallow nested steps and mutating outer variables inside `step.run()`. That is
a useful syntax lesson for PromptTrail:

- durability should be opt-in at clear step boundaries
- nested durable steps inside materialized phases should be rejected
- step closures should return values instead of mutating ambient state

## Vocabulary

PromptTrail should use these words precisely:

| Concept    | Can change `Session`?                         | Can change model/tool request?        | Can do external side effects?            | Durable semantics                     |
| ---------- | --------------------------------------------- | ------------------------------------- | ---------------------------------------- | ------------------------------------- |
| Durable    | yes, by replaying committed state transitions | yes, by replaying committed decisions | only through journaled/outbox boundaries | authoritative execution log           |
| Middleware | yes, by returning patches                     | yes                                   | no by default                            | deterministic, journaled when durable |
| Hook       | yes, by returning patches                     | no                                    | no by default                            | deterministic, journaled when durable |
| Event      | no                                            | no                                    | no                                       | emitted facts                         |
| Observer   | no                                            | no                                    | yes, if idempotent                       | presentation/metrics/logging only     |

Short version:

- Middleware changes _how_ execution happens.
- Hook changes _state at named lifecycle points_.
- Event records _what happened_.
- Observer reacts to events and may perform presentation side effects.
- Durable decides which transformations are replayed and which side effects are
  outboxed or idempotent.

## Opt-in Durability Grammar

Durability is opt-in. Existing `Agent.execute(session)` remains ephemeral and
does not require deterministic code.

PromptTrail should expose three levels of opt-in:

### 1. Conversation / Runtime Durability

Used by Discord, cron, or any runtime binding that wants a resumable
conversation.

```ts
const app = PromptTrail.app({
  durable: {
    store: sqliteRunStore({ path: '.prompttrail/runs.db' }),
    defaultDurable: true,
  },
});

PromptTrail.bundle({
  defaults: {
    durable: true,
  },
  bindings: [
    bind(discord.messages()).conversation(discord.sessionKey()).agent('claw'),
  ],
});
```

This controls whether inbound events resume a durable run. It does not by
itself make arbitrary code safe; effect boundaries still matter.

### 2. Agent / Template Durability

Used when a developer wants one agent execution to be journaled even outside a
server runtime.

```ts
await agent.execute(session, {
  durable: {
    runId: 'discord:guild:G1:thread:T1',
    store,
  },
});
```

or fluently:

```ts
const agent = Agent.create()
  .durable()
  .use(channelPolicy)
  .hook(auditHook)
  .assistant(Source.llm(...));
```

Durability precedence is:

1. binding-level `durable`
2. bundle defaults
3. app-level `defaultDurable`
4. direct execution options
5. agent fluent `.durable()` for direct execution only

Items 1-3 apply to runtime resumption through `PromptTrail.server()` and
`PromptTrail.app()`. Items 4-5 apply to direct `Agent.execute()` calls; they do
not normally co-occur with binding-level routing.

An agent is one unit, so the fluent form is `.durable()` or
`.durable({ store, runId })`, not `.durable({ default: true })`.

### 3. Effect Boundary Durability

Used inside replayable hooks/middleware, tools, and durable handlers. The
default hook/middleware mode is `materialized-phase`; that mode rejects nested
`ctx.durable.*` calls.

```ts
const summary = await ctx.durable.memo('summary-clock', () => ({
  summarizedAt: Date.now(),
}));

const profile = await ctx.durable.activity(
  'load-profile',
  {
    idempotencyKey: `profile:${userId}`,
    kind: 'external-read',
  },
  () => loadUserProfile(userId),
);
```

This is the ReState/Inngest-like step boundary. In durable mode, PromptTrail
must reject nested durable effects inside a materialized hook/middleware phase
unless that handler is explicitly declared `replayable-handler`.

Tool bodies are activity-like by default. A tool can call `ctx.durable.*`
because the whole tool execution is already an effect boundary. Hook and
middleware handlers can call `ctx.durable.*` only in `replayable-handler` mode.

Final assistant delivery is not exposed as `ctx.durable.outbox()` to handlers.
The engine creates final-delivery outbox entries automatically when an assistant
message commits.

## Effect Classification

Durable execution should classify work by replay safety:

| Kind       | Examples                                         | Durable behavior                                                  |
| ---------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| `pure`     | request formatting, deterministic session patch  | may re-run                                                        |
| `memo`     | time, random, local non-deterministic value      | journal value, replay value                                       |
| `activity` | provider/tool/API call with possible side effect | run with operation id, journal result, may re-run in crash window |
| `observer` | typing, progress, metrics                        | not part of session; idempotent or best-effort                    |

The public API should make this explicit:

```ts
ctx.durable.memo(name, fn);
ctx.durable.activity(name, options, fn);
```

`ctx.durable.outbox()` is intentionally not part of the handler-facing API for
final assistant delivery. Runtime outbox is engine-owned.

```ts
interface ActivityOptions {
  kind: 'pure-call' | 'external-read' | 'external-write';
  idempotencyKey?: string;
  retry?: RetryPolicy;
}
```

`external-write` requires `idempotencyKey` at type/lint level. PromptTrail
journals the activity result and retry state, but it cannot prove the external
system deduplicated the write. The idempotency key is the developer's contract
to pass to the platform, use as a deterministic resource id, or use for
adoption/reconciliation.

`activity` is honest about crash mid-step:

- crash before effect: safe to retry
- crash during effect: outcome unknown
- crash after effect before journal: effect may re-run
- crash after journal: replay returns journaled result

Therefore external-write activities need at least one of:

- platform idempotency token
- deterministic resource id
- adoption/reconciliation logic
- acceptable at-least-once semantics

`outbox` is the preferred shape for final delivery because the intent is
committed before dispatch. For now, PromptTrail should expose only the
engine-owned final delivery outbox publicly. General reliable `send` can be
added later with its own status model.

## Core Decision

Hooks may change `Session`, but only through explicit returned patches. They do
not mutate the active `Session` object in place. Hooks are session/control
lifecycle callbacks; middleware owns model/tool request and result
transformation.

```ts
type AuthoredSessionPatch<TVars extends Vars, TAttrs extends Attrs> =
  | Session<TVars, TAttrs>
  | ((session: Session<TVars, TAttrs>) => Session<TVars, TAttrs>)
  | {
      appendMessages?: readonly Message<TAttrs>[];
      replaceMessages?: readonly Message<TAttrs>[];
      vars?: Record<string, unknown | DeleteValue>;
      middlewareState?: Record<string, unknown | DeleteValue>;
    };
```

This union is only an authoring convenience. The execution engine immediately
normalizes it into a serializable resolved execution transition before
journaling:

```ts
interface ResolvedExecutionTransition {
  schemaVersion: 1;
  beforeVersion: number;
  afterVersion: number;
  session: ResolvedSessionDelta;
  command: ResolvedExecutionCommand;
}

interface ResolvedSessionDelta {
  messageOp:
    | { type: 'append'; messages: readonly Message[] }
    | { type: 'replace'; messages: readonly Message[] }
    | { type: 'none' };
  varsSet: Record<string, unknown>;
  varsDelete: readonly string[];
  middlewareStateSet: Record<string, unknown>;
  middlewareStateDelete: readonly string[];
}
```

The durable journal stores `ResolvedExecutionTransition`, not closures, not
partial TypeScript objects, and not user-provided patch functions. Replaying a
session-changing hook or middleware applies the stored transition and does not
call the handler again.

This gives hooks the power the user expects, while preserving replay safety:
durable replay reuses the recorded patch result instead of re-running
non-deterministic hook logic.

PromptTrail also keeps an ordered history of durable step coordinates. The
journal contains both the expected coordinate sequence and the resolved results.
Replay validates the next coordinate before applying a stored result.

## Concept Boundaries

### Middleware

Middleware is LangChain-like. It wraps or transforms execution.

Use middleware for:

- dynamic model selection
- model fallback and retry
- temporary model input shaping
- channel-specific system prompt injection
- dynamic tool availability
- PII redaction
- long-context summarization
- tool approval, caching, retry, and result normalization

Target API:

```ts
const agent = Agent.create().use(
  Middleware.create({
    name: 'channelPolicy',
    beforeModel: async ({ session, request, context }) => {
      return {
        request: {
          ...request,
          system: [context.channelPrompt, request.system]
            .filter(Boolean)
            .join('\n\n'),
        },
      };
    },
    wrapToolCall: async ({ call, tool, session }, next) => {
      if (tool.metadata?.risk === 'write') {
        return { type: 'tool_result', content: 'Tool requires approval.' };
      }
      return next({ call, tool, session });
    },
  }),
);
```

Middleware can return:

- `session`: persistent session patch
- `request`: transient model/tool request patch
- `result`: replacement model/tool result
- `command`: advanced control flow, such as suspend or jump

PromptTrail should copy LangChain's useful split:

- `beforeAgent`
- `afterAgent`
- `beforeModel`
- `prepareModelInput`
- `wrapModelCall`
- `afterModel`
- `wrapToolCall`
- `afterTool`

`prepareModelInput` is intentionally transient: it changes what the model sees
for one call but does not persist the change to `Session`.

`beforeModel` and `afterModel` may return `session` patches and therefore can
persist state changes.

Tool and model wrapper middleware always returns a normalized execution patch:

```ts
return { result: toolResult };
return { request: nextRequest };
return { session: sessionPatch, command: Command.suspend('approval') };
```

Returning a raw tool message or raw model response is accepted only as syntax
sugar and is normalized to `{ result }` before journaling.

### Hook

Hook is PyTorch-Lightning-like: named lifecycle callbacks with optional state
patches.

Hooks are lower-level than middleware and should map directly to engine phases:

```ts
const hooks = Hook.create({
  onRunStart(ctx) {},
  onBeforeTemplate(ctx) {},
  onAfterTemplate(ctx) {
    return { session: ctx.session.withVar('lastTemplate', ctx.templateId) };
  },
  onBeforeModel(ctx) {},
  onAfterModel(ctx) {},
  onBeforeTool(ctx) {},
  onAfterTool(ctx) {},
  onSuspend(ctx) {},
  onResume(ctx) {},
  onRunEnd(ctx) {},
});
```

Hooks are allowed to change session state, but they must do so by returning a
patch. Hooks may also return an execution command such as `suspend`, `jump`,
`halt`, or `retry`. Hooks cannot change model/tool requests or replace
model/tool results; that is middleware's job.

Hooks should not perform external side effects. If a hook needs to expose
progress, it emits or relies on events that observers handle. Hook context
should intentionally omit platform delivery handles and other side-effecting
capabilities.

Use hooks for:

- run-local accounting
- deterministic state annotations
- lifecycle-specific validation
- branch/jump/suspend decisions
- adapting durable runtime internals

Do not use hooks for:

- Discord message sending
- typing indicators
- metrics pushes
- command log streaming to external systems

Those are observer responsibilities.

### Event / Observer

Events are facts. Observers subscribe to facts.

Events and observers cannot change `Session`, model requests, tool calls, or
runtime control flow.

```ts
type RuntimeEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'model.started'; turnId: string }
  | { type: 'tool.started'; toolCallId: string; name: string }
  | {
      type: 'tool.completed';
      toolCallId: string;
      name: string;
      preview?: string;
    }
  | { type: 'delivery.pending'; idempotencyKey: string }
  | { type: 'delivery.completed'; idempotencyKey: string }
  | { type: 'delivery.failed'; idempotencyKey: string; error: unknown }
  | { type: 'error'; error: unknown };

const observer = Observer.create({
  name: 'logger',
  replayPolicy: 'live-and-journaled',
  handle(event, context) {},
});
```

A bare function observer may be accepted as sugar, but public examples should
prefer the object form so name, replay policy, and delivery bindings are
explicit.

Observers may do external side effects, but those side effects must be
idempotent when durable execution can replay or retry.

Observers declare how they behave during replay:

```ts
type ObserverReplayPolicy =
  | 'live-only'
  | 'live-and-journaled'
  | 'adopt-replayed';
```

Default is `live-and-journaled`: observers see live execution and journaled
durable application events. Pure `replayed` UI reconstruction events are
delivered only to observers that opt into `adopt-replayed`, because a normal
Discord or metrics observer must not re-send historical side effects.

Replay policy matrix:

| Policy               | Receives `live` | Receives `journaled` | Receives `replayed` |
| -------------------- | --------------- | -------------------- | ------------------- |
| `live-only`          | yes             | no                   | no                  |
| `live-and-journaled` | yes             | yes                  | no                  |
| `adopt-replayed`     | yes             | yes                  | yes                 |

`adopt-replayed` is a superset policy for observers that can adopt existing
platform bindings during UI reconstruction.

Use observers for:

- Discord progress messages
- typing / processing indicators
- logs
- metrics
- traces
- live terminal output

## Durable Integration

Durable execution owns the authoritative replay contract. Every session-changing
middleware or hook phase is a deterministic step:

```ts
const transition = await journaled(state, stepId, async () => {
  const authoredPatch = await runHookOrMiddlewarePhase(phase, input);
  return resolveExecutionTransition(session, authoredPatch);
});

const applied = applyResolvedExecutionTransition(session, transition);
session = applied.session;
command = transition.command;
```

The durable journal stores the resolved execution transition, not just the fact
that a hook ran. On replay, PromptTrail applies the stored session transition,
restores the stored command, and does not call the hook or middleware handler
again for materialized phases.

This prevents:

- double summarization
- duplicate system prompt injection
- non-deterministic timestamps changing state
- accidental replay divergence
- re-running expensive model/tool policy logic

Request-only middleware phases are not persisted as session transitions. Their
effects matter only if they influence a journaled model/tool result. In durable
mode, the model/tool result is the committed step; replay applies that result
instead of rebuilding the transient request.

Durable mode does not make arbitrary JavaScript deterministic. It changes the
execution contract:

- session-changing hook/middleware phases become materialized transitions
- model/tool/provider calls become activity-like steps unless explicitly pure
- final delivery becomes an outbox/send obligation
- observers remain outside the canonical journal and use idempotent bindings

PromptTrail should provide development-time checks similar to Inngest's step
lint rules:

- no nested `ctx.durable.*` inside a materialized phase
- no ambient variable mutation inside `ctx.durable.activity()` closures in
  recommended lint mode
- no direct platform delivery handles in hooks/middleware
- require an `idempotencyKey` for activity kinds marked `external-write`

### Step Coordinates

Every hook/middleware/model/tool phase must have a stable ordered coordinate:

```ts
stepCoordinate = {
  runId,
  templatePath,
  iteration,
  phase,
  scope,
  registrationIndex,
  middlewareOrHookName,
  attempt,
};
```

Examples:

- `run-1/chat#3/beforeModel/agent[0]/channelPolicy#0`
- `run-1/turn#1/model/wrapModelCall/agent[2]/modelFallback#1`
- `run-1/turn#1/tools/call_abc/wrapToolCall/template[0]/toolApproval#0`
- `run-1/turn#1/afterTool/agent[1]/auditState#0`

`attempt` is mandatory for wrappers that may call `next()` more than once, such
as model fallback or tool retry. It is allocated by a journaled monotonic
counter scoped to the parent coordinate.

Replay identity is based on `registrationIndex`, scope, phase, template path,
iteration, and attempt. `middlewareOrHookName` is advisory diagnostic metadata
and is still recorded; renaming a registered handler should be treated as a
durable compatibility break unless a migration maps the old name to the new one.
Fallback/retry wrappers recover their attempt count from the journaled
per-coordinate counter.

If ordering changes between code versions, durable replay may detect
nondeterminism. That is correct: changing hook/middleware order can change
session state and should be treated like changing a durable workflow.

Replay must maintain an ordered history of expected step coordinates. On replay,
the next live coordinate is compared to the next journal coordinate. Mismatch
throws `NondeterminismError` instead of silently running a new step.

### Replay Modes

```ts
type ReplayMode = 'live' | 'journaled' | 'replayed';
```

- `live`: the handler is executing now and its output will be committed.
- `journaled`: a stored output is being applied instead of re-running handler
  code.
- `replayed`: events are being re-emitted only to reconstruct UI.

Observers must not infer side-effect safety from `live` alone. A crash before a
journal entry is committed can make live work run again. External observers need
idempotency keys.

### Determinism Rules

Session-changing hooks and middleware should be deterministic with respect to:

- input session
- request/tool call
- runtime context
- durable inbox
- explicitly provided clock/random services

PromptTrail supports two handler modes:

```ts
type HandlerDurabilityMode = 'materialized-phase' | 'replayable-handler';
```

Default is `materialized-phase`: the whole handler result is normalized into a
resolved transition and journaled. On replay the handler is skipped. In this
mode, nested durable effects inside the handler are disallowed because they
would imply re-running the handler.

Materialized phases must be side-effect-free. They can compute a session patch
and command, but they cannot perform external I/O, platform delivery, metrics
pushes, or durable nested effects. If the process crashes after a materialized
handler computes its patch but before the transition is journaled, the handler
may run again. That is acceptable only because materialized handlers are
side-effect-free recomputation; once committed, the journaled transition is
authoritative.

PromptTrail should allow handler authors to declare the mode:

```ts
Hook.create({
  name: 'auditHook',
  durability: 'materialized-phase',
  onAfterTool(ctx) {
    return { session: ctx.session.withVar('lastTool', ctx.toolCall.name) };
  },
});

Middleware.create({
  name: 'profileLoader',
  durability: 'replayable-handler',
  async beforeModel(ctx) {
    const profile = await ctx.durable.activity(
      'load-profile',
      {
        idempotencyKey: `profile:${ctx.context.userId}`,
        kind: 'external-read',
      },
      () => loadProfile(ctx.context.userId),
    );
    return { session: { vars: { profile } } };
  },
});
```

`replayable-handler` is an advanced mode for handlers that must be re-run and
can use durable helpers:

```ts
const now = await ctx.durable.memo('summarizedAt', () => Date.now());
const id = await ctx.durable.memo('summaryId', () => crypto.randomUUID());
const profile = await ctx.durable.activity(
  'loadProfile',
  {
    kind: 'external-read',
    idempotencyKey: `profile:${ctx.context.userId}`,
  },
  () => loadUserProfile(ctx.context.userId),
);
```

`ctx.durable.now(name)` and `ctx.durable.randomId(name)` may exist as sugar over
`ctx.durable.memo(...)`. There is no separate `durable.effect()` API; use
`memo` for non-I/O capture and `activity` for I/O. A handler must choose one
mode; PromptTrail must not both journal the whole phase and also re-run it with
nested effects.

## Session Patch Semantics

Session patches and commands are applied by the engine, never by direct
mutation. The authoring form is normalized before application and before
journaling.

```ts
interface ExecutionPatch<TVars extends Vars, TAttrs extends Attrs> {
  session?: AuthoredSessionPatch<TVars, TAttrs>;
  request?: unknown;
  result?: unknown;
  command?: ExecutionCommand;
}
```

`ExecutionCommand` is a small control-flow union:

```ts
type ExecutionCommand =
  | { type: 'suspend'; reason?: string }
  | { type: 'jump'; target: string }
  | { type: 'halt'; reason?: string }
  | { type: 'retry'; reason?: string };
```

Resolved commands are serializable and explicit:

```ts
type ResolvedExecutionCommand =
  | { type: 'suspend'; reason?: string }
  | { type: 'jump'; target: string }
  | { type: 'halt'; reason?: string }
  | { type: 'retry'; reason?: string }
  | { type: 'none' };
```

The journal records a resolved command, including `{ type: 'none' }`, for every
materialized phase. This is required because replay skips the hook/middleware
handler; without a stored command, durable replay would lose `suspend`, `jump`,
`halt`, or `retry` decisions.

Resolved session transitions use fixed merge semantics:

- `appendMessages` appends messages to the current session.
- `replaceMessages` replaces the entire message list and is intended for
  explicit compaction/summarization.
- `appendMessages` and `replaceMessages` cannot both appear in one authored
  patch.
- `vars` is a shallow key-level write into `Session.vars`.
- `DeleteValue` explicitly deletes a var key; `undefined` is stored as a value
  only if the serializer supports it, otherwise it is rejected.
- middleware state is stored separately from user vars under an engine-owned
  namespace, not as message attrs. Message `Attrs` remain message-scoped.
- multiple patches fold left-to-right in the fixed phase order, and each patch
  sees the session produced by the previous patch.

Opaque authoring forms are normalized by diffing against the input session:

- If a returned `Session` or patch function result has the input messages as an
  exact prefix, normalize to `append`.
- Otherwise normalize to `replace` with the full returned message list.
- For vars, keys with changed values become `varsSet`.
- Keys present in the input session and absent in the returned session become
  `varsDelete`.
- Middleware state cannot be inferred from a returned `Session`; handlers that
  need middleware state changes must use the object patch form.

These diff rules are part of the versioned `ResolvedExecutionTransition`
contract. Changing them is a durable workflow compatibility break.

Patch order is one total order:

1. phase order:
   `beforeAgent`, `beforeModel`, `prepareModelInput`, `wrapModelCall`,
   `afterModel`, `beforeTool`, `wrapToolCall`, `afterTool`, `afterAgent`
2. within a phase, scope order: agent, template, source/runtime adapter
3. within a scope, middleware runs before hooks
4. within middleware or hook lists, declaration order is preserved
5. wrapper middleware composes outside-in, matching LangChain's
   `wrapModelCall` / `wrapToolCall` model

Hook handlers are skipped for phases where hooks have no authority. For
example, `prepareModelInput` is middleware-only.

The engine emits `session.patched` events after each committed patch with:

- previous session version
- next session version
- phase id
- patch summary
- replay mode

Observers can use these events for logs and UI, but cannot alter the patch.

## Request vs Session Transformation

PromptTrail needs a first-class distinction between persistent and transient
changes:

```ts
beforeModel(ctx): ExecutionPatch
prepareModelInput(ctx): { request: ModelRequest }
```

`beforeModel` can persist a summary into `Session`.

`prepareModelInput` can add a Discord channel prompt to the model request
without adding it to the transcript.

This is important for channel prompts, reminders, policy hints, and temporary
tool guidance. They should not pollute durable conversation history unless the
developer explicitly returns a `session` patch.

## Tool Execution

Tool execution has three layers:

1. model emits tool call
2. middleware can rewrite, approve, cache, or replace it; hooks can validate
   and patch session/control state at lifecycle boundaries
3. tool executes and returns a tool result message

Target flow:

```ts
emit('tool.detected');

await runPhase('beforeTool', { call });
result = await wrapToolCallMiddlewares({ call }, executeTool);
result = await runPhase('afterTool', { call, result });

session = session.addMessage(toolResultToMessage(result));
emit('tool.completed');
```

For durable runs:

- tool execution is journaled
- hook/middleware patches around the tool are journaled
- observer events are emitted with deterministic idempotency keys

## Event Envelope and Idempotency

All events have stable coordinates:

```ts
interface RuntimeEventBase {
  id: string;
  type: string;
  at: string;
  seq: number;
  conversationId?: string;
  runId?: string;
  turnId?: string;
  templatePath?: string;
  stepId?: string;
  phase?: string;
  source?: string;
  replay?: ReplayMode;
  idempotencyKey?: string;
  sessionVersion?: number;
  raw?: unknown;
}
```

External side-effect observers use deterministic idempotency keys:

```ts
idempotencyKey = stableHash([
  conversationId,
  runId,
  templatePath,
  stepId,
  phase,
  event.type,
  event.seq,
]);
```

`seq` is mandatory and allocated by a per-run monotonic counter. In durable
mode, the counter is journaled so event coordinates remain replay-stable.

Observers must use check-before-write semantics:

1. look up `idempotencyKey`
2. adopt/edit existing platform binding if present
3. otherwise write to the platform
4. persist `idempotencyKey -> platformBinding`

For platforms without idempotent sends, progress events are at-least-once.
Final assistant delivery is handled separately by the runtime outbox.

## Runtime Outbox

Final assistant delivery is not a hook, middleware, or ordinary observer side
effect. It is a runtime delivery obligation.

```ts
interface RuntimeDeliveryOutboxEntry {
  id: string;
  idempotencyKey: string;
  conversationId: string;
  target: DeliveryTarget;
  messageRef: { conversationId: string; assistantIndex: number };
  platformBinding?: unknown;
  status: 'pending' | 'delivering' | 'delivered' | 'failed';
  attempts: number;
  lastError?: string;
}
```

Outbox idempotency is derived from the committed assistant message and target:

```ts
idempotencyKey = stableHash([
  conversationId,
  runId,
  messageRef.assistantIndex,
  stableDeliveryTarget(target),
]);
```

`delivery.pending`, `delivery.completed`, and `delivery.failed` events for final
assistant delivery use the outbox entry's idempotency key, not the generic event
key that includes `seq`. This lets observers correlate delivery facts with the
durable delivery obligation.

When a durable turn commits an assistant message, it also creates a `pending`
outbox entry in the same durable commit. `RuntimeServer` delivers outbox entries
and transitions them through `delivering` to `delivered` or `failed`.

On startup, the runtime scans `pending`, `delivering`, and `failed` entries and
retries them before accepting new source events for the same conversation.

This guarantees replies are not silently lost. It is effectively-once when the
platform supports idempotent delivery or adoption of an existing binding;
otherwise it is at-least-once but retryable.

`RuntimeServer` is the sole sender of final assistant messages. `delivery.*`
events are facts for observers; observers must not send final replies in
response to those events.

## Concurrency

Durable execution is serialized per `conversationId`. If Discord and cron wake
the same conversation concurrently, the runtime acquires a conversation lock,
appends inbound events in a deterministic order, and runs one resume at a time.

The lock protects:

- journal coordinate order
- session version increments
- assistant message indexes used by the outbox
- delivery outbox creation

Different conversations may run concurrently.

## API Sketch

### Direct Agent

```ts
const agent = Agent.create()
  .use(summarizationMiddleware)
  .hook(auditHook)
  .observe(logObserver)
  .system('You are helpful')
  .assistant(Source.llm({ model: 'openai:gpt-4o-mini' }));

await agent.execute(session, {
  context: { userId: 'U1' },
});
```

### Runtime Server

```ts
const app = PromptTrail.app({
  hooks: [auditHook],
  middleware: [channelPolicyMiddleware],
  observers: [discordProgressObserver(), metricsObserver()],
});

const server = PromptTrail.server({
  bundle,
  runtime: app,
  adapters: [discordGateway()],
});
```

### Durable Hook

```ts
const auditHook = Hook.create({
  name: 'auditHook',
  onAfterTool: ({ session, toolCall, result }) => ({
    session: session.addMessage({
      type: 'system',
      content: `Tool ${toolCall.name} completed`,
      attrs: { internal: true },
    }),
  }),
});
```

Because the returned patch is journaled, replay applies the recorded system
message exactly once.

### Observer

```ts
const discordProgressObserver = Observer.create({
  name: 'discordProgress',
  async handle(event, ctx) {
    if (event.type !== 'tool.started') return;
    await ctx.deliveryBindings.checkWrite(event.idempotencyKey, async () => {
      return ctx.discord.sendProgress(`Running ${event.name}`);
    });
  },
});
```

The observer cannot change session state.

## Discord / Hermes Mapping

Discord-specific behavior should use all four layers:

- Runtime binding maps Discord channel/thread to `conversationId`.
- Middleware injects channel prompts and channel-specific tool availability.
- Hooks can annotate session state, for example last active Discord thread or
  deterministic audit messages.
- Events describe tool/model/runtime/delivery progress.
- Observers render typing indicators, tool progress, command summaries, and
  delivery status.
- Runtime outbox delivers final assistant replies.

This keeps Discord presentation out of the canonical transcript unless a hook or
middleware explicitly returns a session patch.

## Failure Semantics

Middleware and hook failures are execution failures unless configured otherwise.

Recommended defaults:

- session-changing hook/middleware failure fails the phase
- observer failure emits `observer.failed` but does not mutate session
- final delivery failure leaves an outbox entry retryable
- `strictObservers: true` can fail tests on observer failure

If a hook has already returned a patch and the engine committed it, later
observer failure cannot roll it back. Rollback must be modeled explicitly as a
new durable step.

## Implementation Plan

1. Rename the current "hook bus" idea into `RuntimeEvent` / `Observer`.
2. Add `ExecutionContext`, `ExecutionPatch`, `ResolvedExecutionTransition`, and
   `applyResolvedExecutionTransition`.
3. Add `Middleware.create()` with LangChain-like phases.
4. Add `Hook.create()` with lifecycle phases and patch returns.
5. Add durable `runPhase(stepCoordinate, handler)` that journals resolved
   hook/middleware transitions and validates ordered coordinates on replay.
6. Thread execution context through `Agent`, templates, sources, durable app,
   Codex turn, Claude turn, and tool execution.
7. Emit runtime events after each phase and at model/tool/delivery boundaries.
8. Add observer support to direct execution and runtime server.
9. Add runtime outbox for final delivery.
10. Add Discord progress observer as an adapter-level observer.

## Test Scenarios

- A `beforeModel` middleware summarizes a long session; replay applies the
  stored summary patch once and does not call the summarizer again.
- A `prepareModelInput` middleware injects a channel prompt for one model call
  without changing the persisted session.
- An `onAfterTool` hook appends an audit message; replay applies it once.
- A `wrapToolCall` middleware denies a risky tool and returns a tool result.
- A Discord progress observer receives `tool.started` and `tool.completed` but
  cannot change the session.
- A process crashes after a hook patch is committed; resume does not run the
  hook again.
- A process crashes after final assistant message commit but before Discord
  delivery; startup retries the outbox entry.
- Reordering middleware changes durable step ids and triggers replay
  nondeterminism rather than silently producing a different session.

## Open Questions

- Whether the public name should be `hook()` or `on()` for lifecycle callbacks.
- Whether direct `Agent.execute()` should default to non-durable phase execution
  or optionally journal phases in memory for debugging.
- Whether middleware state should be physically stored in the same durable
  record as `Session.vars` or in a separate side-state table. The public model
  should treat it as engine-owned middleware state, not user vars and not
  message attrs.
