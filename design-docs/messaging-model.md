# Messaging model: inbox and receive

Decision record for unifying how inbound messages reach an agent. Outcome of a
grounded read of the executor and store (every consumption site cited) plus a
usage census. No backward-compatibility constraint (pre-1.0). Design only —
implementation is staged separately.

Legend: `[x]` decided · `[ ]` open.

---

## 0. The framing problem: three spellings, two waiting mechanisms

An inbound message (`Inbound`, `durable.ts:67-72`) is delivered into a run's
per-run queue (`StoredRun.inbox`) by `app.send(...)`, `execute({ input })`, or
a gateway event through a binding. The graph consumes it through a cursor
(`consumeInbox`, `graph_executor.ts:1300-1322`). Today there are **three node
spellings of "consume the next inbound message"**, differing only in what
happens when the queue is empty:

| Node                          | Next message queued        | Queue empty                  |
| ----------------------------- | -------------------------- | ---------------------------- |
| `.inbox()`                    | consume → user message     | silently no-op (`:409-411`)  |
| `.awaitInput()`               | consume → user message     | **suspend** (`:427-439`)     |
| `.awaitInput({required:false})` | consume → user message   | silently no-op               |
| `.user()` (no content)        | consume → user message     | silently no-op (`:700-714`)  |

So `inbox()` ≡ bare `user()` ≡ `awaitInput({required:false})`, three times
over. And the two distinct names point the wrong way:

- **`inbox`** names the *queue* (a noun), but the node performs a *receive*
  (a verb). Authors read "place an inbox here" when the semantics are "take
  one message out".
- **`awaitInput`** says *wait*, but it does not wait when a message is already
  queued — it consumes immediately. Its actual semantics are
  consume-or-suspend.

On top of the node-level confusion sit **two mechanisms for "wait for the next
user message"**:

1. **Run-per-event** (the documented standard shape): the graph ends, and the
   binding's `.conversation(...)` key routes the next platform event into a
   resume of the same conversation.
2. **Mid-flow suspension**: `awaitInput` suspends inside the graph until the
   next send.

These answer different lifecycle needs (conversation boundary vs. a clarifying
question the current flow needs before it can finish), but the README can only
express the distinction as a choice between confusingly-named nodes.

One more implicit behavior, currently documented nowhere: when a graph run
**completes** with messages still queued, the remainder is bulk-appended to the
transcript (`materializeRemainingInbox`, `graph_executor.ts:259,270,1324-1330`)
— arrived-but-never-consumed messages do not linger invisibly.

## 1. Evidence (census)

- `.inbox(` — 14 non-test sites (README, examples, claw, docs) + 21 test sites.
- `.awaitInput(` — 3 non-test + 19 test sites; `required: false` appears
  exactly twice.
- Bare `.user()` — 1 site, in a legacy test
  (`agent_function_based.test.ts:374`).
- `InboundKind = 'user' | 'system' | 'control'` (`durable.ts:65`): `user`
  appends a user message, `system` appends a system message, `control` is
  consumed without touching the transcript.
- The run envelope reports a suspension as `awaiting: '<agent>/<node-id>'`.

Migration is therefore modest: ~60 mostly-mechanical call sites.

## 2. The model (decisions)

### [x] 2.1 Vocabulary: inbox is the noun, receive is the verb

A checkpoint run is an actor activation. Every run has an **inbox**; `send`
and gateway events **deliver** `Inbound` messages into it; the graph
**receives** them one at a time. The queue keeps its name — `inbox` is already
the right mailbox noun, and renaming it would churn the store schema across
five backends for zero semantic gain. What changes is the *node*: the
operation gets a verb.

Outbound already has the symmetric vocabulary (`.reply(...)` on bindings, the
delivery outbox); this decision completes the inbound half.

### [x] 2.2 One primitive: `.receive(id?)`

```ts
agent
  .system('Collect the order id, then resolve the issue.')
  .receive('issue')                    // consume, or suspend until delivery
  .assistant('clarify', Source.llm())
  .receive('order-id')                 // mid-flow: suspends until the answer
  .assistant('resolve', Source.llm());
```

- Default semantics: **consume-or-suspend**. If the inbox has a next message,
  consume it (append per its kind); otherwise suspend the run at this node and
  wake on the next delivery. This is `awaitInput` today, and it is the honest
  default: "no message yet" should be a visible suspension, not a silent no-op.
- Optional input: `.receive({ wait: false })` — consume-or-skip, replacing
  `inbox()` / bare `user()` / `awaitInput({ required: false })`.
