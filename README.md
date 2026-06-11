# PromptTrail.ts

PromptTrail.ts is a TypeScript framework for structured LLM conversations and
event-driven agents. The public authoring surface is `Agent.create('name')`,
immutable `Session` state, `Source` content providers, `Tool` declarations, and
the `PromptTrail.app(...)` runtime for checkpointed event handling.

## Packages

```bash
pnpm add @prompttrail/core
pnpm add @prompttrail/discord
pnpm add @prompttrail/cron
```

- `@prompttrail/core` contains agents, sessions, sources, tools, checkpoint
  runtime, bindings, and runtime server primitives.
- `@prompttrail/discord` contains Discord triggers, routing helpers, delivery,
  presence, and test adapters.
- `@prompttrail/cron` contains cron triggers and test helpers.

## Quick Start

```ts
import { Agent, Source } from '@prompttrail/core';

const assistant = Agent.create('support')
  .system('You are a concise support assistant.')
  .user('How do I reset my password?')
  .assistant(Source.llm().openai({ modelName: 'gpt-5.4-nano' }));

const session = await assistant.execute();
console.log(session.getLastMessage()?.content);
```

For one inbound value, pass it to `execute({ input })` and consume it with an
`inbox` node:

```ts
import { Agent, Source } from '@prompttrail/core';

const assistant = Agent.create('support')
  .system('Answer the latest inbound user message.')
  .inbox()
  .assistant(Source.llm());

const session = await assistant.execute({
  input: 'What is the status of my order?',
});
```

Use `execute({ input })` for direct execution with inbound content.

## Agent Authoring

Node ids are optional. A single string passed to `.system(...)`, `.user(...)`,
`.assistant(...)`, or `.goal(...)` is content, not an id:

```ts
const triage = Agent.create('triage')
  .system('Classify the request and ask one clarifying question if needed.')
  .inbox()
  .assistant(Source.llm());
```

Use the two-argument form when a stable authored id matters:

```ts
const triage = Agent.create('triage')
  .system('policy', 'Use the current support policy.')
  .inbox('customer-message')
  .assistant('draft', Source.llm());
```

Derived ids are based on structural position. Inserting, removing, or reordering
nodes can shift derived ids and invalidate checkpoint resume. Use explicit ids
for long-lived checkpoint runs, loops, and mid-flow suspend points.

The final authoring vocabulary is:

- Leaf/protocol nodes: `system`, `user`, `assistant`, `transform`, `inbox`,
  `awaitInput`, `tools`, `structured`
- Containers: `loop`, `conditional`, `subroutine`, `parallel`
- Intent and provider turns: `goal`, `codex`, `claude`

Removed authoring words include `quick`, `turn`, `repeat`, `sequence`, `patch`,
`messages`, and old `codexTurn` / `claudeTurn` method names.

## Tools And Effects

Tools are model-callable effect boundaries. Under normal ephemeral execution,
effect declarations are optional. Under checkpoint execution, every author tool
must declare one of two forms:

```ts
import { Tool } from '@prompttrail/core';
import { z } from 'zod';

const searchDocs = Tool.create({
  name: 'searchDocs',
  description: 'Search documentation.',
  inputSchema: z.object({ query: z.string() }),
  effect: { repeatable: true },
  execute: async ({ query }) => searchDocumentation(query),
});

const chargeCard = Tool.create({
  name: 'chargeCard',
  description: 'Charge a card for an order.',
  inputSchema: z.object({ orderId: z.string(), cents: z.number() }),
  effect: {
    idempotencyKey: (input) =>
      `charge:${(input as { orderId: string }).orderId}`,
  },
  execute: async ({ orderId, cents }, ctx) =>
    chargeRemoteSystem({ orderId, cents, idempotencyKey: ctx.idempotencyKey }),
});
```

`{ repeatable: true }` says the tool can be safely re-run. `{ idempotencyKey }`
says the tool performs an effect that must be deduplicated. The resolved key is
passed to the tool as `ctx.idempotencyKey`; forward it to the remote system.

The property is named `effect` on `Tool.create(...)` for the current API. It
stores an `ExecutionEffectDeclaration`.

