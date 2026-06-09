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

## Final Vocabulary

| Term         | Meaning                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`      | A named, reusable graph of prompt, model, tool, goal, and control nodes.                                                          |
| `App`        | Owns stores, sources, routing, execution, resume, locks, and delivery.                                                            |
| `Binding`    | Maps platform events to an agent, conversation id, input, and defaults.                                                           |
| `Run`        | One execution instance of an agent for a conversation/task.                                                                       |
| `Durable`    | A run mode where graph execution, inputs, model/tool effects, and session transitions are journaled.                              |
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
use.

```ts
const assistant = Agent.create('assistant')
  .system('identity', 'You are a concise project assistant.')
  .tool('lookup', lookupTool)
  .turn('reply', (turn) =>
    turn
      .inbox('inbound')
      .assistant('model', Source.llm().openai({ api: 'responses' }))
      .repeat(
        'tool-loop',
        ({ session }) => session.hasToolCalls(),
        (loop) =>
          loop
            .tools('tools')
            .assistant('model', Source.llm().openai({ api: 'responses' })),
      )
      .awaitInput('next'),
  );
```

Node ids are explicit in the final app/durable API. They are not display
labels. They are stable graph coordinates used by durable replay and graph
version checks.

Common node forms:

```ts
Agent.create('name')
  .system('id', content)
  .user('id', contentOrSource)
  .assistant('id', sourceOrHandler, options)
  .messages('id', handler)
  .patch('id', handler)
  .goal('id', goal, options)
  .turn('id', builder)
  .sequence('id', builder)
  .conditional('id', condition, thenBuilder, elseBuilder)
  .loop('id', builder, condition, options)
  .subroutine('id', builder, options);
```

This deliberately drops the content-first builder shape for graph nodes. A
small convenience can exist for throwaway scripts:

```ts
await Agent.quick()
  .system('You are helpful.')
  .user('Hello')
  .assistant()
  .execute();
```

`Agent.quick()` is ephemeral-only. It cannot be registered in an app or run with
`durable: true`. Non-quick agents may auto-generate ids for ephemeral direct
execution, but app registration and durable execution must validate that every
node has a stable authored id.

### Tools

Tools are registered on agents and can be used by both low-level turns and
goal nodes.

```ts
const lookupTool = Tool.create({
  description: 'Load a customer record.',
  inputSchema: z.object({ id: z.string() }),
  activity: { kind: 'external-read', retry: { maxAttempts: 3 } },
  execute: async ({ id }, ctx) => {
    return ctx.durable.activity(
      'load-customer',
      { kind: 'external-read', idempotencyKey: `customer:${id}` },
      () => loadCustomer(id),
    );
  },
});

const agent = Agent.create('support').tool('lookup', lookupTool);
```

Tool `activity` is the default durable classification for the tool call. Tool
bodies may still use `ctx.durable.memo(...)` and `ctx.durable.activity(...)`
for nested effect boundaries. External writes require an idempotency key.

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

Assistant nodes produce one model response. Tool execution belongs to the
`tools(...)` node. Provider adapters and `Source.llm()` must not run an
internal tool loop when compiled into a graph turn; they may still expose
provider-native tool-call encoding and streaming, but graph execution owns the
tool-call loop and the `beforeTool`/`wrapToolCall`/`afterTool` phases.

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
    isSatisfied: async ({ session, goal }) => hasEnoughSources(session, goal),
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
  isSatisfied?: (
    ctx: GoalSatisfactionContext<TVars, TAttrs>,
  ) => boolean | Promise<boolean>;
  onUnsatisfied?: 'retry' | 'continue' | 'halt';
}

interface GoalSatisfactionContext<TVars, TAttrs> {
  session: Session<TVars, TAttrs>;
  goal: string;
  attempt: number;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
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

const durableResult = await agent.execute({
  runId: 'task:review-repo',
  input: 'Review this repository.',
  durable: true,
  store,
});
```

Final `Agent.execute` takes one options object. It does not take
`Session | undefined` as the first positional argument.

```ts
interface AgentExecuteOptions<TVars, TAttrs> {
  runId?: string;
  input?: string | InboundInput;
  session?: Session<TVars, TAttrs>;
  durable?: boolean | DurableRunOptions;
  store?: RunStore;
  context?: Record<string, unknown>;
  observers?: readonly ObserverLike[];
  signal?: AbortSignal;
}
```

`durable: true` requires either `store` or an app-level default store. Direct
execution without a store is ephemeral.

