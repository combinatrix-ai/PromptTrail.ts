# Object model: Agent, Conversation, App, and the Model port

Decision record for the top-level object ontology — what an `Agent` *is*, what
you `send()` to, where the LLM lives — following the messaging-model.md
discussion (which fixed the *inside* of a run: inbox noun, receive verb; this
document fixes the *outside*). No backward-compatibility constraint (pre-1.0).

Legend: `[x]` decided · `[~]` proposed, awaiting review · `[ ]` open.

---

## 0. The framing problem: send to what? bind to what?

Two candidate spellings surfaced in design discussion, each committing to a
different ontology:

- `agent.send(input)` — the Agent **is** the actor, one mailbox per agent.
  Natural for a singleton personal agent (claw); breaks the moment one
  behavior serves many concurrent conversations (which conversation receives
  it?). Every actor framework resolves this with spawn → handle.
- `agent.bind(inbox)` — the Agent is a wirable component. This fuses behavior
  definition with deployment wiring; the same agent can no longer be attached
  to Discord, Slack, and a test harness without editing it. The binding DSL
  (binding-routing-dsl.md) deliberately rejected this fusion.

The codebase already has the right three-layer ontology — it just never gave
the middle layer a noun:

| Concept | What it is | Today's API |
| --- | --- | --- |
| `Agent` | **class** — immutable behavior definition (graph + tools) | `Agent.create('support')...` |
| durable run | **instance** — identity + inbox + session; the actual actor | a bare `runId` string |
| `PromptTrailApp` | **host** — store, lease, recovery, event→instance routing | `app.send({ runId })` |

`send` has no visible receiver because the instance is spelled as a string
argument. That absence — not the Agent API — is what makes `agent.send()`
feel missing.

## 1. Decisions

### [~] 1.1 Reify the instance: the conversation handle

```ts
const conv = app.conversation('ticket-42', support); // get-or-create handle
await conv.send('My order never arrived');           // deliver + run to rest
conv.status;                                          // 'suspended' | 'done' | ...
await conv.session();                                 // transcript
await conv.delete();
```

- Pure sugar over `app.send/resume/delete({ runId })` — zero runtime change;
  the per-run mutex, lease fencing, and recovery all apply beneath it.
- The Durable Objects / Akka shape: class → addressed instance → stub.
- A singleton personal agent is the degenerate case:
  `const me = app.conversation('main', claw)`.
- `agent.execute()` survives as the script/ephemeral shortcut, documented as
  "static convenience on the class", not the model.
- `[ ]` Noun: `conversation` (chat surfaces, matches the binding DSL's
  `.conversation(...)` resolver) vs `run` (jobs). Leaning `conversation` with
  `runId` kept as the underlying identity term.

### [x] 1.2 Binding stays on the host

`app.on(trigger, b => b.to(agent).conversation(...))` is an identity mapping —
*which conversation does this platform event belong to* — and inherently lives
above any single conversation. `agent.bind(...)` is rejected (§0).

### [~] 1.3 `Source.llm()` is dissolved into a `Model` port

`Source` today conflates two things: **where content comes from** (cli,
literal, list, callback — genuine content provision for user/system nodes) and
**the brain** (model + params + tools + loop policy on `Source.llm()`).
The brain is not behavior; it is an injected dependency — evidence already in
the codebase:

- claw's gate injects a mock reply source into `behavior(agent, reply)` and
  production injects the configured model: behavior fixed, brain swapped.
- The replay roadmap (B0/B1) serves model calls from a cassette — i.e. the
  model is an external served through a port, exactly like a tool.

Split:

- **`Model`** — the brain port. Provider factories `Model.openai(...)`,
  `Model.anthropic(...)`, `Model.google(...)`, `Model.mock([...])`; a spec
  carries model name + generation params.
- **`Source`** — remains, for content provision only (`Source.cli()`,
  `Source.literal()`, `Source.list()`, `Source.callback()`, ...).
- `Source.llm()` is deleted at the end of the migration (kept internal during
  it).

### [~] 1.4 Wirable but default: the model cascade

Everyday authoring never names a model:

```ts
const support = Agent.create('support')
  .system('Answer support questions.')
  .tool('searchDocs', searchDocs)
  .receive()
  .assistant();                        // bare: default brain, auto tool-loop

const app = PromptTrail.app({
  model: Model.openai('gpt-5.4-nano', { temperature: 0.2 }),
  agents: { support },
});
```

Four wiring altitudes, resolved specific → general, fail-fast at registration
when none is bound:

1. **node pin** — `.assistant('summarize', { model: Model.google('gemini-3.1-flash-lite') })`
   (multi-model graphs are a real use case)
2. **execute/run option** — `execute({ model: Model.mock(['ok']) })` — tests,
   the claw gate, evals, replay cassettes
3. **agent default** — `Agent.create('x', { model: ... })` — the author's
   recommendation
4. **app default** — deployment fallback

### [x] 1.5 What moves off the old `Source.llm()`

- **Tools** — already agent capabilities via `.tool()`; `addTool` on the
  source disappears. Vendor-loop consent is a node option:
  `.assistant({ toolLoop: 'vendor' })`.
- **Validation/retry** (`validate`, `maxAttempts`) — behavior semantics; move
  to node options.
- `structured` / `goal` consume the same Model cascade.

### [x] 1.6 The delegation spectrum (why `.codex()` stays a node)

LLM access today has two shapes because they differ in *how much agency is
delegated*, not by accident:

```
Model (function)            — we own loop, state, checkpoints
  + toolLoop (ai-sdk)       — we own the loop, tools surface on the session
  + toolLoop('vendor')      — provider owns the loop inside one turn
.codex() / .claude()        — provider owns a whole sub-agent turn
                              (provider session persisted, reconnect on resume)
```

The model is an injected service; **the degree of delegation is declared at
the node**. `.codex()`/`.claude()` remain nodes at the far end of the
spectrum; their transports can later join the app-default cascade.

## 2. The completed mental model

```
Agent        = class     (prompt structure + tool capabilities)
Conversation = instance  (identity + inbox + session)  … conv.send() / conv.receive-side is messaging-model.md
App          = host      (store, lease, recovery, bindings, default Model)
Model        = port      (node > execute > agent > app)
```

## 3. Migration (staged with messaging-model.md as one "authoring v2" wave)

1. Introduce `Model` + cascade + bare `.assistant()`; `Source.llm()` becomes
   an internal adapter.
2. Migrate README/examples/tests/claw; move tools/validation off sources.
3. Delete `Source.llm()` (MIGRATION.md one-liners; version gate invalidates
   old checkpoints once, shared with the receive() wave).

## 4. Open questions

- [ ] Handle noun: `conversation` vs `run` (§1.1).
- [ ] `Model` spec shape: plain config object vs class with `.with(params)`
  refinement; how provider-specific options (headers, baseURL) ride it.
- [ ] Whether per-conversation model override (between execute and agent in
  the cascade) has a real use case — excluded until one appears.
- [ ] How the cassette/replay source (B1) presents as a `Model` implementation
  — align with the B0 recording design when it lands.