Vendor tool loops need one more checkpoint decision. `.codex(...)`,
`.claude(...)`, and native OpenAI Responses, Anthropic Messages, and Gemini
sources with tools let the vendor own the loop. Tool effects in that loop sit
outside PromptTrail's `once` memo, and an interrupted turn may re-run on resume;
this is a best-effort/self-heal posture, not a durable local tool boundary.
`ctx.idempotencyKey` still flows into PromptTrail tool bodies, so forward it to
remote systems for deduplication. Under checkpoint execution, native adapter
sources with tools must explicitly acknowledge this with
`toolLoop: 'vendor'`, or use `adapter: 'ai-sdk'` for graph-visible tool calls
and results.

## Checkpoint Durability

Checkpoint execution persists session progress at node boundaries and resumes
forward from the stored checkpoint:

```ts
import { Agent, Source, memoryStore } from '@prompttrail/core';

const store = memoryStore();

const assistant = Agent.create('support')
  .system('Answer the inbound request.')
  .inbox('request')
  .assistant('reply', Source.llm())
  .checkpoint(store);

const runId = 'support:conversation:42';

const first = await assistant.execute({
  runId,
  input: 'Can you help with billing?',
  checkpoint: store,
});

const resumed = await assistant.execute({
  runId,
  checkpoint: store,
});

console.log(first.status, resumed.session.getLastMessage()?.content);
```

You can also pass the store per execution:

```ts
const result = await assistant.execute({
  runId: 'support:conversation:42',
  input: 'Can you help with billing?',
  checkpoint: store,
});

console.log(result.session.messages.length);
```

`checkpoint: true` uses the app's ambient store. Direct
`Agent.execute({ checkpoint: true })` without an ambient store fails; pass
`checkpoint: store` or configure the app.

The guarantee is honest and intentionally limited:

- PromptTrail provides checkpoint resume with at-least-once effect execution.
- Completed nodes are skipped on resume; incomplete nodes may re-run.
- Local `ctx.once(...)` memoization is best-effort over crash windows.
- Effective-once external writes require the remote system to honor the
  idempotency key.
- PromptTrail does not provide exactly-once delivery or exactly-once external
  effects.

The runtime orders external write, memo record, and checkpoint persistence for
at-least-once behavior. This avoids silently dropping a committed write, but it
cannot atomically coordinate the local store and a remote service.

## Transform Nodes

Use pure synchronous transforms for session-only logic:

```ts
const agent = Agent.create('with-vars')
  .transform((session) => session.withVar('attempt', 1))
  .assistant('Ready.');
```

Async transforms must declare an effect:

```ts
const agent = Agent.create('fetch-profile').transform(
  { effect: { repeatable: true } },
  async (session) => {
    const profile = await fetchProfile(session.getVar('userId'));
    return session.withVar('profile', profile);
  },
);
```

Decision handlers such as `conditional`, `loop`, and `goal.isSatisfied` are
synchronous. Fetch in a tool or declared effect transform, store the result in
the session, then branch synchronously.

## Goals And Tool Loops

`goal(...)` is the intent-level API. Registered tools and goal tools compile to
ordinary graph nodes; PromptTrail owns the loop.

```ts
const researcher = Agent.create('researcher')
  .system('Research before answering.')
  .tool('searchDocs', searchDocs)
  .goal('Gather evidence for the inbound question.', {
    tools: ['searchDocs'],
    maxAttempts: 4,
    isSatisfied: ({ session }) =>
      session.getMessagesByType('tool_result').length >= 2,
  })
  .goal('Write the final answer.');
```

A top-level `assistant(...)` with registered tools also gets automatic
tool-loop sugar. The manual layer is to write `loop(...)` and `tools(...)`
yourself when you need direct control.

## Subroutines

`subroutine(...)` is an isolation boundary. By default it enters with a fresh
sub-session and appends subroutine messages back to the parent on exit while
keeping parent vars unchanged. Use `init` and `squash` to project state in and
out explicitly:

```ts
const agent = Agent.create('review').subroutine(
  'draft-review',
  (draft) =>
    draft
      .system('Review the draft in isolation.')
      .user('Please check tone and clarity.')
      .assistant(Source.llm()),
  {
    init: (parent) =>
      parent.withVars({
        draft: parent.getVar('draft'),
      }),
    squash: (parent, sub) =>
      parent.withVar('review', sub.getLastMessage()?.content ?? ''),
  },
);
```

## Provider Turns

Use `.codex(...)` for Codex App Server turns and `.claude(...)` for Claude Agent
SDK turns. In these nodes the provider owns its internal loop, so PromptTrail
cannot checkpoint inside the provider turn.

