# PromptTrail.ts

PromptTrail.ts is a TypeScript framework for building LLM conversations and
event-driven agents that survive restarts. You describe a conversation as a
typed, composable graph; PromptTrail executes it, checkpoints progress at node
boundaries, and resumes interrupted runs — with an honest durability contract
(at-least-once plus remote deduplication, never a false promise of
exactly-once).

What that buys you:

- **One authoring model.** `Agent.create('name')` builds everything from a
  three-line prompt chain to a multi-agent event-driven app. Node ids are
  optional; state is an immutable, typed `Session`.
- **Durability you can reason about.** `checkpoint:` runs persist session
  deltas, suspend mid-flow (`awaitInput`), and resume forward. Tools declare
  whether they are safe to re-run or carry an idempotency key — and the
  registration gate refuses checkpoint agents that stay silent about it.
- **An app runtime for real surfaces.** `PromptTrail.app(...)` routes platform
  events (Discord, cron, your own triggers) to agents through a declarative
  binding DSL, with delivery, presence, and conversation resume handled by the
  runtime.
- **Vendor agents as graph nodes.** `.codex(...)` and `.claude(...)` embed
  Codex App Server and Claude Agent SDK turns, including provider-session
  reconnect on resume.

Sections: [Installation](#installation) · [Quick Start](#quick-start) ·
[Sessions](#sessions) · [Agent Authoring](#agent-authoring) ·
[Tools and Effects](#tools-and-effects) ·
[Checkpoint Durability](#checkpoint-durability) ·
[Vendor Tool Loops](#vendor-tool-loops) · [Transforms](#transforms) ·
[Goals and Tool Loops](#goals-and-tool-loops) ·
[Structured Output](#structured-output) · [Subroutines](#subroutines) ·
[Provider Turns](#provider-turns) · [App Runtime](#app-runtime) ·
[Run Per Event](#run-per-event) ·
[Binding and Routing DSL](#binding-and-routing-dsl) ·
[Version Gate](#version-gate) · [Examples](#examples) ·
[Development](#development) · [Migration](#migration)

## Installation

```bash
pnpm add @prompttrail/core      # agents, sessions, sources, tools, checkpoint runtime
pnpm add @prompttrail/discord   # Discord trigger, delivery, presence, test adapters
pnpm add @prompttrail/cron      # cron trigger and test helpers
```

Platform packages implement core's generic `Trigger<TEvent>` contract — adding
a new platform does not require editing core.

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

To feed runtime input instead of hardcoding the user message, consume it with
an `inbox` node:

```ts
const assistant = Agent.create('support')
  .system('Answer the latest inbound user message.')
  .inbox()
  .assistant(Source.llm());

const session = await assistant.execute({
  input: 'What is the status of my order?',
});
```

## Sessions

A `Session` is the immutable conversation value: messages plus typed `vars`.
Every change returns a new session, so handlers can never corrupt shared
state:

```ts
import { Session, type Vars } from '@prompttrail/core';

const session = Session.create<Vars<{ userId: string }>>({
  vars: { userId: 'u-1' },
});
const next = session.withVar('plan', 'pro'); // new session; original untouched
next.getVar('userId'); // typed: string
```

Type the vars on the agent when handlers read them —
`Agent.create<Vars<{ userId: string }>>('name')` — and `session.getVar(...)`
stays checked end to end. Sessions also carry a monotonic `version` used
internally as the checkpoint delta pointer and the default effect-memo
dependency.

## Agent Authoring

Node ids are optional. A single string passed to `.system(...)`, `.user(...)`,
`.assistant(...)`, or `.goal(...)` is content, not an id; a single function or
`Source` is the content provider:

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

Derived ids follow structural position (`assistant-1`, `assistant-1-loop`,
...). Inserting, removing, or reordering nodes shifts them — which
intentionally invalidates checkpoint resume through the version gate. Write
explicit ids for long-lived checkpoint runs, loops, and suspend points; the
runtime warns at registration when a resume-sensitive node (such as
`awaitInput`) has a derived id.

The full vocabulary:

- Leaf nodes: `system`, `user`, `assistant`, `transform`, `inbox`,
  `awaitInput`, `tools`, `structured`
- Containers: `loop`, `conditional`, `subroutine`, `parallel`
- Intent and provider turns: `goal`, `codex`, `claude`

If you knew an earlier API (`quick`, `turn`, `repeat`, `sequence`, `patch`,
`messages`, ...), see [MIGRATION.md](MIGRATION.md).

## Tools and Effects

Tools are model-callable effect boundaries. A tool declares one of two things
about its effect:

```ts
import { Tool } from '@prompttrail/core';
import { z } from 'zod';

// Safe to re-run: reads, pure computation, idempotent calls.
const searchDocs = Tool.create({
  name: 'searchDocs',
  description: 'Search documentation.',
  inputSchema: z.object({ query: z.string() }),
  effect: { repeatable: true },
  execute: async ({ query }) => searchDocumentation(query),
});

// Must be deduplicated: the key may depend on the input.
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

The axis is _must-dedup_ versus _repeatable_, not read versus write — an
idempotent PUT is repeatable; a counter increment must be deduplicated. For
keyed tools the resolved key becomes the local memo identity and arrives in
the tool body as `ctx.idempotencyKey`; forward it to the remote system, which
is where effective-once is actually enforced.

Under ephemeral execution declarations are optional. Under checkpoint
execution they are required: registering a checkpoint agent whose tool
declares neither form is a hard error at registration time, not a surprise at
resume time.

## Checkpoint Durability

A checkpoint run persists progress at node boundaries and can suspend mid-flow
and resume later — across process restarts, given a persistent store:

```ts
import { Agent, Source, memoryStore } from '@prompttrail/core';

const store = memoryStore();

const support = Agent.create('support')
  .system('Collect the order id, then resolve the issue.')
  .inbox('issue')
  .assistant('clarify', Source.llm())
  .awaitInput('order-id')
  .assistant('resolve', Source.llm());

const first = await support.execute({
  runId: 'ticket-42',
  input: 'My order never arrived.',
  checkpoint: store,
});
// first.status === 'suspended', first.awaiting === 'support/order-id'

const done = await support.execute({
  runId: 'ticket-42',
  input: 'Order #1234',
  checkpoint: store,
});
// done.status === 'done'; done.session has the full conversation
```

With a `checkpoint` option, `execute` returns the run envelope
`{ status, runId, session, awaiting? }`; without one it returns the `Session`
directly. `checkpoint: true` uses the ambient app store (and fails fast with
guidance when there is none). Stores persist session _deltas_ — appended
messages and var diffs — not full-session rewrites.

The guarantee is honest and intentionally limited:

- Checkpoint resume gives **at-least-once** effect execution: completed nodes
  are skipped on resume, incomplete nodes may re-run.
- Keyed tools are memoized locally (`once`) after the effect commits, but the
  crash window between a remote commit and the local persist cannot be closed
  locally. **Effective-once requires the remote system to honor the
  idempotency key.**
- The runtime orders effect → memo → persist and awaits persistence at effect
  boundaries, so a committed write is never silently dropped — but the local
  store and a remote service are never atomically coordinated.
- PromptTrail does not provide exactly-once delivery or exactly-once external
  effects. Nothing does without the remote system's cooperation.

## Vendor Tool Loops

Some surfaces let the _vendor_ own the tool loop: `.codex(...)`,
`.claude(...)`, and the native provider adapters (OpenAI Responses, Anthropic
Messages, Gemini) when the source carries tools. Inside a vendor loop, tool
calls execute within the provider turn — they do not appear on the session as
`toolCalls`/`tool_result` messages, and they sit outside the local `once`
memo. An interrupted turn re-runs wholesale on resume: best-effort and
self-healing, not a durable local boundary. `ctx.idempotencyKey` still reaches
tool bodies, so remote deduplication keeps working.

Under checkpoint execution this trade-off must be explicit. A native-adapter
source with tools fails registration unless you either acknowledge it:

```ts
Source.llm().openai().toolLoop('vendor').addTool('searchDocs', searchDocs);
```

or switch to the ai-sdk adapter, which surfaces tool calls and results on the
session where the graph (and the checkpoint machinery) can see them:

```ts
Source.llm().openai({ adapter: 'ai-sdk' }).addTool('searchDocs', searchDocs);
```

## Transforms

`transform` is the single programmatic node. The pure form is synchronous by
type — IO cannot be awaited into an undeclared step, and a handler returning a
Promise throws:

```ts
const agent = Agent.create('with-vars')
  .transform((session) => session.withVar('attempt', 1))
  .assistant('Ready.');
```

Declaring an effect unlocks the async form, with `ctx.once` and
`ctx.idempotencyKey` available — this is the graph-invoked effect step (tools
remain model-invoked):

```ts
import { type Vars } from '@prompttrail/core';

const agent = Agent.create<Vars<{ userId: string }>>('fetch-profile').transform(
  { effect: { repeatable: true } },
  async (session) => {
    const profile = await fetchProfile(session.getVar('userId'));
    return session.withVar('profile', profile);
  },
);
```

Decision handlers — `conditional` and `loop` conditions, `goal.isSatisfied` —
are synchronous for the same reason. Fetch in a tool or an effect transform,
store the result in the session, then branch.

## Goals and Tool Loops

`goal(...)` is the intent-level API: state what must be achieved and let the
compiled graph loop tools and model turns until satisfied.

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

A top-level `assistant(...)` on an agent with registered tools gets the same
treatment automatically: it compiles to `assistant` plus a tool loop with
deterministic node ids. PromptTrail owns the loop — there is no hidden
provider-internal looping on this path. When you need direct control, write
`loop(...)` and `tools(...)` yourself; the sugar steps aside if a manual loop
follows.

## Structured Output

`structured` nodes validate the model's answer against a schema and expose the
parsed value. Inside a graph, prefer the fold form: the parsed object is passed
directly from the structured node to your callback, and the assistant message
still records the original `structuredContent` for transcript/UI use.

```ts
import { Agent, type Vars } from '@prompttrail/core';
import { z } from 'zod';

const triageSchema = z.object({ category: z.string(), urgent: z.boolean() });
type TriageVars = Vars<{ triage?: z.infer<typeof triageSchema> }>;

const classifier = Agent.create<TriageVars>('classifier')
  .inbox()
  .structured('triage', triageSchema, (triage, session) =>
    session.withVar('triage', triage),
  );

const session = await classifier.execute({
  input: 'My payment failed twice!',
});

const triage = session.getVar('triage');
// triage: { category: string; urgent: boolean } | undefined
if (triage?.urgent) escalate(triage.category);
```

Use `session.getStructured(schema)` when you are away from the data-flow, such
as at an API boundary reading a revived session. It scans backward for the
latest structured payload and re-validates it with the schema:

```ts
const latestTriage = session.getStructured(triageSchema);
// latestTriage: { category: string; urgent: boolean } | undefined
```

## Subroutines

`subroutine(...)` is an isolation boundary. By default it enters with a fresh
session and, on exit, appends the subroutine's messages to the parent while
keeping parent vars unchanged — re-establish system prompts inside, or project
state explicitly with `init` and `squash`:

```ts
import { type Vars } from '@prompttrail/core';

const agent = Agent.create<Vars<{ draft: string }>>('review').subroutine(
  'draft-review',
  (draft) =>
    draft
      .system('Review the draft in isolation.')
      .user('Please check tone and clarity.')
      .assistant(Source.llm()),
  {
    init: (parent) => parent.withVars({ draft: parent.getVar('draft') }),
    squash: (parent, sub) =>
      parent.withVar('review', sub.getLastMessage()?.content ?? ''),
  },
);
```

## Provider Turns

`.codex(...)` runs a Codex App Server turn; `.claude(...)` runs a Claude Agent
SDK turn. The provider owns its internal loop, so PromptTrail cannot
checkpoint inside the turn. Instead, under checkpoint execution the provider
thread/session id is persisted the moment the provider returns it, and resume
reconnects to the same provider session.

When reconnect is impossible (expired thread, refused resume), the default is
fail-fast. Restarting the whole turn re-runs any vendor-internal tool side
effects, so it is opt-in:

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

## App Runtime

Apps connect triggers to agents. Defaults are constructor-only; per-binding
needs are expressed on the binding, not by mutating app state:

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
  defaults: { checkpoint: true },
  adapters: [discordGateway({ token: process.env.DISCORD_TOKEN })],
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

`app.on(trigger, builder)` wires an event source to an agent;
`app.gateway(...)` registers custom inbound gateways, `app.delivery(...)`
delivery drivers, and `app.presence(...)` typing/processing indicators.

## Run Per Event

The standard event-driven shape is one run per inbound event: an agent handles
one event, reaches the end of its graph, and stops. Continuity lives in the
app layer — the binding's `.conversation(...)` resolver maps related events to
the same conversation id, so the next event resumes the checkpointed
conversation.

Do not model a chat bot as an infinite graph loop that waits forever. Use
`awaitInput` only for mid-flow suspension, such as a clarifying answer the
current flow needs before it can finish.

## Binding and Routing DSL

A binding is a pure transform from a platform event to a normalized routing
decision. The fluent chain fills slots in a record — it is not an ordered
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

Slots hold resolvers — `(event) => value` projections evaluated per event.
Platform factories such as `discord.sessionKey(...)` and `cron.schedule(...)`
produce those resolvers, so platform knowledge stays in the platform package.
The chain compiles to a `RuntimeBinding` and into the `RuntimeBundle` IR,
which is inspectable and testable:

```ts
const bundle = app.bundle();
console.log(bundle.bindings[0].agent);
```

Inbound and outbound routing are symmetric: `.conversation(...)` projects the
event to the conversation id that selects the checkpoint to resume;
`.reply(...)` projects the same event to a delivery description, executed
later by the delivery driver and outbox so bindings stay side-effect free. The
mental model is an HTTP router whose route slots are event projections instead
of fixed path strings.

## Version Gate

Checkpoint resume is invalidated by graph edits — a silent half-old/half-new
run is worse than failing fast. The manifest hash covers graph structure and
serializable node content (prompt text, source configuration, effect
declarations); non-serializable members such as closures and provider clients
are represented by stable stand-ins, and secret-bearing config reduces to
edit-detecting digests rather than plaintext.

One documented limit: closure-body edits are invisible to any hash. Durable
runs that span code edits are unsupported unless the application owns a
migration path.

## Examples

```bash
bun run examples/chat.ts
bun run examples/autonomous_researcher.ts
bun run examples/coding_agent.ts
```

[examples/customer-support-chat](examples/customer-support-chat) is the
React/Next integration example for durable, server-owned conversations, and
choice buttons via `structured` plus `awaitInput`.

[examples/readme_snippets.ts](examples/readme_snippets.ts) mirrors the code
blocks in this README and is typechecked by `pnpm -C examples typecheck` —
update both together.

## Development

```bash
pnpm install -w
pnpm -r build
pnpm -C packages/core typecheck
pnpm -C packages/core vitest run src/__tests__/unit
```

Public APIs are exported from package roots or documented subpaths such as
`@prompttrail/core/codex_app_server` and `@prompttrail/core/runtime_server`.
Design decisions live in `design-docs/`, including the binding/routing model
(`design-docs/binding-routing-dsl.md`).

## Migration

There is no backward-compatibility layer. [MIGRATION.md](MIGRATION.md) lists
every rename and removal from earlier APIs, one line each.