Implementation note: direct `Agent.execute({ durable: true })` has no app-level
default store, so it must receive `store` either in the execute options or via
`agent.durable({ store })`. Direct durable graph execution accepts one inbound
input per call; follow-up input is appended by executing the same named agent
again with the same `runId` and store. For direct graph execution only, `input`
is materialized by `GraphExecutor` when the graph has no `inbox`, `awaitInput`,
or dynamic `user` node. Materialization happens after leading top-level
`system` nodes so authored system context still precedes user input. Graphs with
explicit inbound consumers keep `input` in the runtime inbox.

### App Runtime

The app is the only host for event sources, bindings, delivery, and durable
conversation resumption.

```ts
const app = PromptTrail.app({
  store: sqliteStore('./prompttrail.db'),
  defaults: {
    durable: true,
    delivery: Delivery.origin(),
  },
})
  .agent(assistant)
  .bind(discord.messages(), (binding) =>
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
      .delivery(discord.replyToOriginThread())
      .context((event) => ({
        platform: 'discord',
        channelId: event.channelId,
      })),
  )
  .bind(cron.schedule('0 9 * * *'), (binding) =>
    binding
      .name('daily-review')
      .to(assistant)
      .conversation((event) => `cron:${event.job.id}`)
      .input('Review open tasks and post a concise summary.')
      .delivery(discord.channel('news')),
  );

await app.start();
```

`to(...)` accepts an `Agent` instance or an agent name. Passing an agent
instance registers it if needed and stores its name in the binding.

The final API should not require a separate `bundle` object for ordinary use.
However, the app should still compile bindings into a structural
`RuntimeBundle` IR. Tests, mocks, servers, and deployment wiring can consume
that IR. `PromptTrail.runtimeBundle(...)` remains the explicit low-level IR
builder for those cases; ordinary app authoring stays on
`PromptTrail.app(...).bind(...)`. The bundle keeps live agent instances and
resolver functions, so it is not a JSON serialization boundary.

### Sources, Adapters, and Delivery

Event sources and delivery drivers are app/runtime concerns.

```ts
const app = PromptTrail.app({ store })
  .source(discordGateway({ token }))
  .delivery(discordDelivery({ token }))
  .activity(discordTypingActivity({ token }));
```

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

- runtime/executor: graph execution, store, journal, inbox cursor, events
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

All agents compile to one durable graph representation. Ephemeral execution runs
the same graph without persisting the journal.

The final implementation should not keep separate template and durable engines.
The current template primitives can become authoring helpers, but execution
must flow through the graph executor.

```ts
Agent DSL -> AgentGraph -> GraphExecutor
                         -> EphemeralRunState
                         -> DurableRunState
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
  type:
    | 'system'
    | 'user'
    | 'assistant'
    | 'messages'
    | 'patch'
    | 'tools'
    | 'inbox'
    | 'awaitInput'
    | 'goal'
    | 'turn'
    | 'loop'
    | 'conditional'
    | 'subroutine'
    | 'parallel'
    | 'structured'
    | 'transform'
    | 'codexTurn'
    | 'claudeTurn';
  data: unknown;
}
```

Local node ids are unique within their parent scope. Full graph paths are
unique within an agent. Nested ids are represented as graph paths at compile
time, not derived from array positions.

### Graph Versioning

Every durable run stores:

- agent name
- graph version/hash
- graph manifest
- initial session
- inbox
- journal
- event history
- final delivery outbox
- run context

If the registered agent graph does not match the stored graph version, resume
must fail with a graph-version error before replay unless an explicit migration
or force-continue policy is provided.

First implementation: graph durable runs persist the generated graph manifest
and compare the stored manifest hash against the currently registered agent
before resume. Migrations and force-continue are not implemented; mismatches
fail fast with a graph-version error.

The graph manifest is a structural verification artifact, not an executable
snapshot. Nodes may contain closures, `Source` instances, provider clients, and
handlers that cannot be serialized. Execution code always comes from the
currently registered agent. The manifest stores enough structure to detect
whether the registered agent is compatible with the durable journal:

- graph version/hash
- node ids, node types, and graph paths
- edge/control structure
- tool names and tool activity classifications
- middleware/hook ids and declaration order
- provider/source kind metadata when serializable

### Durable Step Coordinates

Durable step ids derive from graph paths:

```txt
agentName/nodeId
agentName/turnId/model
agentName/goalId/check
agentName/goalId/tools/toolCallId
```

They must not include array positions or generated anonymous names. Middleware
and hook ordering must also be stabilized.

### Middleware and Hook Ordering

The current durable prototype validates middleware/hook order using
registration indexes. That is too fragile for app-level defaults and binding
injection.

Final ordering:

1. agent middleware/hooks
2. app middleware/hooks
3. binding middleware/hooks
4. runtime internal middleware/hooks

