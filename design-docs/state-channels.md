# State channels: vars / attrs / structuredContent / context

Decision record for simplifying the typed-JSON state surface. Outcome of a
grounded census (every read/write site across core + examples + packages) plus
an adversarial review of the synthesis. No backward-compatibility constraint
(pre-1.0).

Legend: `[ ]` todo · `[x]` done.

---

## 0. The framing bug: these four are not four of a kind

"Reduce 4 typed-JSON channels to N" conflates three orthogonal axes. Classify
first:

| Channel             | Scope       | Persisted into the Session checkpoint?                                                                             | Typed how                                                                 | What it actually is                                                                                     |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `vars`              | session/run | **Yes** — diffed into `SessionCheckpointDelta` (varsSet/varsDeleted), rehydrated by `applySessionCheckpointDelta`  | container generic `Session<TVars>` (erased to `Record` at every boundary) | the one session-scoped typed application store                                                          |
| `attrs`             | per-message | **Yes** — rides on the plain message through `toJSON`/`fromJSON`; inbound persisted in `attrs_json`                | container generic `Message<TAttrs>` / 2nd param of `Session`              | a per-message keyed bag, mostly provider bookkeeping by string convention                               |
| `structuredContent` | per-message | **Yes** — message field, serialized verbatim                                                                       | untyped `Record` at rest; schema recovered at read via `getStructured`    | a per-message keyed payload that happens to carry a schema                                              |
| `context`           | run         | **No** — own `StoredRun.context` / `context_json` column, **re-injected** at resume, never folded into the Session | open `Record` with a few named keys                                       | dependency injection: delivery/toolsets/skills/workdir + host wiring (non-serializable, secret-bearing) |

Two facts follow:

- **`context` is not session state.** It is durably stored for crash-resume
  fidelity but lives on a separate run record and is re-supplied at resume, not
  reconstructed from the conversation. Merging it into the persisted channels
  would corrupt checkpoints or leak secrets. Different category entirely.
- **`structuredContent` and `attrs` occupy the same cell** (per-message +
  persisted), distinguished only by "does the key carry a schema."

**The honest reduction target is not the channel count — it is the
_masquerading_:** `TAttrs` is a generic that looks like type safety but isn't
(the framework casts around its own type), and `context` is filed next to
vars/attrs as if it were a fourth data channel when it is dependency injection.
The author-facing simplification is mostly a **documentation** fact:

> An application author touches **one** state channel: `vars`. `attrs` is
> framework plumbing, `context`/`services` is host injection, structured output
> is read via the structured node's fold callback. The rest is plumbing you
> rarely name.

`vars` and `messages` are irreducible. We do **not** merge vars+attrs (scope,
lifecycle, and owner all mismatch — see §5).

---

## 1. Evidence (grounded census)

- **`TAttrs` is a phantom generic.** ~904 refs in core, almost all mechanical
  `Session<TVars,TAttrs>` / `Message<TAttrs>` propagation. **0** author typed
  reads (the 7 `withAttrsType` calls live in one demo + tests and never read a
  typed value). The two real author read sites (`packages/discord/src/testing.ts`,
  `claw/src/index.ts`) bypass `TAttrs` with local `as Record` casts. Every
  framework read site (`toolCallId`, `openai.*`, `codex.threadId`,
  `claudeAgent.sessionId`, `*.replayRequired`, `google.cachedContent`) first
  throws the type away with `attrs as Record<string,unknown>`, then string-probes
  hard-coded keys. Every write force-casts back: **20 casts, 8 of them
  `as unknown as TAttrs`.** The generic delivers checked typing to no one while
  parameterizing dozens of signatures — including the **exported** extension API
  (`interceptors.ts` ~134 refs: `ExecutionPhaseContext`, `ExecutionWrapperNext`,
  `ExecutionPatch`, `Hook`, `Middleware`) and the **durable types**
  (`StoredRun<TVars,TAttrs>`, `SessionCheckpointDelta<TVars,TAttrs>`,
  `ResolvedSessionDelta<TAttrs>`, `DurableRunStore`).
- **`vars` earns its keep** as the only first-class persisted application store
  (written by provider turns, merged across parallel/subroutine, diffed into
  deltas, read by `${...}` interpolation). The `TVars` generic is also erased at
  runtime, but it composes through the Agent builder and gives real
  `getVar('key')` autocomplete — keep it, understood as a convenience generic.
