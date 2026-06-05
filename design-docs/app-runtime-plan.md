# App Runtime Plan

## Direction

PromptTrail should grow toward a small OpenClaw-like app runtime, but agent
definitions should stay lightweight. The core split is:

- Agent: describes how the agent thinks and acts.
- App/Runtime: owns execution, persistence, event sources, routing, and resume.
- EventSource: adapts external inputs into runtime events.

The durable prototype currently exposes a separate `MemoryDurableRuntime`.
That should be treated as a prototype slice. The final API should have one
runtime/app concept, where `durable` / `resumable` is an execution option rather
than a separate runtime family.

## Target API Sketch

```ts
const codingAgent = Agent.create('coding-agent')
  .system('You are a careful coding agent.')
  .tool('search', searchTool)
  .turn('main', (turn) =>
    turn
      .steer()
      .assistant('act', openai('gpt-4.1'))
      .runTools()
      .untilNoToolCalls()
      .awaitUser(),
  );

const app = PromptTrail.app({
  store: sqliteStore('./prompttrail.db'),

  agents: {
    coding: codingAgent,
  },

  sources: {
    cli: cliSource(),
    github: githubSource({
      repo: 'combinatrix-ai/PromptTrail.ts',
      onIssueComment: (comment) => ({
        agent: 'coding',
        runId: `issue:${comment.issue.number}`,
        input: comment.body,
        durable: true,
      }),
    }),
    cron: cronSource({
      'daily-review': {
        schedule: '0 9 * * *',
        agent: 'coding',
        runId: ({ date }) => `daily-review:${date}`,
        input: "Review today's open tasks.",
        durable: true,
      },
    }),
  },
});

await app.start();
```

For direct use without sources:

```ts
const app = PromptTrail.app({
  store: sqliteStore('./prompttrail.db'),
  agents: { coding: codingAgent },
});

await app.send({
  agent: 'coding',
  runId: 'task-1',
  input: 'Review this repository.',
  durable: true,
});
```

## Runtime Semantics

`durable: true` or `resumable: true` means:

- The run metadata is saved.
- The inbox is saved.
- Journaled effects are saved.
- `resume(runId)` replays from the initial session.
- Model calls, tool calls, and input consumption hit the journal on replay.
- New inbound messages append to the inbox and then trigger resume.

Without durable/resumable, the same app/runtime can run ephemeral executions.

```ts
await app.run({
  agent: 'coding',
  input: 'Hello',
});
```

## EventSource Model

Event sources should not be mixed into the Agent DSL. They are runtime adapters
that produce normalized events.

```ts
type RuntimeEvent = {
  source: 'cli' | 'http' | 'github' | 'slack' | 'cron' | 'fs';
  agent: string;
  runId: string;
  kind?: 'user' | 'system' | 'control';
  input: string;
  durable?: boolean;
  attrs?: Record<string, unknown>;
};
```

Each source only needs to turn platform-specific input into `RuntimeEvent`.
The app/runtime handles routing, inbox append, wake/resume, and output delivery.

Likely sources:

- `cliSource()`
- `httpSource()`
- `githubSource()`
- `slackSource()`
- `cronSource()`
- `fsSource()`

## Store Model

The store should be an adapter, not a runtime type.

```ts
const app = PromptTrail.app({
  store: sqliteStore('./runs.db'),
  agents: { coding: codingAgent },
});
```

Potential stores:

- `memoryStore()` for tests and ephemeral local demos.
- `sqliteStore(path)` for local durable apps.
- Later: Postgres/S3/etc if useful.

The runtime should depend on a store interface that can persist:

- registered run metadata
- initial session / graph version
- inbox messages
- journal records
- run status and locks

## Graph Versioning

Durable runs must not replay against an accidentally changed graph.

For resumable runs, store either:

- a graph snapshot, or
- a graph version/hash and enough metadata to rebuild that exact version.

Editor-facing nodes should have stable node ids. Structural ids should derive
from stable node ids, not array positions, so unrelated edits do not invalidate
old runs.

## Open Questions

- Name: use `durable`, `resumable`, or both? Current leaning: accept both, with
  `durable` as the precise runtime term and `resumable` as user-facing sugar.
- App vs Runtime naming: expose `PromptTrail.app(...)` publicly, keep `Runtime`
  as the internal/expert object.
- Whether direct `agent.run(...)` should exist as shorthand for simple scripts.
- How output delivery works for sources: return value, event emitter, callback,
  or source-specific reply adapter.
