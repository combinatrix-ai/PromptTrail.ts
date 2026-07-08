# @prompttrail/launcher

**B5 — the immutable blue/green deploy launcher (the trust root).**

The launcher is the tiny, never-self-modified parent that lets a PromptTrail app
(e.g. claw) promote a new version of **itself** only after that version is
verified — then performs the single-writer lease cutover with a health window
and automatic rollback. It composes the already-merged machinery: B1 replay, B2
differ + `ChangeScope`, B3 acceptance, B4 store lease + fencing tokens.

Design: `design-docs/replay-and-self-deploy.md` §5 (lease handoff + launcher),
§6 (trust boundaries), §7 (module boundaries), §8 B5.

## Immutability posture (READ THIS)

The launcher is the **trust root**. Its guarantees only hold if it is installed
and pinned **outside the candidate's write paths**:

- It **never imports candidate code into its own decision logic.** Verification
  runs (`verifyCandidate`) execute the candidate agent through the _core_
  replay/diff/acceptance machinery over **launcher-owned** corpus definitions
  (`DeployTarget.corpus`). The candidate only ever appears as (a) an `Agent`
  returned by `loadAgent` and fed _into_ the trusted machinery, and (b) a served
  child process. It can never grade itself. "Green proposes evidence, the
  launcher disposes."
- The **corpus, scope schema, acceptance suite, lease, and launcher itself**
  live outside what a self-modified build can edit (design §6). claw's
  self-authoring only ever writes its `.data` dirs — never this package, never
  `claw/acceptance/`, never the differ/scope schema in core.
- In a self-modifying deployment, install `@prompttrail/launcher` (and the core
  differ + acceptance corpus) from a pinned, read-only location. If the candidate
  could rewrite the launcher, it could weaken its own gate or seize the lease —
  the whole point is that it cannot.

## Contract (v1)

```ts
import { deploy } from '@prompttrail/launcher';

const report = await deploy(candidateDir, target, options);
// report.verdict: 'promoted' | 'rejected' | 'rolled-back'
```

A `DeployTarget` is a directory + manifest the launcher can VERIFY against and
SERVE (see `DeployTarget` in the types). Its verification inputs are
**launcher-owned**, not read from the candidate:

- `corpus.runsDir` — recorded `StoredRun` JSON fixtures (`serializeRunFixture`)
  replayed for the diff.
- `corpus.scope` — the declared, trusted-root-authored `ChangeScope`.
- `corpus.acceptance` — forward fake-request `AcceptanceCase`s.
- `loadAgent(candidateDir)` — how to load the candidate's agent (e.g. dynamic
  import of its built dist) for runner-executed verification.
- `serve` — the command the launcher spawns as the green child.
- `store` — the shared `DurableRunStore` whose single-writer lease arbitrates
  serving. The launcher owns this handle and performs the handoff on it directly.
- `probes` — independent, launcher-owned health checks (throw = unhealthy).

## `deploy()` flow

1. **VERIFY** (sealed, in the launcher process): for each recorded fixture,
   `buildCassette` + `buildGoldenOutcome`, `replayRun` the candidate agent
   (`miss: 'flag'`), then `diffReplay` against `scope`. Any **regression** (a
   diff outside scope) rejects. Then `runAcceptance` — any failure rejects. No
   child is launched, blue is untouched.
2. **LAUNCH green**: spawn `serve` as a canary child. It comes up warm (its own
   store/lease config) and does not serve until handed the lease.
3. **CUTOVER**: discover blue via `store.lease.current()`, then
   `store.lease.handoff({ from: blue, to: green })` — atomic. Fencing tokens make
   a drained blue's late writes fail safely (`FencingTokenError`).
4. **HEALTH WINDOW**: confirm green took over (probes pass) and stays healthy for
   `healthWindowMs`. A probe failure hands the lease **back** to the still-warm
   blue and kills green → `rolled-back`.
5. **PROMOTE**: signal blue (via `options.current`) to drain + exit → `promoted`.

Any exception drives a **safe state**: blue keeps/regains the lease, green is
killed, verdict `rejected`.

## Handoff mechanism (v1 decision)

The launcher owns the `store` handle and performs the lease transfer **directly**
via `store.lease.handoff({ from, to, ttlMs })` — it does not itself hold the
lease. `from` is discovered with `store.lease.current()`; `to` is the holder id
the launcher assigned to green (injected as `LAUNCHER_LEASE_HOLDER`). Because
`handoff` bumps the monotonic fencing token, a paused/late blue presenting its
old token is rejected by every mutating store method (the B4 guarantee).

The **green child must wait for the handoff** before it starts serving: the
app's built-in lease acquire is fail-fast, so a green candidate polls
`store.lease.current()` until it is the holder, then `start()` acquires (renews
as the active holder, learning its token) and serves. Blue stays **warm** through
the health window (it drops to standby on lease loss rather than exiting), so a
rollback is an instant handoff back, not a cold restart. See claw's
`waitForLeaseHandoff` and `onLeaseLost` wiring (`claw/src/index.ts`) and the
scripted child in `src/__tests__/children/server-child.mjs`.

## Blue-side support (claw)

claw opts into lease mode with `CLAW_LEASE=1`; the holder id comes from
`LAUNCHER_LEASE_HOLDER`, and `LAUNCHER_ROLE=green` makes it wait for the handoff
before serving. `onLeaseLost` stops the gateways gracefully and exits with code
75 (a superseded blue, not a crash). See `claw/src/deploy-claw.ts` for the full
wiring, using claw's trusted acceptance corpus as the acceptance input.