- **`context` is healthy** as the DI seam: own `context_json` column, injected
  at resume via `cloneDurableRuntimeValue(run.context)`, never in the delta. The
  `channelPrompt` field demotion (commit `9929d09`) set the precedent — named
  keys only when core reads them.
- **`structuredContent`** is written by the Structured node, by Assistant nodes
  whose source is schema-configured, by Parallel aggregation, and by tool_result;
  read by `session.getStructured(schema)` which re-validates after revival.

---

## 2. Decisions

### [x] 2.1 `.structured(schema, fold)` — the 2-arg fold is structured + transform sugar

The 2-arg form is **literally** sugar for `.structured(schema)` followed by a
fold step. Nothing new: the structured node produces output onto the message,
the fold consumes it. The callback receives the parsed object **by data-flow**
(the node knows what it just produced — no session scan), plus the session:

```ts
// 1-arg: run structured generation, write structuredContent on the message
agent.structured('triage', triageSchema);

// 2-arg sugar: structured + fold. `obj` arrives by data-flow, fully typed.
agent.structured('triage', triageSchema, (obj, session) =>
  session.withVar('triage', obj),
);

// full template form: custom source / retry config
agent.structured('triage', Structured.withSource(modelSource, triageSchema));
```

It is **not** a `transform` (transforms get only `(session, ctx)`, no Source, so
they cannot run a schema-constrained generation; and folding the schema into a
transform closure would move it out of the hashed manifest — see §5). It is a
Structured node whose output is threaded into the fold callback.

**Two homes is correct, not a hazard.** After the 2-arg form runs:

- `message.structuredContent` = **immutable record of what the turn produced**
  (the wire/UI/transcript representation; the demo renders choice buttons from it).
- whatever the callback wrote (e.g. `vars.triage`) = **current working value**
  (graph logic reads it).

These answer different questions, so there is no reconciliation rule to invent
and no "which is canonical" ambiguity: the message records history, the var is
mutable current state, and they are _supposed_ to be able to diverge (just as
message history generally diverges from current vars). This is exactly what
hand-writing the two nodes produces; nobody calls that a dual-write hazard.

The `into: 'varName'` string alias is **rejected** — a callback is explicit and
avoids the same-name collision the alias hides.

**Read side:** the fold callback's `obj` is the clean intra-graph read (data-flow,
no scan). `session.getStructured(schema)` (session-wide backward scan) stays for
reads far from the data-flow / at the API boundary, but is **demoted in the docs**
to "latest-matching scan — prefer the fold callback inside the graph, and explicit
message addressing at the boundary." (A `message.getStructured(schema)` explicit
reader may be added later if a boundary needs it; not required now.)

### [ ] 2.2 Drop the `TAttrs` generic — keep the channel, kill the type parameter

`Session<TVars>` and `Message` lose their second generic; `attrs` becomes a plain
`Readonly<Record<string, unknown>>` bag. Delete `withAttrsType` (all overloads),
the `Attrs<T>` helper, and the `Message<TAttrs>` thread. The 20 casts collapse:
read sites already do `attrs as Record`, write sites already build `Record`.

**This is a breaking change to the exported extension API** (interceptor/hook/
middleware signatures lose a type parameter) and ripples through the durable
types and the `DurableRunStore` interface. Permitted by the no-compat charter,
but it is **not** "pure cleanup, no behavior change" — scope it as a deliberate
public-API break. On-disk bytes are unaffected (attrs were always erased-to-data
JSON), so SQLite round-trip and the rewrite/squash path are unchanged.

Do **not** add a `messageAttr()` typed-key helper now. The census shows zero
demand (0 author typed reads), it overlaps `getStructured`, and `message.ts`
already carries `setAttrs`/`expandAttrs`/`setStructuredContent`. Revisit only when
a real consumer appears — and if so, consolidate the existing mutators in the
same stroke.

### [ ] 2.3 Promote `toolCallId` to a first-class message field

The one attr key the framework reads on a hot path on every provider is
`toolCallId` (tool-result correlation: `generate.ts`, all three provider
adapters). Lift it out of the bag onto `ToolResultMessage`:

```ts
interface ToolResultMessage extends BaseMessage {
  type: 'tool_result';
  toolCallId?: string; // first-class; provider adapters read message.toolCallId
}
```

**This is a persistence migration, not a free model tweak:** existing durable
runs store `toolCallId` inside `attrs_json`. `Session.fromJSON` must read the
field, falling back to `attrs.toolCallId`, so old checkpoints (incl. the demo's
`.data/support.db`) still resume. Everything left in `attrs` is then genuinely
open provider metadata keyed by the namespaced-string convention, which is the
correct shape for an open multi-producer bag.