- `.inbox()` and `.awaitInput()` are **removed** (no aliases, per the
  no-compat charter). The suspension surface is otherwise unchanged: the run
  envelope still reports `awaiting: '<agent>/<node-id>'`.

### [x] 2.3 `user()` requires content

`.user(...)` writes an *authored* user message (literal or Source) and never
touches the inbox. The input-less overload is removed (1 legacy call site).
"Comes from outside" (`receive`) and "authored by the graph" (`user`) are now
different words.

### [x] 2.4 Kinds unchanged

`user | system | control` stay as-is; `receive` applies the same
kind-dependent append rules `consumeInbox` implements today.

### [x] 2.5 Completion drain stays, and gets documented

`materializeRemainingInbox` behavior is kept (unconsumed messages append to
the transcript at completion) and documented in the README Messaging section —
it is part of the delivery contract, not an implementation detail.

### [x] 2.6 README gains a "Messaging" section

One section owns the mental model:

```
platform event ─┐
app.send() ─────┼─► run inbox ─► receive() ─► transcript (user/system message)
execute({input})┘        │
                         └─ empty + receive() → run suspends (awaiting),
                            next delivery wakes it
```

plus the lifecycle guidance that currently hides in "Run Per Event": end the
graph at conversation boundaries (continuity = binding `.conversation(...)`
key); use a mid-flow `receive` only for an answer the current flow needs
before it can finish.

## 3. What an author sees, before vs after

|                              | Before                                                        | After                                  |
| ---------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| Consume next inbound         | `.inbox()` / bare `.user()` / `.awaitInput({required:false})` | `.receive({ wait: false })`            |
| Wait for input mid-flow      | `.awaitInput()`                                               | `.receive()`                           |
| Authored user message        | `.user('...')` or bare `.user()`                              | `.user('...')` (content required)      |
| Queue name                   | inbox                                                         | inbox (unchanged)                      |
| Empty-queue default          | depends on node choice                                        | suspend (visible), opt out per node    |

## 4. Migration notes (staged with implementation)

- `.awaitInput(id?)` → `.receive(id?)` — 1:1.
- `.awaitInput({ required: false })` → `.receive({ wait: false })` — 2 sites.
- `.inbox(id?)` → `.receive(id?, { wait: false })` for byte-identical
  behavior. **Audit each site**: graph-start `inbox()` under the app runtime
  always has the triggering event queued, so plain `.receive()` is usually the
  better translation — the difference only shows for a direct
  `agent.execute()` with no `input`, where old code silently continued and new
  code visibly suspends.
- Bare `.user()` → `.receive({ wait: false })` or deletion (1 legacy site).
- MIGRATION.md gets one line per rename; the version gate invalidates resumes
  across the change as usual (node type changes hash differently).

## 5. Open questions

- [ ] **Did-consume signal for `wait: false`.** A skipped optional receive is
  invisible to the graph (same as today's silent no-op). If a real consumer
  needs to branch on "was there a message", add it then (e.g. the node sets a
  session var) — not speculatively now.
- [ ] **`receive({ timeoutMs })`.** A receive that wakes with a timeout marker
  instead of suspending forever is the natural join point with durable timers
  (roadmap §Durability 3). Design it with the timer work, not before; the node
  shape reserves the option.
- [ ] **Multi-receive / drain.** A `receive({ all: true })` that consumes the
  whole queue could replace ad-hoc loops if a consumer appears. No known
  demand; completion drain covers the common case.

## 6. Rejected alternatives (with reasons)

- **Rename the queue to `mailbox`.** Churns `StoredRun.inbox`, `appendInbox`,
  store schema columns in five backends, and the conformance suite — all to
  swap one adequate mailbox noun for another. The confusion was the *node*
  borrowing the noun; fixing the verb dissolves it.
- **Keep `awaitInput` as an alias of `receive`.** Two names for one primitive
  is the bug being fixed; the no-compat charter exists precisely for this.
- **Consume-or-skip as the `receive` default.** Reproduces today's silent
  no-op trap: a graph that "worked" in the app runtime silently does nothing
  when executed directly without input. Suspension is visible, reportable
  (`awaiting`), and honest.
- **Remove mid-flow suspension and force run-per-event everywhere.** A
  clarifying question would then need its answer routed through a new run and
  state threaded manually — worse than the thing being simplified. The two
  waiting mechanisms are both real; they need one primitive and clear
  lifecycle docs, not amputation.
- **`listen` / `next` / `message` as the verb.** `listen` implies a stream
  subscription, `next` reads as an iterator, `message` is a noun again.
  `receive` is the actor-model term of art and pairs with `reply`.
