# Claw Self-Authoring: Verified Self-Improvement

## Purpose

This document designs how `claw/` grows from a fixed Discord agent into a
**meta-agent that authors, verifies, and activates its own behavior at
runtime** — the differentiator named in `positioning-and-claw-roadmap.md` §5
("Typed skill self-authoring") and summarized there as **verified
self-improvement**: Hermes's learning loop with a typechecker and test gate
where Hermes and OpenClaw have markdown prose.

It is a design-before-implementation record. Decisions that the author is
confident in are marked `[x]`; genuinely open choices are marked `[ ]` and
collected in §10.

It complements:

- `positioning-and-claw-roadmap.md` — strategic framing and the §5 sketch this
  document expands. Where the two disagree, this document is authoritative on
  mechanism, the roadmap on positioning.
- `runtime-bindings-discord-cron.md` — the binding/trigger layer a skill's
  `when` clause is built from.
- `agent-runtime-unification.md` — execution semantics (graph, manifest
  hashing, effect declarations, checkpoint durability) this design reuses.

Driving example (the user's words): *"a user in channel XXX sends an
instruction like 'when this kind of message arrives, do this' — and claw
builds that behavior."* Everything below is in service of making that loop
**safe and verified** rather than prose-injected.

---

## 1. The gap this fills

Hermes writes reusable skills from its own execution traces; OpenClaw injects
6+ markdown files into the system prompt. Both express behavior as **prose**,
so neither can guarantee a new skill typechecks, terminates, or stays within
declared capabilities before it goes live. The documented OpenClaw failure
modes — config "ball of mud", an audit finding ~36% of marketplace skills carry
injection payloads — are what prose-defined self-modification produces at scale.

PromptTrail already has the substrate to do better: a serializable
`AgentGraph`, `validateAgentGraph` / `createAgentGraphManifest`, subroutines as
first-class composable units, binary effect declarations usable as capability
bounds, and (as of the §1 durability work) a persistent `DurableRunStore`.
**The open lane is: agent behavior as typed, compiled DSL that the agent itself
writes, gated by `tsc` + `vitest` before activation.**

---

## 2. Core model: a skill is `trigger + behavior + provenance`

`[x]` A **skill** is the unit of self-authored behavior. It is a TypeScript
module, not a markdown file, with three parts:

```ts
export const trigger = {
  channel: 'XXX',                         // or a set / predicate
  when: (msg, ctx) => /* boolean */,      // match condition
};

// the behavior: a PromptTrail subroutine template
export const behavior = (agent: Agent) =>
  agent.system('...').assistant('reply', Source.llm()...);

// authored by the gate, not the human:
export const tests = (h: SkillHarness) => { /* assertions */ };
```

Decomposing the driving example:

- **"in channel XXX / when this kind of message"** → `trigger` (a routing
  predicate, conceptually the same shape as a `runtime-bindings` `.where(...)`
  clause, but carried as skill data rather than a static binding).
- **"do this processing"** → `behavior`, a subroutine (`.subroutine()` today
  lowers to a `scope` graph node — see §5 of the roadmap's "skills as
  subroutines").
- **provenance** → who authored it, the instruction/trace that motivated it,
  and the gate results — recorded so the library is auditable and prunable
  (Curator-style).

`[x]` Skills are **data the dispatcher reads**, not edits to the app's wiring.
This is the pivot the whole design rests on (§3).

---

## 3. Architecture decision: registry-dispatch, not live-binding mutation

There are two ways to add "behavior for channel XXX when PATTERN":

- **(A) Mutate the binding set at runtime.** Bindings (`.on(discord.messages())
  .where(...)`) are defined at app-construction time today. Making them mutable
  collides head-on with the manifest/version gate: a self-improving agent edits
  its graph constantly, and long-lived conversations would fail-fast on version
  mismatch (the roadmap's open question). Rejected for v1.

- **(B) Keep one static graph; grow a skill *registry* the dispatcher reads.**
  Recommended.

`[x]` **Decision: (B).** Claw's object-layer graph is fixed:

```
inbox('message')
  → dispatch            // transform: look up the first skill whose trigger matches
  → conditional(matched)
       then: run the matched skill's subroutine (by id/hash)
       else: default reply (today's echo/openai/codex node)
```

Adding a skill = **inserting a registry row**, not recompiling the graph. The
parent graph's manifest hash is stable, so existing conversations keep
resuming. "claw本体 = meta-agent + dispatcher" becomes literally true: the
dispatcher is the object layer, the authoring subroutine is the meta layer, and
the registry is the seam between them.

`[x]` The skill `behavior` is a **subroutine whose manifest hash is excluded
from the parent graph's manifest** (the §5 escape hatch). Skills evolve without
invalidating the parent's resume identity. See §8.

---

## 4. The self-authoring loop (the meta layer)

```
1. Instruction arrives in a privileged authoring channel (§7 authorization).
2. Interpret → a skill spec: { trigger, behavior intent, examples }.
3. Synthesize code → a TS skill module (trigger + behavior + tests),
   written into a staging directory, never directly into the live registry.
4. Verification gate (§6):
     a. tsc typecheck the module against the skill API types.
     b. vitest run the skill's tests + a standard smoke harness.
     c. validateAgentGraph on the behavior subroutine; assign a manifest hash.
     d. Capability check: the behavior's effect declarations are within the
        bounds granted to self-authored skills (§7).
   ANY failure → the skill is discarded, the gate errors are reported back to
   the author in-channel, nothing activates.
6. Hot-load: persist {trigger, hash, module ref, provenance, gate results} to
   the skill registry (§9) and make the dispatcher aware of it. No restart, no
   parent-graph recompile.
7. Confirm to the author with the provenance record (what was built, what the
   gate checked, how to revoke).
```

`[x]` The gate is **mandatory and pre-activation**. There is no "prose skill"
escape hatch — undefined behavior never reaches a live conversation. This is
the single property that distinguishes claw from Hermes/OpenClaw.

---

## 5. The verification gate

The gate is the heart of "verified". Its job: prove a synthesized skill
typechecks, terminates on representative input, and stays in bounds — before
it can run against a real user.

`[x]` Stages (all must pass): **typecheck → test → graph-validate →
capability-check**, in that order (cheapest/most-deterministic first).

`[ ]` **Where the gate runs (open).** Two candidates from the roadmap:

- **In-process** (ts-morph for typecheck + the vitest Node API for tests).
  Lower latency, simpler ops, but runs untrusted generated code in claw's own
  process — unacceptable unless paired with strong capability sandboxing.
- **Sandboxed subprocess** (spawn `tsc --noEmit` and `vitest run` against the
  staging dir in a locked-down child: no network, read-only FS except the
  staging dir, resource/time limits). Slower, but the right default given
  self-authoring *is* arbitrary code execution by construction.

Recommendation leaning toward **subprocess** for the trust boundary; decide
when Phase 1 is implemented in earnest.

`[ ]` **The test-authoring problem (open, important).** If the meta-agent
writes the skill's tests, it can write weak tests and pass its own gate. Two
mitigations, likely both:

- A **framework-owned smoke harness** the author cannot weaken: given the
  skill's declared `trigger.examples`, assert the behavior runs without throwing
  and produces a well-typed reply for each, under a wall-clock cap (catches
  non-termination and shape violations).
- **Author-supplied assertions** on top, for semantics. Treated as additive
  confidence, never as a replacement for the harness.

The general principle: the parts of the gate that establish *safety* (types,
termination, capability bounds) are framework-owned and non-negotiable; the
parts that establish *correctness* (does it do the right thing) may be
author-supplied and are advisory.

---

## 6. Security and capability bounds

Self-authoring is arbitrary code execution. The OpenClaw record (injection
payloads, 40k exposed instances, CVEs) is the cautionary baseline. Constraints
from day one:

`[x]` **Authorization boundary.** Authoring is triggered only from a privileged
control channel / allowlisted authors. A normal message in `XXX` can *invoke*
skills but cannot *author* them. Without this, "build behavior on instruction"
is a prompt-injection self-modification vector — exactly the failure to avoid.

`[x]` **Capability bounds via effect declarations.** A skill's `behavior`
nodes declare effects (`idempotencyKey` / `repeatable`, the binary effect
declaration). Self-authored skills default to **read-only / no external
writes**; any node that declares an external write must clear an explicit
elevation step (author approval recorded in provenance). Undeclared external
writes are already a registration-time error under checkpoint — the same
declaration doubles as the capability ceiling.

`[x]` **Network posture.** Claw binds to localhost; channel adapters are the
only ingress. The gate subprocess gets no network.

`[x]` **Provenance & audit.** Every skill records authored-by, the motivating
instruction/trace, and gate results, so the library is auditable and prunable.
A future Curator pass (roadmap) scores, merges, and prunes; revocation removes
the registry row (the dispatcher stops matching it; live conversations are
unaffected because the parent graph never depended on it).

---

## 7. Persistence

`[x]` The skill registry must survive restart, like conversations now do. It
holds, per skill: id, trigger, behavior module reference + manifest hash,
provenance, gate results, enabled/revoked state.

`[ ]` **Store choice (open).** Either a dedicated skill store or a namespace
in the existing `DurableRunStore` family (`@prompttrail/store-sqlite` for claw
today; postgres/redis/libsql available). Leaning toward a **separate
`SkillRegistry` abstraction** with its own backend, because its access pattern
(load-all-on-boot, occasional append/revoke) differs from per-run checkpoint
deltas. The synthesized module **source** also needs to live somewhere durable
(staging dir promoted to a skills dir on gate pass) so it can be re-validated
and hot-loaded after a restart.

---

## 8. Manifest hashing and long-lived conversations

`[x]` The parent (dispatcher) graph is stable, so its manifest hash does not
churn as skills are added — this is the main payoff of the registry-dispatch
decision (§3).

`[x]` Each skill `behavior` is a subroutine carrying **its own** manifest hash,
**excluded** from the parent manifest digest (`manifestConfigDigest` /
`createAgentGraphManifest` already give us per-node digests to build this on).
A skill can be re-authored to a new hash without invalidating any in-flight
parent conversation.

`[ ]` **Mid-conversation skill upgrade (open).** If a conversation is suspended
*inside* a skill subroutine when that skill is re-authored, resume hits a hash
mismatch for that subroutine. v1 policy: fail-fast that single suspended run
(rare; the run can be restarted), never the parent. Graph migration for
in-flight runs stays out of scope, consistent with the roadmap.

---

## 9. Phased roadmap

`[ ]` **Phase 0 — registry-dispatch skeleton (no code-gen).** Re-shape claw's
object layer to `inbox → dispatch(registry lookup) → matched skill | default`.
Seed **one hand-written skill**. Persist the registry. Proves: behavior is
data-driven, the parent graph is stable, skills survive restart. This is the
foundation everything else loads onto, and it carries no code-execution risk.

`[ ]` **Phase 1 — authoring + gate.** Add the privileged-channel authoring
subroutine: instruction → synthesize module → gate (typecheck + smoke + graph
+ capability) → on pass, write to the Phase-0 registry and hot-load. The gate's
where-it-runs and test-authoring decisions (§5) are settled here.

`[ ]` **Phase 2 — capability bounds, audit, Curator.** Enforce effect-declared
capability ceilings, full provenance/audit surface, and a Curator pass that
scores/merges/prunes the skill library.

`[x]` Ordering rationale: Phase 0 de-risks the *architecture* (stable graph,
data-driven dispatch, persistence) before Phase 1 introduces the *hard part*
(running synthesized code safely). Building them in the other order would mean
debugging code-gen and live-dispatch simultaneously.

---

## 10. Open questions (collected)

- **Gate execution site** — in-process (ts-morph + vitest API) vs sandboxed
  subprocess. Leaning subprocess for the trust boundary (§5).
- **Test authoring** — framework-owned smoke harness vs author-supplied
  assertions; the split between non-negotiable safety checks and advisory
  correctness checks (§5).
- **Skill registry store** — dedicated `SkillRegistry` backend vs a namespace
  in the existing run-store family; where synthesized source lives durably
  (§7).
- **Skill packaging** — single TS file vs directory module; where tests live
  (co-located vs harness-injected) (roadmap open question, unchanged).
- **Trigger expressiveness** — how rich `when` may be (channel + keyword vs
  arbitrary predicate vs LLM-classified intent) and how that interacts with
  the gate (an arbitrary predicate is itself code to verify).
- **Mid-conversation skill upgrade** — confirmed fail-fast-the-run for v1;
  revisit if it bites (§8).

---

## 11. Decisions summary

- `[x]` Skill = `trigger + behavior(subroutine) + provenance`, as typed TS, not
  prose.
- `[x]` Registry-dispatch over live-binding mutation; parent graph stays static.
- `[x]` Skill subroutine hash excluded from the parent manifest.
- `[x]` Mandatory pre-activation gate; no prose-skill escape hatch.
- `[x]` Authoring restricted to a privileged channel; skills default read-only,
  capability-bounded by effect declarations.
- `[x]` Registry + synthesized source are persisted; revocation is a registry
  delete.
- `[x]` Phase 0 (dispatch skeleton) before Phase 1 (authoring + gate) before
  Phase 2 (bounds + Curator).