### [ ] 2.4 Rename `context` → `services`

`context` is the most overloaded word in the codebase (it collides with
`ToolExecutionContext`, the transform `ctx`, React-style mental models) and it
files DI next to vars/attrs as if it were a fourth state channel. Rename the
author-facing knob **and the internals** (`RuntimeDispatchContext`,
`context_json` column, `cloneDurableRuntimeValue`, the ~49 refs) to `services`
(chosen over `deps`, which collides with npm dependencies, and `runtime`, which
collides with `ExecutionRuntimeState`). Renaming the public name alone would
reintroduce the same public-vs-internal naming gap, so rename through.

It stays a separate, non-checkpointed channel — that non-persistence is the
entire point. The demo's `.data/support.db` is disposable, so the column rename
is free here.

---

## 3. What an author sees, before vs after

|                                    | Before                                                                                                                             | After                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| State channels an app author names | vars + attrs (typed!) + structuredContent + context = perceived 4, with the TAttrs/structuredContent overlap as the confusing part | **`vars`** (the one you own) + structured output read via the fold callback; `attrs` is plumbing; `services` is clearly host DI |
| Type parameters on `Session`       | `Session<TVars, TAttrs>`                                                                                                           | `Session<TVars>`                                                                                                                |
| Reading structured output in-graph | `session.getStructured(schema)` (icky session scan)                                                                                | fold callback `obj` (data-flow)                                                                                                 |

Honest accounting: the **author-facing** win is mostly the reframing (docs) plus
removing the `Session<,TAttrs>` noise and the icky in-graph scan. The
**maintainer-facing** win is large: ~904 propagation sites and 20 casts gone, one
fewer generic on every signature.

---

## 4. v1 (now) vs v2 (event-log)

**v1 — these decisions.** Pure model/vocabulary changes, no storage rewrite:
2.1 (additive sugar), 2.2 (generic removal — breaking but mechanical), 2.3
(field promotion + fromJSON fallback), 2.4 (rename). Independent of the event-log
because every persistence path already treats attrs/structuredContent as opaque
JSON — erasing `TAttrs` changes zero serialized bytes.

**v2 — the event-log.** Fold `messages` and `vars` into projections over an
append-only event log; `attrs`/`structuredContent` become event kinds
(`Annotate{messageRef,key,value}`, `StructuredEmitted{messageRef,schema,value}`).
That collapses the _storage_ multiplicity and gives replay/audit/time-travel for
free. **Unstated prerequisite (found in review):** messages currently have **no
durable, rewrite-stable identity** — they are addressed positionally and
wholesale-replaced on rewrite/squash, so event kinds cannot be anchored to a
`messageRef` without first introducing stable message ids. That is a real schema
migration, not a free projection. v2 does not reduce the _read_ surface (authors
still read `session.messages` / `session.vars` as views) — its win is storage,
not API. So v1 stands on its own and is a prerequisite, not throwaway.

---

## 5. Rejected alternatives (with reasons)

- **Merge `vars` and `attrs`.** Three mismatches: _scope_ (one run-value vs
  per-message), _lifecycle_ (diffed into the delta via varsSet/varsDeleted vs
  riding immutably on appended messages — two distinct reducers / two SQLite
  columns), _owner_ (vars has one coherent owner → a container generic is right;
  attrs is open multi-producer → a typed-key reader is right; merging gets the
  worst of both — the LangChain `additional_kwargs` rot).
- **Fold `structured` into `transform`.** Eliminates no concept (structuredContent
  is still written by Assistant/Parallel/tool_result independently; `getStructured`
  is still the reader for those) and _weakens_ two guarantees: `Structured`
  hashes its Zod schema into the durable manifest (`getManifestDescriptor` →
  version gate), whereas a transform's descriptor is an opaque closure the gate
  cannot prove changed; and `Structured` carries `maxAttempts`/`mode` retry
  semantics a transform lacks.
- **Merge `context` into `vars`.** Would persist non-serializable handles and
  secrets into the checkpoint. The whole point of `context`/`services` is that it
  is re-injected at resume, never serialized into the Session.
- **Add `messageAttr()` typed-key helper.** Zero demand (0 author typed reads),
  overlaps `getStructured`, adds API to a pre-release surface for a user the
  census proves does not exist.
- **`session.getStructured` as the primary read.** It is an ambient session-wide
  backward scan — neither data-flow nor explicit addressing. The 2-arg fold's
  `obj` replaces it for the common case; demote it in docs.