Under checkpoint execution, PromptTrail persists provider thread/session ids as
soon as the provider returns them and tries to reconnect on resume. If reconnect
is impossible, the default is fail-fast. Opt into a best-effort restart only
when re-running the provider turn is acceptable:

```ts
const agent = Agent.create('coding').codex({
  transport: { kind: 'websocket', url: 'ws://127.0.0.1:8390' },
  cwd: process.cwd(),
  onUnresumable: 'restart',
  restartNotice:
    'The previous provider turn was interrupted. Restart and continue.',
  maxRestarts: 1,
});
```

Vendor-internal tool side effects are outside PromptTrail's idempotency memo;
use the same `toolLoop: 'vendor'` acknowledgement when a checkpointed native
adapter source carries tools.

## App Runtime

Apps connect triggers to agents. Defaults are constructor-only:

```ts
import { Agent, PromptTrail, Source, memoryStore } from '@prompttrail/core';
import { discord, discordGateway } from '@prompttrail/discord';

const support = Agent.create('support')
  .system('Answer Discord support questions.')
  .inbox()
  .assistant(Source.llm());

const app = PromptTrail.app({
  name: 'support-bot',
  store: memoryStore(),
  defaults: {
    checkpoint: true,
  },
  adapters: [
    discordGateway({
      token: process.env.DISCORD_TOKEN,
    }),
  ],
  presence: { kind: 'typing' },
})
  .agent(support)
  .on(discord.messages(), (b) =>
    b
      .where(discord.notBot())
      .to(support)
      .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
      .input((event) => event.content)
      .reply(discord.replyToOriginThread()),
  );

await app.start();
```

Use `app.gateway(...)` for custom inbound gateways, `app.delivery(...)` for
delivery drivers, and `app.presence(...)` for typing or processing indicators.
`app.on(trigger, builder)` is the binding API.

## Run Per Event

The standard event-driven shape is one run per inbound event. An agent handles
one event, reaches the end of its graph, and stops. Continuity comes from the
app layer: the binding's `.conversation(...)` resolver maps related events to
the same conversation/run id, so the next event resumes the checkpointed
conversation.

Do not model a chat bot as an infinite graph loop that waits forever. Use
`awaitInput` only for mid-flow suspension, such as a goal that needs a specific
clarifying answer before the current event flow can continue.

## Binding And Routing DSL

A binding is a pure transform from a platform event to a normalized routing
decision. The fluent chain fills slots in a record; it is not an ordered
pipeline:

```ts
app.on(discord.messages(), (b) =>
  b
    .to('support')
    .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
    .input((event) => event.content)
    .reply(discord.replyToOriginThread())
    .where(discord.notBot())
    .context((event) => ({ channel: event.channel })),
);
```

The chain compiles to a `RuntimeBinding` and then to a `RuntimeBundle` IR. The
IR is inspectable and testable:

```ts
const bundle = app.bundle();
console.log(bundle.bindings[0].agent);
```

Slots hold resolvers, not literals. A resolver is an `(event) => value`
projection evaluated for each event. Platform packages provide factories such
as `discord.sessionKey(...)`, `discord.replyToOriginThread()`, and
`cron.schedule(...)` so platform-specific event knowledge stays in the package,
not in core.

Inbound and outbound routing are symmetric:

- `.conversation(...)` projects the inbound event to a conversation id, which
  becomes the run id that selects the checkpoint to resume.
- `.reply(...)` projects the same event to a delivery description. Sending is
  performed later by the app delivery driver and outbox, so bindings remain
  side-effect free.

The mental model is an HTTP router whose route slots are event projections
instead of fixed path strings.

## Version Gate

Checkpoint resume is invalidated by graph edits. The manifest covers graph
structure and serializable node content such as prompt text and source
configuration. Non-serializable members, including closures and provider
clients, are represented by stable stand-ins.

Closure-body edits are not detectable by the manifest hash. Durable runs that
span code edits are unsupported unless the application owns a migration path.

## Examples

```bash
pnpm -C examples build
tsx examples/chat.ts
tsx examples/autonomous_researcher.ts
```

The examples directory contains direct execution examples. The Discord and cron
packages include runtime tests and platform-specific helpers.

## Development

```bash
pnpm install -w
pnpm -r build
pnpm -C packages/core typecheck
pnpm -C packages/core vitest run src/__tests__/unit
```

Public APIs are exported from package roots or documented subpaths such as
`@prompttrail/core/codex_app_server` and `@prompttrail/core/runtime_server`.