Each handler must have a stable id:

```ts
Middleware.create('channel-policy', { beforeModel(...) { ... } });
Hook.create('audit', { onRunStart(...) { ... } });
```

Anonymous middleware and hooks are allowed only for ephemeral runs.

Durable replay identity is a compound key:

- phase
- handler kind (`middleware` or `hook`)
- handler id
- declaration order within its layer

Reordering handlers is a graph version change because it can change behavior,
but replay should validate stable handler ids rather than relying on raw array
indexes alone. Missing or changed handler ids fail at resume.

### Effect Boundaries

Durable mode journals:

- inbox consumption
- model calls
- tool calls
- `ctx.durable.memo(...)`
- `ctx.durable.activity(...)`
- resolved session transitions from hooks/middleware/patches/goals

Observers are not part of session state. They receive live events and can adopt
replayed events through explicit replay policy.

Final assistant delivery is always an engine-owned outbox entry. Handlers do
not call a general `outbox.send(...)` API in the first final design.

## Implementation Plan

Backward compatibility is not required, so implementation should replace the
split runtime instead of layering more adapters over it.

### Phase 1: Define Graph IR

- Add `AgentGraph`, `GraphNode`, `GraphEdge`, `GraphExecutor`.
- Make `Agent` a graph builder instead of a `Template` wrapper.
- Require explicit node ids for app/durable agents.
- Keep `Agent.quick()` for ephemeral content-first examples.
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

### Phase 3: Port Durable Executor to GraphExecutor

- Move durable journal logic from `durable.ts` into graph execution services.
- Execute both ephemeral and durable runs through `GraphExecutor`.
- First implementation scope: graph-authored direct and app runs execute through
  `GraphExecutor` in both ephemeral and durable modes, with store-backed
  session/result persistence, inbox resume, observer event persistence,
  assistant delivery materialization, and graph manifest validation. Full
  journaled model/tool effect replay is still owned by the legacy durable
  services until the remaining durable journal logic is ported. Unified tools
  already expose `activity` and graph tool calls pass `ctx.activity`, but
  graph-authored durable runs do not yet journal `ctx.durable.memo(...)` or
  nested `ctx.durable.activity(...)` calls from tool bodies.
- Preserve durable concepts:
  - run store
  - inbox cursor
  - journal sequence
  - suspend/resume
  - model/tool progress events
  - session patch events
  - final delivery outbox
  - event replay
  - nondeterminism errors
- First map the internal legacy durable-agent graph to `AgentGraph` and keep
  existing durable tests green. Then remove the old durable switch once the graph
  executor is authoritative.

### Phase 4: Rebuild Agent DSL on Graph IR

- Implement `system/user/assistant/messages/patch` graph nodes.
- Implement `turn` nodes with `inbox/repeat/assistant/tools/awaitInput`.
- Implement `goal` nodes by compiling to a stable subgraph.
- Implement `loop/conditional/subroutine` as graph control nodes.
- Remove template-only execution paths.

### Phase 5: Rebuild App API

- Make `PromptTrail.app(...)` the primary runtime constructor.
- Add fluent `.agent(...)`, `.source(...)`, `.delivery(...)`, `.activity(...)`,
  and `.bind(source, builder)` methods.
- Remove ordinary need for `PromptTrail.runtimeBundle(...)` while keeping
  `RuntimeBundle` as the app's structural runtime IR.
- Allow `.to(agentOrName)`.
- Convert current runtime server adapter pipeline into app internals while
  preserving the internal runtime/server separation.

### Phase 6: Documentation and Examples

- Rewrite README around the final API.
- Move old API references to migration notes only if useful.
- Update examples to use explicit node ids.
- Keep provider capability docs but align examples with `AgentGraph`.

## Non-Goals

- Preserving current `Agent.create().user('text')` as the main API.
- Preserving `Scenario.system(...).step(...)`.
- Preserving public `DurableAgent`.
- Supporting durable replay for anonymous graph nodes.
- Exposing general user-authored outbox sends before final assistant delivery
  outbox is stable.

## Open Decisions

- Whether `Agent.quick()` should exist or whether examples should always use
  explicit ids.
- Whether `goal` should be named `goal`, `task`, or `step`. This design uses
  `goal` because it describes the semantic contract, but the compiled graph
  node is a control-flow step.
- Whether app-level `.defaults(...)` should be constructor-only or mutable.
- Whether binding-level middleware/hooks should exist in the first final app
  API or wait until app-level handlers are stable.
- Whether graph-version mismatch should support explicit migrations in the
  first implementation or only fail fast.
