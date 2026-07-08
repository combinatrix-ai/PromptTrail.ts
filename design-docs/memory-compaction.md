# Memory: append-only compaction and the observation log

Design record for conversation memory (prompt-side) and delta-chain compaction
(storage-side) — one mechanism, two pressures. Prerequisite for claw roadmap
item 4. Follows the rule fixed in `positioning-and-claw-roadmap.md` §Memory:
**summarization must not rewrite history**. No backward-compatibility
constraint (pre-1.0).

Legend: `[x]` decided · `[ ]` open.

---

## 0. Two growth problems, one append-only answer

| Pressure | Symptom | Where it bites |
| --- | --- | --- |
| Prompt growth | long conversations exceed the model context; every turn pays the full history | `Source.llm` prompt assembly |
| Storage growth | the session delta chain and per-run documents grow without bound; lazy backends re-fold every delta on every read; redis re-serializes the whole doc per append (O(N²) total) | all five store backends |

Both are solved by the same shape: **append a summary, advance a pointer,
never delete or rewrite what the pointer passed** — Mastra's Observational
Memory translated into the checkpoint model. The prompt-side pointer and the
storage-side snapshot are two consumers of one compaction event.

Constraints this must respect (all load-bearing today):

- `session.messages` is the at-rest truth under the checkpoint model; hooks
  and `once` dependencies may key on session version/lineage
  (`adoptSessionResult`, delta chaining by `version`). Append-only preserves
  lineage; rewriting breaks it.
- Prompt cacheability comes from an append-only prefix.
- The recording/replay roadmap (B0+) will treat the transcript as the golden
  record; a rewritten transcript cannot be a golden record.

## 1. The observation log

`[x]` **1.1 Representation: messages with a reserved attr, not a new store
collection.** A compaction appends an ordinary message —
`Message.system(summaryText, { 'memory.observation': true, 'memory.through': v })`
— to the session. It rides the existing delta/persist/reconstruct machinery in
all five backends for free, survives cold restart, and is visible to
replay/recording as part of the transcript. A separate collection would need
new store ops across five backends and would hide the summary from the
transcript it summarizes.

`[x]` **1.2 The context-assembly pointer.** A session-level field
`compactedThrough: number` (message index or session version — decide with the
implementation, version preferred since deltas key on it) advanced by the same
compaction step, persisted as a var-like part of the delta (`varsSet` is
sufficient: a reserved `memory.compactedThrough` var; no session schema
change).

`[x]` **1.3 Prompt assembly rule.** When building the model prompt,
`Source.llm` (and the provider turns) assemble: system prompts + observation
messages + messages after `compactedThrough`. Raw messages before the pointer
leave the **prompt**, never the **journal**. One cache miss per compaction
(the assembled prefix changes once), then stable again — acceptable and
documented.

## 2. The compaction step

`[x]` **2.1 An explicit, checkpointed keyed effect.** Compaction runs as an
effect transform with `idempotencyKey: 'memory.compact:' + throughVersion` —
the summarizer LLM call is an external effect and must not double-run on
retry/resume; the once-memo covers it. It appends the observation message and
advances the pointer in one session transition (one delta).

`[x]` **2.2 Trigger policy lives in the app, mechanics in core.** Core ships
the `compact` primitive (given a summarizer `Source<string>` and a range);
the app decides *when*: `PromptTrail.app({ memory: { compactAfterMessages?,
compactAfterEstTokens?, summarizer? } })` checks the policy at terminal
boundaries (post-completion/suspension — never mid-node) and enqueues the
compaction as the first step of the next resume. Token estimation is a cheap
chars/4 heuristic; precision is not required for a threshold.

`[ ]` **2.3 Summarizer prompt ownership.** Framework default prompt
(structured: facts, open loops, user preferences) vs app-supplied. Default in
core, overridable; claw supplies a persona-aware one. Decide at
implementation.

## 3. Storage snapshot (the second consumer)

`[x]` **3.1 Snapshot = rewrite delta, an existing concept.** The store already
understands a `rewrite` delta that replaces the folded session. Storage
compaction folds the chain prefix ≤ version V into one rewrite delta and
deletes the older delta rows — the folded value is identical by construction,
so this is invisible to readers and needs **no new store semantics**, only a
maintenance op: `compactDeltas(runId, throughVersion, fence?)` implemented per
backend + a conformance case asserting fold-equivalence and idempotency.

`[x]` **3.2 Decoupled from prompt compaction.** Storage snapshotting is safe
at ANY version (it's a pure fold); running it at the observation-log boundary
is merely convenient. The app runs it opportunistically after 2.1 commits.

## 4. claw tie-in (roadmap #4)

- The observation log doubles as **conversation-scoped facts**: claw's
  summarizer prompt extracts durable facts (preferences, standing context);
  skills read them from the observation messages (they are in the session).
- No skill-visible new API needed for Phase 2 of skills; a later `!memory`
  supervisor command can print the observation log for a conversation.

## 5. Open questions

- [ ] `compactedThrough` as version vs message index (lean version).
- [ ] Whether provider turns (`.codex()`/`.claude()`) need their own pointer
  handling — they carry provider-session state and may not accept a shrunken
  transcript silently; likely exempt them (compaction skips runs suspended
  inside a provider turn).
- [ ] Observation-message chunking: one growing summary vs periodic discrete
  entries (lean discrete entries — append-only, no rewrite of the previous
  summary, matches Mastra's log shape).
- [ ] Interaction with `getStructured` backward scan (it scans raw messages —
  unaffected since nothing is deleted, but document that structured payloads
  before the pointer still resolve).

## 6. Rejected alternatives

- **Rewrite/squash history** — breaks lineage keys, delta chaining, prompt
  cache, and the future golden-record replay corpus. Excluded by charter.
- **Separate observation store collection** — five backends of new ops to
  hide the summary from the transcript it belongs to.
- **Compact mid-run** — a session transition outside a node boundary would
  bypass the checkpoint contract; terminal boundaries only.
- **RAG/semantic recall now** — commodity, low priority per the roadmap;
  buildable later as a source/middleware without new core machinery.
