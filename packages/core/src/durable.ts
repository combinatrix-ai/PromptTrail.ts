import type { Message as PromptTrailMessage } from './message';
import {
  ObserverBus,
  normalizeObserver,
  type ExecutionEvent,
  type ObserverContext,
  type ObserverDeliveryBindingOptions,
  type ObserverLike,
} from './execution';
import type { HookDefinition, MiddlewareDefinition } from './interceptors';
import { assistantDeliveryKey } from './runtime_delivery_keys';
import {
  on as createRuntimeBindingBuilder,
  runtimeBundle as createRuntimeBundle,
  type BindingDefaults,
  type DeliveryTarget,
  type RuntimeBinding,
  type TriggerEvent,
  type RuntimeBindingLike,
  type RuntimeBundle,
  type Trigger,
} from './runtime_bindings';
import {
  server,
  type RuntimePresence,
  type RuntimePresenceDriver,
  type RuntimeAdapter,
  type RuntimeDeliveryDriver,
  type RuntimeServer,
  type RuntimeServerErrorContext,
  type RuntimeGatewayDriver,
} from './runtime_server';
import { Session, type Vars } from './session';
import {
  executeAgentGraph,
  GraphExecutionSuspended,
  type GraphInboundInput,
} from './graph_executor';
import {
  AgentGraphVersionError,
  createAgentGraphManifest,
  type AgentGraphManifest,
} from './graph';
import type { ProviderSessionBinding } from './provider_session';
import { KeyedMutex } from './utils';
import type { Agent } from './templates/agent';
import {
  beginCheckpointGraphExecution,
  computeCheckpointContinuationSkipNodes,
  createCheckpointContinuationSkipPredicate,
  createCheckpointOnceBoundary,
  createCheckpointOnceMemoStore,
  graphHasInboundConsumer,
  recordCheckpointGraphCompletion,
  recordCheckpointGraphSuspension,
  restoreCheckpointGraphEntryPoint,
  CheckpointRollbackError,
  type CheckpointOnceBoundary,
  type CheckpointOnceMemoEntry,
  type CheckpointOnceMemoStore,
  type CheckpointOnceOptions,
  type CheckpointOnceScope,
} from './checkpoint_continuation';

export type InboundKind = 'user' | 'system' | 'control';

export interface Inbound {
  offset: number;
  kind: InboundKind;
  content: string;
  attrs?: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id: string;
}

/**
 * A durable timer armed by a `sleep` node (durability roadmap §3). Persisted on
 * the run so a scheduler can re-arm it after a restart and fire it even across a
 * cold boot.
 *
 * Identity is `(runId, id)`: `id` is the sleep node's graph path, so arming is
 * idempotent — re-executing the same sleep node never resets an already-armed
 * `wakeAt`. `firedAt` is set once the app fires the timer (marks it and resumes
 * the run); a fired timer is never re-armed. `kind`/`payload` describe how the
 * timer wakes the run — v1 sleep always uses a `control` marker recognized via
 * the executor's fired-timer set, and the fields are reserved for external
 * signals that carry a payload.
 */
export interface DurableTimer {
  /** Stable timer id — the sleep node's graph path. Unique per run. */
  id: string;
  /** Absolute wake time, epoch milliseconds. */
  wakeAt: number;
  /** Optional payload delivered when the timer fires (reserved for signals). */
  payload?: string;
  /** Inbound kind used when the timer wakes the run. Defaults to `control`. */
  kind?: InboundKind;
  /** When the timer was armed, epoch milliseconds. */
  createdAt: number;
  /** When the timer fired, epoch milliseconds; unset while still pending. */
  firedAt?: number;
}

/**
 * Recording verbosity for the B0 replay layer (design-docs
 * replay-and-self-deploy.md, Appendix B0). Per agent/run, default `off`:
 *
 * - `off` — no recording captured.
 * - `decisions` — node breadcrumbs + tool calls (name/argsDigest/result) +
 *   model `requestDigest`/response. Cheap; powers the deterministic diff
 *   dimensions (routing / control-flow / tool-args / structured).
 * - `full` — additionally captures the normalized model request bytes and the
 *   parsed tool input, needed for `request-hash` keying and faithful replay.
 *   Larger and sensitive (this is the privacy surface).
 */
export type RecordLevel = 'off' | 'decisions' | 'full';

/**
 * A node-enter breadcrumb emitted by the graph executor (design B0 work item
 * 3). One entry per node entry, so loop/goalAttempts iterations that re-run
 * under the SAME `nodePath` appear as repeated breadcrumbs distinguished by
 * `seq` — the record stream is seq-ordered, NOT a `nodePath → record` map.
 * `branch` names the child a conditional entered. Parallel emits no per-branch
 * breadcrumbs (its branches run sequentially and are reconstructed from
 * model/tool record order).
 */
export interface NodeBreadcrumb {
  /** Monotonic per-run sequence number, assigned by the caller. */
  seq: number;
  nodePath: string;
  nodeType: string;
  branch?: string;
  /** When the node was entered, epoch milliseconds. */
  at: number;
}

/**
 * A single model/provider call captured at the `wrapModelCall` boundary. The
 * `requestDigest` is computed from the NORMALIZED request at record time — per
 * provider (assistant vs Codex vs Claude use different normalizers), so
 * `provider` is load-bearing for keying. `request` is only populated at the
 * `full` record level.
 */
export interface ModelCallRecord {
  /** Monotonic per-run sequence number, assigned by the caller. */
  seq: number;
  nodePath: string;
  callIndex: number;
  /** Provider identity, e.g. 'assistant' | 'codex' | 'claude' | ... */
  provider: string;
  /** Hash of the normalized request computed AT RECORD TIME. */
  requestDigest: string;
  /** NormalizedModelRequest; captured only at the `full` level. */
  request?: unknown;
  /** ModelOutput-shaped response; opaque to the store. */
  response: unknown;
  /** When the call was recorded, epoch milliseconds. */
  at: number;
}

/**
 * A single PromptTrail/ai-sdk tool call captured at the `executePromptTrailTool`
 * funnel. `input` is only populated at the `full` record level. builtin/MCP
 * tool calls do NOT flow through here — they ride the model/provider response.
 */
export interface ToolCallRecord {
  /** Monotonic per-run sequence number, assigned by the caller. */
  seq: number;
  nodePath: string;
  callIndex: number;
  toolName: string;
  /** Hash of the parsed tool arguments computed AT RECORD TIME. */
  argsDigest: string;
  /** Parsed tool input; captured only at the `full` level. */
  input?: unknown;
  /** CallToolResult-shaped result; opaque to the store. */
  result: unknown;
  /** Declared effect metadata, if any. */
  effect?: unknown;
  /** When the call was recorded, epoch milliseconds. */
  at: number;
}

/**
 * One entry in a run's seq-ordered recording stream. A run has a SINGLE
 * append-only sequence of these — `seq` is assigned by the caller monotonically
 * per run, and the store preserves order and enforces idempotency by
 * `(runId, seq)` (same discipline as `appendInbox` offsets).
 */
export type RunRecordEntry =
  | { kind: 'node'; record: NodeBreadcrumb }
  | { kind: 'model'; record: ModelCallRecord }
  | { kind: 'tool'; record: ToolCallRecord };

/** The seq a record entry carries, regardless of kind. */
export function runRecordEntrySeq(entry: RunRecordEntry): number {
  return entry.record.seq;
}

export interface DurableRunResult<TVars extends Vars = Vars> {
  status: 'done' | 'suspended';
  runId: string;
  session: Session<TVars>;
  awaiting?: string;
}

export interface AssistantDeliveryOutboxInput {
  message: PromptTrailMessage & { type: 'assistant' };
  assistantIndex: number;
  idempotencyKey: string;
  target?: unknown;
}

export interface AssistantDeliveryOutboxEntry
  extends AssistantDeliveryOutboxInput {
  id: string;
  conversationId: string;
  messageRef: {
    conversationId: string;
    assistantIndex: number;
  };
  platformBinding?: unknown;
  status:
    | 'pending'
    | 'delivering'
    | 'delivered'
    | 'failed'
    /** @deprecated Use delivered. */
    | 'completed'
    /** @deprecated Use failed or omit unresolved delivery entries. */
    | 'skipped';
  attempts: number;
  lastError?: string;
  error?: unknown;
}

export interface PendingAssistantDeliveryOutboxEntry {
  runId: string;
  entry: AssistantDeliveryOutboxEntry;
}

export type OnceScope = CheckpointOnceScope;

export interface OnceOptions extends CheckpointOnceOptions {}

export interface OnceBoundary extends CheckpointOnceBoundary {}

type OnceMemoStore = CheckpointOnceMemoStore;

export interface StoredRun<TVars extends Vars> {
  agent: PromptTrailRegisteredAgent<TVars>;
  agentName: string;
  graphManifest?: AgentGraphManifest;
  initial: Session<TVars>;
  status: 'open' | 'done';
  result?: Session<TVars>;
  once: OnceMemoStore;
  outbox: AssistantDeliveryOutboxEntry[];
  inbox: Inbound[];
  providerSessions?: Record<string, ProviderSessionBinding>;
  timers?: DurableTimer[];
  /**
   * Seq-ordered recording stream for the B0 replay layer. Append-only,
   * populated by the (future) capture wiring; absent when nothing was recorded.
   */
  recording?: RunRecordEntry[];
  /**
   * Recording verbosity for this run, fixed at create time from the app's
   * `recording` option (default `off`). Placed on the run — not derived
   * globally — so claw can sample `full` for a fraction of runs later.
   */
  recordLevel?: RecordLevel;
  graphCursor?: number;
  graphSuspendedAt?: string;
  services?: Record<string, unknown>;
}

export interface SessionCheckpointDelta<_TVars extends Vars = Vars> {
  fromVersion: number;
  toVersion: number;
  appendedMessages: readonly PromptTrailMessage[];
  varsSet?: Record<string, unknown>;
  varsDeleted?: readonly string[];
  /**
   * Set when the session rewrote (rather than appended to) its message
   * history since the last persisted version — e.g. a hook or middleware
   * patch with `replaceMessages`. The delta is then a full snapshot:
   * `appendedMessages` REPLACES the stored history and `varsSet` carries the
   * complete vars, so stores must not splice it onto previously stored
   * messages.
   */
  rewrite?: boolean;
}

export type StoredRunPatch = Partial<
  Pick<
    StoredRun<any>,
    | 'status'
    | 'graphCursor'
    | 'graphSuspendedAt'
    | 'services'
    | 'agentName'
    | 'graphManifest'
  >
>;

export type PromptTrailRegisteredAgent<TVars extends Vars = Vars> =
  Agent<TVars>;

export interface PromptTrailRunOptions<TVars extends Vars = Vars> {
  agent: string | PromptTrailRegisteredAgent<TVars>;
  runId?: string;
  input?: string | Omit<Inbound, 'offset'>;
  session?: Session<TVars>;
  checkpoint?: CheckpointOption;
  resumable?: boolean;
  services?: Record<string, unknown>;
}

export interface PromptTrailSendOptions {
  agent?: string;
  runId: string;
  input: string | Omit<Inbound, 'offset'>;
  checkpoint?: CheckpointOption;
  resumable?: boolean;
  services?: Record<string, unknown>;
}

export interface InboundRuntimeEvent {
  source: string;
  agent: string;
  runId: string;
  input: string;
  kind?: InboundKind;
  checkpoint?: CheckpointOption;
  resumable?: boolean;
  attrs?: Readonly<Record<string, unknown>>;
}

export interface AppGateway {
  start(
    emit: (event: InboundRuntimeEvent) => Promise<void>,
  ): Promise<void> | void;
  stop?(): Promise<void> | void;
}

/**
 * The observable state of a store-wide single-writer lease.
 *
 * `token` is a MONOTONIC FENCING TOKEN: it strictly increases on every
 * successful `acquire` that takes a fresh lease (including orphan takeover of an
 * expired lease) and on every `handoff`. It does NOT change when the current
 * holder merely renews (re-acquire by the same holder, or `renew`). A paused
 * old holder therefore carries a stale, smaller token after a handoff — which
 * is exactly what the store's fencing check rejects.
 */
export interface RunStoreLeaseState {
  /** Opaque id of the writer that holds the lease. */
  holder: string;
  /** Monotonic fencing token — increments on every acquire/handoff. */
  token: number;
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number;
}

/**
 * Store-wide single-writer lease (one writer per store).
 *
 * The lease answers "who is allowed to write to this store right now, and with
 * which fencing token". It is store-arbitrated so it works across processes
 * (blue/green cutover), unlike the in-process per-conversation lock. Expiry is
 * evaluated against the store's clock (injectable for tests); an EXPIRED lease
 * reads as if no lease is held.
 */
export interface RunStoreLease {
  /**
   * Take the lease for `holder` for `ttlMs`. Returns the new lease state, or
   * `undefined` if a LIVE lease is currently held by a different holder.
   * Re-acquiring while you already hold a live lease renews it and KEEPS the
   * token. Acquiring when the current lease is EXPIRED (or absent) succeeds and
   * BUMPS the token — this is the orphan-takeover path.
   */
  acquire(
    holder: string,
    ttlMs: number,
  ): Promise<RunStoreLeaseState | undefined>;
  /**
   * Heartbeat: extend the current holder's lease. `ttlMs` defaults to the ttl
   * from the last acquire/renew. Returns the renewed state, or `undefined` if
   * `holder` no longer owns a live lease. Never bumps the token.
   */
  renew(
    holder: string,
    ttlMs?: number,
  ): Promise<RunStoreLeaseState | undefined>;
  /** Release the lease if `holder` owns it; no-op otherwise. Token is retained. */
  release(holder: string): Promise<void>;
  /**
   * Atomically transfer the live lease from `from` to `to`, bumping the token.
   * Returns the new state, or `undefined` if `from` is not the current holder.
   */
  handoff(opts: {
    from: string;
    to: string;
    ttlMs: number;
  }): Promise<RunStoreLeaseState | undefined>;
  /** Current live lease state; `undefined` if none or expired. */
  current(): Promise<RunStoreLeaseState | undefined>;
}

/**
 * Thrown by a mutating store method when the store has an ACTIVE lease and the
 * write presents a fencing token older than the current lease token (or none at
 * all). Carries the expected (current lease) token and the actual token the
 * write presented (`undefined` when the write omitted its fence).
 */
export class FencingTokenError extends Error {
  readonly expectedToken: number;
  readonly actualToken: number | undefined;
  constructor(expectedToken: number, actualToken: number | undefined) {
    super(
      `Fencing token rejected: the store lease requires token >= ${expectedToken}, ` +
        (actualToken === undefined
          ? 'but the write presented no fencing token'
          : `but the write presented ${actualToken}`) +
        '. A newer writer holds the lease.',
    );
    this.name = 'FencingTokenError';
    this.expectedToken = expectedToken;
    this.actualToken = actualToken;
  }
}

/**
 * The fencing rule, shared by every backend. `activeToken` is the token of the
 * store's currently ACTIVE lease, or `undefined` when no lease is held (or it
 * has expired). When there is no active lease, writes proceed regardless of
 * `fence` (lease-less single-process operation stays zero-config). When a lease
 * IS active, the write must present a `fence` at least as new as the lease
 * token; an omitted or stale `fence` is a {@link FencingTokenError}.
 */
export function assertFenceAllowed(
  activeToken: number | undefined,
  fence: number | undefined,
): void {
  if (activeToken === undefined) {
    return;
  }
  if (fence === undefined || fence < activeToken) {
    throw new FencingTokenError(activeToken, fence);
  }
}

interface InternalLeaseState extends RunStoreLeaseState {
  ttlMs: number;
}

/**
 * In-memory reference implementation of {@link RunStoreLease}. Used by
 * {@link MemoryRunStore} and as the executable spec the SQL/redis backends
 * mirror. The clock is injectable (defaults to `Date.now`) so tests can drive
 * ttl expiry without sleeping.
 *
 * Token monotonicity is preserved across `release` by retaining the released
 * lease's token (expiry is simply set into the past), so the next acquire bumps
 * from it rather than resetting to zero.
 */
export class MemoryRunStoreLease implements RunStoreLease {
  private state: InternalLeaseState | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  private isActive(state: InternalLeaseState | undefined, at: number): boolean {
    return state !== undefined && state.expiresAt > at;
  }

  private view(state: InternalLeaseState): RunStoreLeaseState {
    return {
      holder: state.holder,
      token: state.token,
      expiresAt: state.expiresAt,
    };
  }

  async acquire(
    holder: string,
    ttlMs: number,
  ): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const current = this.state;
    if (this.isActive(current, at)) {
      if (current!.holder !== holder) {
        return undefined;
      }
      current!.expiresAt = at + ttlMs;
      current!.ttlMs = ttlMs;
      return this.view(current!);
    }
    const token = (current?.token ?? 0) + 1;
    this.state = { holder, token, expiresAt: at + ttlMs, ttlMs };
    return this.view(this.state);
  }

  async renew(
    holder: string,
    ttlMs?: number,
  ): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const current = this.state;
    if (!this.isActive(current, at) || current!.holder !== holder) {
      return undefined;
    }
    current!.expiresAt = at + (ttlMs ?? current!.ttlMs);
    if (ttlMs !== undefined) {
      current!.ttlMs = ttlMs;
    }
    return this.view(current!);
  }

  async release(holder: string): Promise<void> {
    const at = this.now();
    const current = this.state;
    if (this.isActive(current, at) && current!.holder === holder) {
      // Retain the token for monotonicity; just expire the lease.
      current!.expiresAt = 0;
    }
  }

  async handoff(opts: {
    from: string;
    to: string;
    ttlMs: number;
  }): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const current = this.state;
    if (!this.isActive(current, at) || current!.holder !== opts.from) {
      return undefined;
    }
    this.state = {
      holder: opts.to,
      token: current!.token + 1,
      expiresAt: at + opts.ttlMs,
      ttlMs: opts.ttlMs,
    };
    return this.view(this.state);
  }

  async current(): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    return this.isActive(this.state, at) ? this.view(this.state!) : undefined;
  }
}

/**
 * Concurrency contract:
 *
 * - This store family currently assumes a SINGLE WRITER PER RUN. Within one
 *   process, `PromptTrailApp` provides that guarantee itself: every
 *   `run`/`send`/`resume`/`delete` call for a given `runId` is serialized
 *   through a per-run mutex (`KeyedMutex`), so a backend never sees two
 *   concurrent writes for the same run from that process. Cross-process
 *   single-writer enforcement (e.g. multiple app instances pointed at the
 *   same store) is NOT yet provided by any backend here — it arrives with the
 *   planned single-writer lease (durability roadmap §2). Until then, running
 *   more than one process against the same store for the same `runId` is
 *   unsupported and may corrupt per-run sequencing.
 * - What IS guaranteed today, and must be preserved by any backend: seq/offset
 *   allocation (e.g. `appendSessionDelta`'s `seq`, `appendInbox`'s offset
 *   idempotency) must be atomic and correct under concurrent appends to
 *   DIFFERENT runs sharing the same store/connection pool. A backend must
 *   not compute "next seq" via a separate read-then-write round trip that
 *   could interleave with unrelated work on the same pool/connection in a way
 *   that corrupts another run's data; prefer a single atomic statement (e.g.
 *   `INSERT ... SELECT COALESCE(MAX(seq) + 1, 0) ... WHERE run_id = ?`) or an
 *   explicit transaction. Concurrent appends to the SAME run are out of
 *   contract per the single-writer assumption above and are not required to
 *   be race-free.
 *
 * Store-wide single-writer lease + fencing tokens (durability roadmap §2):
 *
 * - The store exposes a {@link RunStoreLease} (`lease`) that arbitrates a
 *   SINGLE WRITER PER STORE across processes (the blue/green cutover model).
 *   The lease carries a monotonic fencing token that increments on every
 *   acquire (including orphan takeover of an expired lease) and every handoff.
 * - Every MUTATING method takes an OPTIONAL trailing `fence?: number`. The
 *   fencing rule each backend MUST enforce (see {@link assertFenceAllowed}):
 *   - No ACTIVE lease → the write proceeds regardless of `fence`. A lease-less
 *     store stays zero-config; a single in-process writer passes no fence and
 *     is unaffected. An EXPIRED lease counts as no active lease.
 *   - ACTIVE lease + `fence` >= lease token → the write proceeds.
 *   - ACTIVE lease + `fence` < lease token, OR `fence` omitted → reject with a
 *     {@link FencingTokenError}. Once a lease exists, every writer must present
 *     its token; a paused old holder whose token predates a handoff cannot
 *     write.
 *   The check uses the store's clock for expiry, so it composes with the lease
 *   TTL. Backends should evaluate the current active token as close to the
 *   write as practical (a transaction where the driver supports it) so the
 *   check does not reintroduce a read-then-write race across the pool.
 */
export interface DurableRunStore {
  /**
   * Store-wide single-writer lease. Present on every backend; a store with no
   * acquired lease behaves exactly as before (all writes proceed unfenced).
   */
  readonly lease: RunStoreLease;
  /**
   * Reads are now async so networked store backends (Postgres, Redis, libsql)
   * can serve from the backend or a lazy cache rather than hydrating all runs
   * at construction. The in-memory and SQLite implementations still serve from
   * a hydrated Map, so the overhead is a resolved Promise. Writes were already
   * async; this completes the async-on-all-sides contract.
   *
   * Note: `entries()` returns `Promise<Iterable>` (not `AsyncIterable`) to
   * preserve snapshot semantics — callers await the call once and then iterate
   * the materialized snapshot synchronously.
   */
  get(runId: string): Promise<StoredRun<any> | undefined>;
  has(runId: string): Promise<boolean>;
  entries(): Promise<Iterable<[string, StoredRun<any>]>>;
  create(runId: string, run: StoredRun<any>, fence?: number): Promise<void>;
  patch(runId: string, patch: StoredRunPatch, fence?: number): Promise<void>;
  appendInbox(runId: string, inbound: Inbound, fence?: number): Promise<void>;
  appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
    fence?: number,
  ): Promise<void>;
  recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
    fence?: number,
  ): Promise<void>;
  upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
    fence?: number,
  ): Promise<void>;
  recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
    fence?: number,
  ): Promise<void>;
  /**
   * Arm or update a durable timer (durability roadmap §3). Idempotent by
   * `(runId, timer.id)`: a second upsert with the same id REPLACES the row (used
   * to mark `firedAt`), it does not append a duplicate. Timers are included in
   * `get`/`entries` reconstruction and removed by `delete`'s cascade.
   */
  upsertTimer(
    runId: string,
    timer: DurableTimer,
    fence?: number,
  ): Promise<void>;
  /**
   * Append one entry to the run's seq-ordered recording stream (design B0).
   * Append-only and idempotent by `(runId, entry.record.seq)`: a second append
   * with a seq already present is a no-op (first write wins), mirroring
   * `appendInbox`'s offset idempotency. The store preserves append order; the
   * caller assigns `seq` monotonically per run. Records are included in
   * `get`/`entries` reconstruction and removed by `delete`'s cascade.
   */
  appendRecord(
    runId: string,
    entry: RunRecordEntry,
    fence?: number,
  ): Promise<void>;
  delete(runId: string, fence?: number): Promise<void>;
}

export type RunStore = DurableRunStore;

export type CheckpointOption = true | RunStore | { store?: RunStore };

export interface MemoryRunStoreOptions {
  /** Injectable clock for the lease (defaults to `Date.now`). Tests only. */
  now?: () => number;
}

export class MemoryRunStore implements DurableRunStore {
  private runs = new Map<string, StoredRun<any>>();
  readonly lease: RunStoreLease;

  constructor(options: MemoryRunStoreOptions = {}) {
    this.lease = new MemoryRunStoreLease(options.now ?? Date.now);
  }

  private async assertFence(fence: number | undefined): Promise<void> {
    const active = await this.lease.current();
    assertFenceAllowed(active?.token, fence);
  }

  async get(runId: string): Promise<StoredRun<any> | undefined> {
    return this.runs.get(runId);
  }

  async create(
    runId: string,
    run: StoredRun<any>,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    this.runs.set(runId, run);
  }

  async has(runId: string): Promise<boolean> {
    return this.runs.has(runId);
  }

  async patch(
    runId: string,
    patch: StoredRunPatch,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    Object.assign(run, patch);
  }

  async appendInbox(
    runId: string,
    inbound: Inbound,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    if (run.inbox[inbound.offset]) {
      return;
    }
    run.inbox.push(inbound);
  }

  async appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    applySessionCheckpointDelta(run, delta);
  }

  async recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.once[scope].set(key, value);
  }

  async upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    const outbox = (run.outbox ??= []);
    const index = outbox.findIndex(
      (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
    );
    if (index >= 0) {
      outbox[index] = entry;
    } else {
      outbox.push(entry);
    }
  }

  async recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.providerSessions = {
      ...(run.providerSessions ?? {}),
      [nodePath]: binding,
    };
  }

  async upsertTimer(
    runId: string,
    timer: DurableTimer,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    const timers = (run.timers ??= []);
    const index = timers.findIndex((candidate) => candidate.id === timer.id);
    if (index >= 0) {
      timers[index] = timer;
    } else {
      timers.push(timer);
    }
  }

  async appendRecord(
    runId: string,
    entry: RunRecordEntry,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    const recording = (run.recording ??= []);
    const seq = runRecordEntrySeq(entry);
    // Idempotent by (runId, seq): first write wins, like appendInbox offsets.
    if (recording.some((existing) => runRecordEntrySeq(existing) === seq)) {
      return;
    }
    recording.push(entry);
  }

  async delete(runId: string, fence?: number): Promise<void> {
    await this.assertFence(fence);
    this.runs.delete(runId);
  }

  async entries(): Promise<Iterable<[string, StoredRun<any>]>> {
    return this.runs.entries();
  }
}

/**
 * Options for opt-in store-lease (single-writer) mode on {@link PromptTrailApp}.
 * See {@link PromptTrailAppOptions.lease}.
 */
export interface LeaseOptions {
  /**
   * Opaque writer id for this instance. Defaults to
   * `${appName}#${pid}#${randomSuffix}` — stable for the instance, unique
   * across instances (including two instances in the same process).
   */
  holder?: string;
  /** Lease TTL in ms. Defaults to 30_000. */
  ttlMs?: number;
  /** Heartbeat/renew interval in ms. Defaults to `ttlMs / 3`. */
  heartbeatMs?: number;
}

/**
 * Options for opt-in orphan auto-resume (crash recovery) on
 * {@link PromptTrailApp}. See {@link PromptTrailAppOptions.recovery}.
 *
 * An "orphan" is a run that was mid-execution when its process died: work was
 * delivered to it (appended to the inbox) but never fully consumed. Under the
 * checkpoint persistence contract (see {@link module:checkpoint_continuation}),
 * the inbox cursor advances only at a terminal boundary (completion/suspension),
 * so a run that crashed mid-execution rests with `graphCursor < inbox.length` —
 * an UNCONSUMED INBOX TAIL. That durable signal — not any status flag — is the
 * recoverable truth: the status vocabulary is only `'open' | 'done'`, and a run
 * legitimately suspended at `awaitInput` also rests as `'open'`, but with a
 * FULLY-consumed inbox (`graphCursor === inbox.length`), so it is NOT an orphan.
 * Re-resuming an orphan re-delivers only the still-unconsumed tail, which is
 * at-least-once and deduped by declared effect idempotency keys / the once memo.
 */
export interface RecoveryOptions {
  /** Scan and resume orphans once when {@link PromptTrailApp.start} runs. */
  onStart?: boolean;
  /**
   * Also scan periodically every `intervalMs` while the app is running. The
   * timer is unref'd (never keeps the process alive) and cleared on `stop()`.
   * Omit for a boot-only scan.
   */
  intervalMs?: number;
  /**
   * Invoked when resuming a single orphan throws. A failure never aborts the
   * scan — the remaining orphans are still attempted. Defaults to
   * `console.warn`.
   */
  onError?: (runId: string, error: unknown) => void;
}

/**
 * Thrown by `app.start()` when lease mode is enabled but a LIVE lease is already
 * held by a different writer. v1 is fail-fast: there is no waiting/polling — a
 * new instance may only take over once the current holder releases or its lease
 * expires. Carries the current holder for diagnostics/orchestration.
 */
export class LeaseUnavailableError extends Error {
  readonly currentHolder: string;
  readonly currentToken: number;
  readonly expiresAt: number;
  constructor(current: RunStoreLeaseState, appName?: string) {
    super(
      `Cannot acquire the store lease` +
        (appName ? ` for app "${appName}"` : '') +
        `: it is held by "${current.holder}" (token ${current.token}), ` +
        `expiring at ${current.expiresAt}. Lease mode is fail-fast in v1 — ` +
        `start after the current holder releases or its lease expires.`,
    );
    this.name = 'LeaseUnavailableError';
    this.currentHolder = current.holder;
    this.currentToken = current.token;
    this.expiresAt = current.expiresAt;
  }
}

/**
 * A {@link DurableRunStore} decorator that injects the app's current lease
 * fencing token into every MUTATING call, while delegating reads and the lease
 * object untouched. This is the single seam through which the app/runtime writes
 * when lease mode is on: because `PromptTrailApp` and `RuntimeServer` both route
 * every store mutation through `this.store`, wrapping it here fences all call
 * sites (persistRun, appendInbox, recordOnce, upsertOutbox, provider-session
 * recording, delete, …) without threading a fence parameter through each.
 *
 * `fence()` returns the live token (throwing a clear error if the app holds no
 * lease yet — direct usage without `start()` fails fast). A rejected write
 * ({@link FencingTokenError}) is reported via `onFenceRejected` so the app can
 * surface the lost lease, then rethrown so the caller still sees the failure.
 */
class FencedRunStore implements DurableRunStore {
  constructor(
    private readonly inner: DurableRunStore,
    private readonly fence: () => number,
    private readonly onFenceRejected: (error: FencingTokenError) => void,
  ) {}

  get lease(): RunStoreLease {
    return this.inner.lease;
  }

  get(runId: string): Promise<StoredRun<any> | undefined> {
    return this.inner.get(runId);
  }

  has(runId: string): Promise<boolean> {
    return this.inner.has(runId);
  }

  entries(): Promise<Iterable<[string, StoredRun<any>]>> {
    return this.inner.entries();
  }

  private async guard<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (error instanceof FencingTokenError) {
        this.onFenceRejected(error);
      }
      throw error;
    }
  }

  create(runId: string, run: StoredRun<any>, fence?: number): Promise<void> {
    return this.guard(() =>
      this.inner.create(runId, run, fence ?? this.fence()),
    );
  }

  patch(runId: string, patch: StoredRunPatch, fence?: number): Promise<void> {
    return this.guard(() =>
      this.inner.patch(runId, patch, fence ?? this.fence()),
    );
  }

  appendInbox(runId: string, inbound: Inbound, fence?: number): Promise<void> {
    return this.guard(() =>
      this.inner.appendInbox(runId, inbound, fence ?? this.fence()),
    );
  }

  appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
    fence?: number,
  ): Promise<void> {
    return this.guard(() =>
      this.inner.appendSessionDelta(runId, delta, fence ?? this.fence()),
    );
  }

  recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
    fence?: number,
  ): Promise<void> {
    return this.guard(() =>
      this.inner.recordOnce(runId, scope, key, value, fence ?? this.fence()),
    );
  }

  upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
    fence?: number,
  ): Promise<void> {
    return this.guard(() =>
      this.inner.upsertOutbox(runId, entry, fence ?? this.fence()),
    );
  }

  recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
    fence?: number,
  ): Promise<void> {
    return this.guard(() =>
      this.inner.recordProviderSession(
        runId,
        nodePath,
        binding,
        fence ?? this.fence(),
      ),
    );
  }

  upsertTimer(
    runId: string,
    timer: DurableTimer,
    fence?: number,
  ): Promise<void> {
    return this.guard(() =>
      this.inner.upsertTimer(runId, timer, fence ?? this.fence()),
    );
  }

  appendRecord(
    runId: string,
    entry: RunRecordEntry,
    fence?: number,
  ): Promise<void> {
    return this.guard(() =>
      this.inner.appendRecord(runId, entry, fence ?? this.fence()),
    );
  }

  delete(runId: string, fence?: number): Promise<void> {
    return this.guard(() => this.inner.delete(runId, fence ?? this.fence()));
  }
}

function defaultLeaseHolder(appName: string): string {
  const pid =
    typeof process !== 'undefined' && typeof process.pid === 'number'
      ? process.pid
      : 0;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${appName}#${pid}#${suffix}`;
}

/**
 * `PromptTrailApp` configuration.
 *
 * Lease mode (`lease`) is the cross-process single-writer enforcement layer.
 * Without it, the app is single-process only: the per-run {@link KeyedMutex}
 * serializes writes within ONE process, but nothing stops a second process from
 * writing to the same store. Turning on `lease` makes the store-arbitrated
 * single-writer lease (durability roadmap §2) real — `start()` acquires the
 * store lease, a heartbeat renews it, every write carries the lease's fencing
 * token, and a paused old holder's late writes are rejected with
 * {@link FencingTokenError} (blue/green cutover).
 */
export interface PromptTrailAppOptions {
  name?: string;
  store?: DurableRunStore;
  /**
   * Opt-in store-lease (single-writer) mode. `true` uses all defaults; an object
   * overrides `holder`/`ttlMs`/`heartbeatMs`. Omit for exactly today's
   * behavior (no lease, all writes unfenced, single-process only).
   */
  lease?: LeaseOptions | true;
  /**
   * Called when the app loses its lease — either a heartbeat renew fails or a
   * write is fenced out by a newer holder. Fires once per loss; the heartbeat is
   * stopped and subsequent writes throw {@link FencingTokenError}.
   */
  onLeaseLost?: (state: RunStoreLeaseState | undefined) => void;
  /**
   * Opt-in orphan auto-resume (crash recovery). `true` enables a boot-only scan
   * (`{ onStart: true }`); an object also allows a periodic scan via
   * `intervalMs`. On `start()` — AFTER the store lease is acquired when lease
   * mode is on, so a scan never runs on an instance that lost the lease race —
   * the app scans the run store for orphans (runs with an unconsumed inbox tail,
   * `graphCursor < inbox.length`) and resumes each through the normal per-run
   * locked path, sequentially; a resume that suspends again is a normal outcome
   * and a resume that throws goes to `onError` without aborting the scan.
   *
   * With lease mode on, recovery composes naturally: this instance is the sole
   * writer. WITHOUT lease mode the operator owns single-writer discipline —
   * running two recovering instances against one store may double-resume.
   */
  recovery?: RecoveryOptions | true;
  /**
   * Recording verbosity for the B0 replay layer, applied to every run this app
   * creates (design-docs replay-and-self-deploy.md, Appendix B0). Defaults to
   * `off`. Stored per-run at create time as `StoredRun.recordLevel`, so a later
   * sampling policy can vary it. This option only wires the level through
   * create/reconstruction; execution-time capture is a separate follow-up.
   */
  recording?: RecordLevel;
  /**
   * Injectable clock (epoch ms) for the durable-timer sweep (durability roadmap
   * §3). Defaults to `Date.now`. Tests fake it (e.g. vitest fake timers) so
   * timer wake-ups can be driven without sleeping; production leaves it default.
   */
  now?: () => number;
  /**
   * Invoked when firing a single due timer throws. A failure never aborts the
   * sweep — remaining due timers are still attempted. Defaults to `console.warn`.
   */
  onTimerError?: (runId: string, timerId: string, error: unknown) => void;
  defaults?: BindingDefaults;
  agents?: Record<string, PromptTrailRegisteredAgent<any>>;
  gateways?: Record<string, AppGateway>;
  middleware?: readonly MiddlewareDefinition<any>[];
  hooks?: readonly HookDefinition<any>[];
  observers?: readonly ObserverLike[];
  strictObservers?: boolean;
  observerDeliveryBindings?: ObserverDeliveryBindingOptions;
  adapters?: readonly RuntimeAdapter[];
  presence?: RuntimePresence | false;
  errorMessage?:
    | string
    | ((ctx: RuntimeServerErrorContext) => string | undefined);
}

export class PromptTrailApp {
  private readonly name: string;
  /** Effective store the app/runtime writes through (fenced when lease mode is on). */
  private readonly store: DurableRunStore;
  /** Underlying store; the lease and unfenced reads live here. */
  private readonly baseStore: DurableRunStore;
  private readonly leaseConfig?: {
    holder: string;
    ttlMs: number;
    heartbeatMs: number;
  };
  private readonly onLeaseLost?: (
    state: RunStoreLeaseState | undefined,
  ) => void;
  private leaseState?: RunStoreLeaseState;
  private leaseLost = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly recoveryConfig?: {
    onStart: boolean;
    intervalMs?: number;
    onError: (runId: string, error: unknown) => void;
  };
  private recoveryTimer?: ReturnType<typeof setInterval>;
  /** Recording verbosity stamped onto every run this app creates. */
  private readonly recordLevel: RecordLevel;
  private readonly now: () => number;
  private readonly onTimerError: (
    runId: string,
    timerId: string,
    error: unknown,
  ) => void;
  private timerSweepHandle?: ReturnType<typeof setTimeout>;
  private timerSweepInFlight = false;
  private timerSweepStopped = false;
  private readonly agents = new Map<string, Agent<any>>();
  private readonly gateways = new Map<string, AppGateway>();
  private readonly runtimeBindings: RuntimeBinding<TriggerEvent>[] = [];
  private readonly runtimeDefaults: BindingDefaults;
  private readonly middleware: readonly MiddlewareDefinition<any>[];
  private readonly hooks: readonly HookDefinition<any>[];
  private readonly observerBus: ObserverBus;
  private readonly deliveryObserverBus: ObserverBus;
  private readonly strictObservers?: boolean;
  private readonly observerDeliveryBindingOptions?: ObserverDeliveryBindingOptions;
  private readonly observerBuses: ObserverBus[] = [];
  private readonly deliveryObserverBuses: ObserverBus[] = [];
  private nextObserverBusIndex = 0;
  private readonly defaultCheckpoint?: CheckpointOption;
  private readonly runtimeAdapters: RuntimeAdapter[] = [];
  private readonly runtimePresence: RuntimePresence | false | undefined;
  private readonly runtimeErrorMessage:
    | string
    | ((ctx: RuntimeServerErrorContext) => string | undefined)
    | undefined;
  private runtimeServer?: RuntimeServer;
  private runCounter = 0;
  // Serializes send/resume/run for the same runId so concurrent callers (direct
  // API and the gateway path) do not race on the graph cursor, inbox, or session
  // deltas. Distinct runIds still run concurrently. This is process-local; it
  // composes with (nests inside) RuntimeServer's conversation lock but is a
  // separate map, so there is no cross-lock ordering to deadlock on.
  private readonly runLocks = new KeyedMutex();
  // Event idempotency keys embed this sequence, so it must stay monotonic
  // across resumes of the same run within this process — the lifetime of the
  // in-memory delivery-binding stores that dedupe on those keys. It is not
  // persisted; durable cross-restart sequencing is the async store's job
  // (change list §1.6).
  private readonly runEventSeqs = new Map<string, number>();
  private readonly persistedSessions = new Map<
    string,
    {
      version: number;
      messageCount: number;
      vars: Record<string, unknown>;
    }
  >();

  constructor(options: PromptTrailAppOptions = {}) {
    this.name = options.name ?? 'app';
    this.baseStore =
      checkpointOptionStore(options.defaults?.checkpoint) ??
      options.store ??
      new MemoryRunStore();
    this.onLeaseLost = options.onLeaseLost;
    if (options.lease) {
      const leaseOpts = options.lease === true ? {} : options.lease;
      const ttlMs = leaseOpts.ttlMs ?? 30_000;
      this.leaseConfig = {
        holder: leaseOpts.holder ?? defaultLeaseHolder(this.name),
        ttlMs,
        heartbeatMs:
          leaseOpts.heartbeatMs ?? Math.max(1, Math.floor(ttlMs / 3)),
      };
      this.store = new FencedRunStore(
        this.baseStore,
        () => this.requireFence(),
        () => this.handleLeaseLost(),
      );
    } else {
      this.store = this.baseStore;
    }
    if (options.recovery) {
      const recoveryOpts =
        options.recovery === true ? { onStart: true } : options.recovery;
      this.recoveryConfig = {
        onStart: recoveryOpts.onStart ?? false,
        intervalMs: recoveryOpts.intervalMs,
        onError:
          recoveryOpts.onError ??
          ((runId, error) =>
            console.warn(
              `[PromptTrail] app "${this.name}" failed to auto-resume orphan run "${runId}":`,
              error,
            )),
      };
    }
    this.recordLevel = options.recording ?? 'off';
    this.now = options.now ?? Date.now;
    this.onTimerError =
      options.onTimerError ??
      ((runId, timerId, error) =>
        console.warn(
          `[PromptTrail] app "${this.name}" failed to fire durable timer "${timerId}" on run "${runId}":`,
          error,
        ));
    this.runtimeDefaults = options.defaults ?? {};
    this.defaultCheckpoint = options.defaults?.checkpoint;
    this.middleware = options.middleware ?? [];
    this.hooks = options.hooks ?? [];
    this.strictObservers = options.strictObservers;
    this.observerDeliveryBindingOptions = options.observerDeliveryBindings;
    this.runtimeAdapters.push(...(options.adapters ?? []));
    this.runtimePresence = options.presence;
    this.runtimeErrorMessage = options.errorMessage;
    this.observerBus = new ObserverBus(options.observers ?? [], {
      strictObservers: options.strictObservers,
      ...options.observerDeliveryBindings,
    });
    this.deliveryObserverBus = new ObserverBus(options.observers ?? [], {
      strictObservers: options.strictObservers,
      ...options.observerDeliveryBindings,
    });
    for (const [name, registeredAgent] of Object.entries(
      options.agents ?? {},
    )) {
      this.agent(name, registeredAgent);
    }
    for (const [name, gateway] of Object.entries(options.gateways ?? {})) {
      this.gateways.set(name, gateway);
    }
  }

  agent(registeredAgent: PromptTrailRegisteredAgent<any>): this;
  agent(name: string, registeredAgent: PromptTrailRegisteredAgent<any>): this;
  agent(
    nameOrAgent: string | PromptTrailRegisteredAgent<any>,
    maybeAgent?: PromptTrailRegisteredAgent<any>,
  ): this {
    const registeredAgent =
      typeof nameOrAgent === 'string' ? maybeAgent : nameOrAgent;
    if (!registeredAgent) {
      throw new Error('PromptTrail.app.agent requires an Agent instance.');
    }
    const name =
      typeof nameOrAgent === 'string'
        ? nameOrAgent
        : registeredAgentName(registeredAgent);
    if (this.defaultCheckpoint !== undefined) {
      createAgentGraphManifest(registeredAgent.toGraph());
    }
    this.agents.set(name, registeredAgent);
    return this;
  }

  gateway(gateway: RuntimeGatewayDriver): this;
  gateway(name: string, gateway: AppGateway): this;
  gateway(
    nameOrGateway: string | RuntimeGatewayDriver,
    maybeGateway?: AppGateway,
  ): this {
    if (typeof nameOrGateway !== 'string') {
      return this.adapter({
        name: `gateway:${nameOrGateway.type}`,
        gateways: [nameOrGateway],
      });
    }
    if (!maybeGateway) {
      throw new Error('PromptTrail.app.gateway requires an AppGateway.');
    }
    this.gateways.set(nameOrGateway, maybeGateway);
    return this;
  }

  delivery(driver: RuntimeDeliveryDriver): this {
    return this.adapter({
      name: `delivery:${driver.platform}`,
      deliveries: [driver],
    });
  }

  presence(driver: RuntimePresenceDriver): this {
    return this.adapter({
      name: `presence:${driver.platform}`,
      presences: [driver],
    });
  }

  adapter(adapter: RuntimeAdapter): this {
    this.runtimeAdapters.push(adapter);
    return this;
  }

  on<TEvent extends TriggerEvent>(
    trigger: Trigger<TEvent>,
    configure: (
      binding: ReturnType<typeof createRuntimeBindingBuilder<TEvent>>,
    ) => RuntimeBindingLike<TEvent> | void,
  ): this {
    const builder = createRuntimeBindingBuilder(trigger);
    const bindingLike = configure(builder) ?? builder;
    const compiled = createRuntimeBundle({
      name: this.name,
      agents: this.registeredAgents(),
      bindings: [bindingLike],
    });
    for (const [name, registeredAgent] of Object.entries(compiled.agents)) {
      this.agent(name, registeredAgent);
    }
    this.runtimeBindings.push(...compiled.bindings);
    return this;
  }

  bundle(name = this.name): RuntimeBundle {
    return createRuntimeBundle({
      name,
      agents: this.registeredAgents(),
      defaults: this.runtimeDefaults,
      bindings: this.runtimeBindings,
    });
  }

  observe(observer: ObserverLike): this {
    this.registerObserver(observer);
    return this;
  }

  registerObserver(
    observer: ObserverLike,
    observerDeliveryBindings?: ObserverDeliveryBindingOptions,
    observerNamespace?: string,
  ): () => void {
    const namespace = this.resolveObserverNamespace(
      observerDeliveryBindings,
      observerNamespace,
    );
    const disposeObserver = this.registerObserverOn(
      this.observerBus,
      this.observerBuses,
      observer,
      observerDeliveryBindings,
      namespace,
    );
    const disposeDeliveryObserver = this.registerObserverOn(
      this.deliveryObserverBus,
      this.deliveryObserverBuses,
      observer,
      observerDeliveryBindings,
      namespace,
    );
    return () => {
      disposeObserver();
      disposeDeliveryObserver();
    };
  }

  registerRuntimeObserver(
    observer: ObserverLike,
    observerDeliveryBindings?: ObserverDeliveryBindingOptions,
    observerNamespace?: string,
  ): () => void {
    const namespace = this.resolveObserverNamespace(
      observerDeliveryBindings,
      observerNamespace,
    );
    return this.registerObserverOn(
      this.observerBus,
      this.observerBuses,
      observer,
      observerDeliveryBindings,
      namespace,
    );
  }

  async emitRuntimeDeliveryEvent(
    event: ExecutionEvent,
    context: ObserverContext,
  ): Promise<void> {
    await this.deliveryObserverBus.emit(event, context);
    for (const bus of this.deliveryObserverBuses) {
      await bus.emit(event, context);
    }
  }

  private registerObserverOn(
    observerBus: ObserverBus,
    observerBuses: ObserverBus[],
    observer: ObserverLike,
    observerDeliveryBindings?: ObserverDeliveryBindingOptions,
    observerNamespace?: string,
  ): () => void {
    if (observerDeliveryBindings) {
      if (!observerNamespace) {
        throw new Error(
          'PromptTrail observer delivery binding registration requires a namespace.',
        );
      }
      const normalized = normalizeObserver(observer);
      const namespacedObserver = normalized.name
        ? normalized
        : {
            ...normalized,
            name: observerNamespace,
          };
      const bus = new ObserverBus([namespacedObserver], {
        strictObservers: this.strictObservers,
        ...observerDeliveryBindings,
      });
      observerBuses.push(bus);
      return () => {
        const index = observerBuses.indexOf(bus);
        if (index >= 0) {
          observerBuses.splice(index, 1);
        }
      };
    }
    return observerBus.add(observer);
  }

  private resolveObserverNamespace(
    observerDeliveryBindings: ObserverDeliveryBindingOptions | undefined,
    observerNamespace: string | undefined,
  ): string | undefined {
    if (!observerDeliveryBindings || observerNamespace) {
      return observerNamespace;
    }
    return `appObserver:${this.nextObserverBusIndex++}`;
  }

  /**
   * Current store-lease state, or `undefined` if lease mode is off or no lease
   * is held. Exposed so a launcher can observe the fencing token for blue/green
   * orchestration; taking over is the new instance's `start()` (which
   * acquires once the old holder releases or its lease expires).
   */
  get lease(): RunStoreLeaseState | undefined {
    return this.leaseState;
  }

  private requireFence(): number {
    if (this.leaseState === undefined) {
      throw new Error(
        `PromptTrail app "${this.name}" has lease mode enabled but holds no ` +
          `lease. Call app.start() to acquire the store lease before running ` +
          `durable operations.`,
      );
    }
    return this.leaseState.token;
  }

  private async acquireLease(): Promise<void> {
    const config = this.leaseConfig;
    if (!config) {
      return;
    }
    const lease = this.baseStore.lease;
    let state = await lease.acquire(config.holder, config.ttlMs);
    if (!state) {
      const current = await lease.current();
      if (current) {
        throw new LeaseUnavailableError(current, this.name);
      }
      // The blocking lease expired between acquire and current; retry once.
      state = await lease.acquire(config.holder, config.ttlMs);
      if (!state) {
        const now = await lease.current();
        throw new LeaseUnavailableError(
          now ?? { holder: 'unknown', token: -1, expiresAt: 0 },
          this.name,
        );
      }
    }
    this.leaseState = state;
    this.leaseLost = false;
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    const config = this.leaseConfig;
    if (!config) {
      return;
    }
    this.stopHeartbeat();
    const timer = setInterval(() => {
      void this.heartbeat();
    }, config.heartbeatMs);
    // Don't keep the process alive purely for the heartbeat.
    timer.unref?.();
    this.heartbeatTimer = timer;
  }

  private async heartbeat(): Promise<void> {
    const config = this.leaseConfig;
    if (!config || this.leaseLost || this.leaseState === undefined) {
      return;
    }
    let renewed: RunStoreLeaseState | undefined;
    try {
      renewed = await this.baseStore.lease.renew(config.holder, config.ttlMs);
    } catch {
      renewed = undefined;
    }
    if (renewed) {
      this.leaseState = renewed;
      return;
    }
    this.handleLeaseLost();
  }

  private handleLeaseLost(): void {
    if (this.leaseConfig === undefined || this.leaseLost) {
      return;
    }
    this.leaseLost = true;
    this.stopHeartbeat();
    // Retain leaseState (its now-stale token) so subsequent writes present it
    // and are rejected with FencingTokenError by a newer holder.
    this.onLeaseLost?.(this.leaseState);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async releaseLease(): Promise<void> {
    this.stopHeartbeat();
    const config = this.leaseConfig;
    if (config && !this.leaseLost && this.leaseState !== undefined) {
      await this.baseStore.lease.release(config.holder);
    }
    this.leaseState = undefined;
    this.leaseLost = false;
  }

  async start(): Promise<void> {
    // Acquire the store lease before anything writes (runtime-server startup
    // retries deliveries, gateways may emit) so all writes carry the fence.
    await this.acquireLease();
    // Orphan auto-resume runs only past a successful lease acquisition, so an
    // instance that lost the lease race (acquireLease threw) never recovers.
    // Boot-scan before adapters start so recovered outbox deliveries are already
    // queued when the runtime server begins retrying pending deliveries.
    if (this.recoveryConfig?.onStart) {
      await this.recoverOrphans();
    }
    this.startRecoveryTimer();
    // Durable-timer sweep (durability roadmap §3): always on with a store. The
    // boot sweep fires any timer already due (including cold-boot/past-due) and
    // arms an in-process wake for the earliest still-pending one. It runs after
    // recovery so a resumed orphan's freshly-armed timers are already visible.
    this.timerSweepStopped = false;
    await this.runTimerSweep();
    if (this.runtimeAdapters.length > 0) {
      if (!this.runtimeServer) {
        this.runtimeServer = server({
          bundle: this.bundle(),
          runtime: this,
          adapters: this.runtimeAdapters,
          presence: this.runtimePresence,
          strictObservers: this.strictObservers,
          observerDeliveryBindings: this.observerDeliveryBindingOptions,
          errorMessage: this.runtimeErrorMessage,
        });
      }
      await this.runtimeServer.start();
    }
    for (const gateway of this.gateways.values()) {
      await gateway.start((event) => this.handleEvent(event));
    }
  }

  async stop(): Promise<void> {
    this.stopRecoveryTimer();
    this.stopTimerSweep();
    await this.runtimeServer?.stop();
    this.runtimeServer = undefined;
    for (const gateway of this.gateways.values()) {
      await gateway.stop?.();
    }
    await this.releaseLease();
  }

  /**
   * True when a stored run is an orphan: it never reached a terminal boundary
   * for its most recently delivered inbox (`graphCursor < inbox.length`) and is
   * not a completed run. Under the checkpoint persistence contract the cursor
   * advances only at completion/suspension, so an unconsumed inbox tail is the
   * durable signal that a process died mid-execution. A run suspended at
   * `awaitInput` has consumed its inbox tail (cursor === inbox.length) and is
   * therefore NOT an orphan — it is legitimately waiting for the next input.
   */
  private isOrphanRun(run: StoredRun<any>): boolean {
    return run.status !== 'done' && (run.graphCursor ?? 0) < run.inbox.length;
  }

  /**
   * Scan the run store and resume every orphan sequentially through the normal
   * per-run locked resume path (so recovery never collides with a concurrent
   * send for the same run). Each resume failure is reported to the configured
   * `onError` and does NOT abort the scan; a resume that suspends again is a
   * normal outcome. A lost lease short-circuits the scan.
   */
  private async recoverOrphans(): Promise<void> {
    if (!this.recoveryConfig || this.leaseLost) {
      return;
    }
    const orphanIds: string[] = [];
    for (const [runId, run] of await this.store.entries()) {
      if (this.isOrphanRun(run)) {
        orphanIds.push(runId);
      }
    }
    for (const runId of orphanIds) {
      try {
        await this.resumeOrphan(runId);
      } catch (error) {
        this.recoveryConfig.onError(runId, error);
      }
    }
  }

  /**
   * Resume a single orphan under its per-run mutex. Re-checks the orphan
   * condition under the lock (a concurrent send may have already advanced it)
   * and rebinds the agent from the registry by `agentName` so recovery works
   * after a cold restart where the stored run carries no live agent reference.
   */
  private async resumeOrphan(runId: string): Promise<void> {
    await this.runLocks.run(runId, async () => {
      const run = await this.store.get(runId);
      if (!run || !this.isOrphanRun(run)) {
        return;
      }
      const agent = this.agents.get(run.agentName);
      if (!agent) {
        throw new Error(
          `Cannot auto-resume orphan run "${runId}": no agent named ` +
            `"${run.agentName}" is registered on app "${this.name}".`,
        );
      }
      run.agent = agent;
      await this.resumeImpl(runId);
    });
  }

  private startRecoveryTimer(): void {
    const intervalMs = this.recoveryConfig?.intervalMs;
    if (!intervalMs) {
      return;
    }
    this.stopRecoveryTimer();
    const timer = setInterval(() => {
      void this.recoverOrphans();
    }, intervalMs);
    // Don't keep the process alive purely for the recovery scan.
    timer.unref?.();
    this.recoveryTimer = timer;
  }

  private stopRecoveryTimer(): void {
    if (this.recoveryTimer !== undefined) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Durable timer sweep (durability roadmap §3)
  //
  // Design: ONE self-driven sweep timer, not a fixed poll interval and not one
  // OS timer per pending durable timer. `runTimerSweep` fires every timer that
  // is due now (`wakeAt <= now`), then re-arms a single in-process `setTimeout`
  // that wakes at the EARLIEST still-pending `wakeAt` across all runs; each fire
  // re-runs the sweep, which re-arms for the next earliest. When no timer is
  // pending, no OS timer is held, so the sweep costs nothing at rest. The handle
  // is unref'd (never keeps the process alive) and cleared on `stop()`. It
  // shares the app's injectable clock with `armTimer`, matching the cron
  // gateway's fake-timer-friendly, skip-don't-queue discipline.
  //
  // Firing a timer marks `firedAt` through the (fenced, when leased) store, then
  // resumes the run via the per-run locked path. The sleep executor recognizes
  // its fired timer via the `firedTimers` set threaded into execution — the same
  // seam as inbox/providerSessions — so the executor stays store-agnostic. We
  // deliberately do NOT append a control inbound to wake the run: a sleeping run
  // must rest with a fully-consumed inbox (`graphCursor === inbox.length`) so it
  // is not misread as a crashed orphan, and an unconsumed control marker would
  // break that terminal-boundary cursor contract.
  // ---------------------------------------------------------------------------

  private stopTimerSweep(): void {
    this.timerSweepStopped = true;
    if (this.timerSweepHandle !== undefined) {
      clearTimeout(this.timerSweepHandle);
      this.timerSweepHandle = undefined;
    }
  }

  /** Fire all due timers, then re-arm the sweep for the next earliest wake-at. */
  private async runTimerSweep(): Promise<void> {
    if (this.timerSweepHandle !== undefined) {
      clearTimeout(this.timerSweepHandle);
      this.timerSweepHandle = undefined;
    }
    // Skip (do not queue) if a sweep is already running or the lease is lost —
    // the in-flight sweep re-arms at the end, and a lost lease must not write.
    if (this.timerSweepInFlight || this.timerSweepStopped || this.leaseLost) {
      return;
    }
    this.timerSweepInFlight = true;
    try {
      const now = this.now();
      const due: Array<{ runId: string; timerId: string }> = [];
      for (const [runId, run] of await this.store.entries()) {
        for (const timer of run.timers ?? []) {
          if (timer.firedAt === undefined && timer.wakeAt <= now) {
            due.push({ runId, timerId: timer.id });
          }
        }
      }
      for (const { runId, timerId } of due) {
        try {
          await this.fireTimer(runId, timerId);
        } catch (error) {
          this.onTimerError(runId, timerId, error);
        }
      }
    } finally {
      this.timerSweepInFlight = false;
      await this.rearmTimerSweep();
    }
  }

  /** Arm a single wake at the earliest pending (unfired) timer, if any. */
  private async rearmTimerSweep(): Promise<void> {
    if (this.timerSweepStopped || this.leaseLost) {
      return;
    }
    if (this.timerSweepHandle !== undefined) {
      clearTimeout(this.timerSweepHandle);
      this.timerSweepHandle = undefined;
    }
    let earliest: number | undefined;
    for (const [, run] of await this.store.entries()) {
      for (const timer of run.timers ?? []) {
        if (timer.firedAt === undefined) {
          earliest =
            earliest === undefined
              ? timer.wakeAt
              : Math.min(earliest, timer.wakeAt);
        }
      }
    }
    if (earliest === undefined || this.timerSweepStopped) {
      return;
    }
    const delay = Math.max(0, earliest - this.now());
    const handle = setTimeout(() => {
      void this.runTimerSweep();
    }, delay);
    // Don't keep the process alive purely for the timer sweep.
    handle.unref?.();
    this.timerSweepHandle = handle;
  }

  /**
   * Fire one due timer under its per-run mutex: mark `firedAt` through the
   * (fenced) store, rebind the agent from the registry so it works after a cold
   * restart, and resume the run. Re-checks under the lock so a concurrent fire
   * or resume cannot double-fire; a timer already marked is a no-op.
   */
  private async fireTimer(runId: string, timerId: string): Promise<void> {
    await this.runLocks.run(runId, async () => {
      const run = await this.store.get(runId);
      if (!run) {
        return;
      }
      const timer = (run.timers ?? []).find(
        (candidate) => candidate.id === timerId,
      );
      if (!timer || timer.firedAt !== undefined) {
        return;
      }
      timer.firedAt = this.now();
      await this.store.upsertTimer(runId, timer);
      const agent = this.agents.get(run.agentName);
      if (agent) {
        run.agent = agent;
      }
      await this.resumeImpl(runId);
    });
  }

  /**
   * Arm (idempotently) a durable timer for a sleep node. Called by the executor
   * via the `armTimer` seam while under the run's mutex. If a timer with this id
   * is already armed (pending) its `wakeAt` is kept — re-executing the sleep
   * node must not push the wake later. A timer already fired is left alone.
   */
  private async armTimer(
    runId: string,
    run: StoredRun<any>,
    timerId: string,
    durationMs: number,
  ): Promise<void> {
    const timers = (run.timers ??= []);
    const existing = timers.find((candidate) => candidate.id === timerId);
    if (existing) {
      return;
    }
    const createdAt = this.now();
    const timer: DurableTimer = {
      id: timerId,
      wakeAt: createdAt + durationMs,
      kind: 'control',
      createdAt,
    };
    timers.push(timer);
    await this.store.upsertTimer(runId, timer);
    // A newly-armed timer may be sooner than the current wake; re-arm the sweep.
    await this.rearmTimerSweep();
  }

  async run<TVars extends Vars = Vars>(
    options: PromptTrailRunOptions<TVars>,
  ): Promise<DurableRunResult<TVars>> {
    // A run without an explicit runId gets a freshly generated id, so no other
    // caller can contend for it; only lock when the caller pins the runId.
    if (options.runId === undefined) {
      return this.startRun(options);
    }
    return this.runLocks.run(options.runId, () => this.startRun(options));
  }

  async executeCheckpointRun<TVars extends Vars = Vars>(options: {
    agent: Agent<TVars>;
    runId: string;
    input?: string | Omit<Inbound, 'offset'>;
    session?: Session<TVars>;
    services?: Record<string, unknown>;
  }): Promise<DurableRunResult<TVars>> {
    const existing = await this.store.get(options.runId);
    if (existing) {
      existing.agent = options.agent;
      existing.agentName = options.agent.toGraph().name;
      await this.store.patch(options.runId, {
        agentName: existing.agentName,
      });
    }
    if (!(await this.store.has(options.runId))) {
      return this.run<TVars>({
        agent: options.agent,
        runId: options.runId,
        session: options.session,
        input: options.input,
        checkpoint: true,
        services: options.services,
      });
    }
    if (options.input === undefined) {
      return this.resume<TVars>(options.runId);
    }
    return this.send<TVars>({
      runId: options.runId,
      input: options.input,
      checkpoint: true,
      services: options.services,
    });
  }

  async send<TVars extends Vars = Vars>(
    options: PromptTrailSendOptions,
  ): Promise<DurableRunResult<TVars>> {
    return this.runLocks.run(options.runId, () =>
      this.sendImpl<TVars>(options),
    );
  }

  private async sendImpl<TVars extends Vars = Vars>(
    options: PromptTrailSendOptions,
  ): Promise<DurableRunResult<TVars>> {
    const checkpoint =
      options.checkpoint ??
      (options.resumable ? true : undefined) ??
      this.defaultCheckpoint;
    this.assertAppCheckpointStore(checkpoint);
    const existing = await this.store.get(options.runId);
    if (!existing) {
      if (!options.agent) {
        throw new Error(`Unknown durable run: ${options.runId}`);
      }
      return this.startRun<TVars>({
        agent: options.agent,
        runId: options.runId,
        input: options.input,
        checkpoint,
        services: options.services,
      });
    }

    if (options.services) {
      existing.services = cloneDurableRuntimeValue(options.services);
      await this.store.patch(options.runId, {
        services: existing.services,
      });
    }
    if (
      existing.status === 'done' &&
      !graphHasInboundConsumer(existing.agent.toGraph().nodes)
    ) {
      throw new Error(
        `Cannot send input to completed graph run: ${options.runId}. Start a new run or include an inbound consumer before completion.`,
      );
    }
    await this.append(options.runId, normalizeInbound(options.input));
    return this.resumeImpl<TVars>(options.runId);
  }

  async resume<TVars extends Vars = Vars>(
    runId: string,
  ): Promise<DurableRunResult<TVars>> {
    return this.runLocks.run(runId, () => this.resumeImpl<TVars>(runId));
  }

  /**
   * Deletes a run from the store and prunes the process-local maps keyed by
   * runId so they do not grow unboundedly across a long-lived process.
   *
   * Pruning happens only on delete, never on completion: a completed run whose
   * graph has an inbound consumer can still be continued via `send` (which
   * flips status back to `open` and resumes), and continuation relies on
   * `runEventSeqs` staying monotonic and `persistedSessions` holding the delta
   * baseline. Once the run is deleted those invariants no longer matter.
   *
   * Acquires the per-run mutex so a delete cannot interleave with an in-flight
   * send/resume/run for the same runId.
   */
  async delete(runId: string): Promise<void> {
    await this.runLocks.run(runId, async () => {
      await this.store.delete(runId);
      this.runEventSeqs.delete(runId);
      this.persistedSessions.delete(runId);
    });
  }

  private async resumeImpl<TVars extends Vars = Vars>(
    runId: string,
  ): Promise<DurableRunResult<TVars>> {
    const run = await this.getRun<TVars>(runId);
    await this.assertGraphRunManifest(runId, run);
    if (
      run.status === 'done' &&
      run.result &&
      run.inbox.length <= (run.graphCursor ?? run.inbox.length)
    ) {
      return { status: 'done', runId, session: run.result };
    }
    return this.resumeAgentRun(
      runId,
      run as StoredRun<TVars> & {
        agent: Agent<TVars>;
      },
    );
  }

  async prepareAssistantDeliveries(
    runId: string,
    deliveries: readonly AssistantDeliveryOutboxInput[],
  ): Promise<AssistantDeliveryOutboxEntry[]> {
    const run = await this.store.get(runId);
    if (!run) {
      return deliveries.map((delivery) =>
        createAssistantDeliveryOutboxEntry(runId, delivery),
      );
    }
    const outbox = (run.outbox ??= []) as AssistantDeliveryOutboxEntry[];
    for (const delivery of deliveries) {
      const existing = outbox.find(
        (entry) => entry.idempotencyKey === delivery.idempotencyKey,
      );
      if (!existing) {
        const entry = createAssistantDeliveryOutboxEntry(runId, delivery);
        outbox.push(entry);
        await this.store.upsertOutbox(runId, entry);
      } else {
        Object.assign(
          existing,
          completeAssistantDeliveryOutboxMetadata(runId, existing),
        );
        await this.store.upsertOutbox(runId, existing);
      }
    }
    return outbox.filter(
      (entry) =>
        deliveries.some(
          (delivery) => delivery.idempotencyKey === entry.idempotencyKey,
        ) && isRetryableAssistantDeliveryStatus(entry.status),
    );
  }

  async markAssistantDelivery(
    runId: string,
    idempotencyKey: string,
    status: AssistantDeliveryOutboxEntry['status'],
    error?: unknown,
    platformBinding?: unknown,
  ): Promise<void> {
    const run = await this.store.get(runId);
    if (!run) {
      return;
    }
    const entry = (run.outbox ?? []).find(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    if (!entry) {
      return;
    }
    entry.status = status;
    entry.attempts ??= 0;
    if (status === 'delivering') {
      entry.attempts += 1;
      entry.error = undefined;
      entry.lastError = undefined;
    } else if (status === 'failed') {
      entry.error = error;
      entry.lastError = errorMessage(error);
    } else if (
      status === 'delivered' ||
      status === 'completed' ||
      status === 'skipped'
    ) {
      entry.error = undefined;
      entry.lastError = undefined;
    } else {
      entry.error = error;
      entry.lastError = error === undefined ? undefined : errorMessage(error);
    }
    if (platformBinding !== undefined) {
      entry.platformBinding = cloneDurableRuntimeValue(platformBinding);
    }
    await this.store.upsertOutbox(runId, entry);
  }

  async assistantDeliveryOutbox(
    runId: string,
  ): Promise<readonly AssistantDeliveryOutboxEntry[]> {
    const run = await this.store.get(runId);
    if (!run) {
      return [];
    }
    await this.materializeAssistantDeliveriesForRun(runId, run);
    if (this.backfillAssistantDeliveryOutboxMetadata(runId, run)) {
      await this.persistAssistantDeliveryOutbox(runId, run);
    }
    return run ? [...(run.outbox ?? [])] : [];
  }

  async pendingAssistantDeliveryOutbox(): Promise<
    PendingAssistantDeliveryOutboxEntry[]
  > {
    await this.materializePendingAssistantDeliveries();
    const pending: PendingAssistantDeliveryOutboxEntry[] = [];
    for (const [runId, run] of await this.store.entries()) {
      const changed = this.backfillAssistantDeliveryOutboxMetadata(runId, run);
      for (const entry of run.outbox ?? []) {
        if (isRetryableAssistantDeliveryStatus(entry.status)) {
          pending.push({ runId, entry });
        }
      }
      if (changed) {
        await this.persistAssistantDeliveryOutbox(runId, run);
      }
    }
    return pending;
  }

  private backfillAssistantDeliveryOutboxMetadata<TVars extends Vars = Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): boolean {
    let changed = false;
    for (const entry of run.outbox ?? []) {
      const completed = completeAssistantDeliveryOutboxMetadata(runId, entry);
      if (
        entry.id !== completed.id ||
        entry.conversationId !== completed.conversationId ||
        entry.messageRef !== completed.messageRef
      ) {
        Object.assign(entry, completed);
        changed = true;
      }
    }
    return changed;
  }

  async materializePendingAssistantDeliveries(): Promise<void> {
    for (const [runId, run] of await this.store.entries()) {
      await this.materializeAssistantDeliveriesForRun(runId, run);
    }
  }

  private async materializeAssistantDeliveriesForRun<TVars extends Vars = Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): Promise<void> {
    const target = deliveryTargetFromServices(run.services);
    if (!target || !run.result) {
      return;
    }
    const deliveries = run.result.messages
      .filter(
        (
          message,
        ): message is PromptTrailMessage & {
          type: 'assistant';
        } => message.type === 'assistant',
      )
      .map((message, index) => ({
        message,
        assistantIndex: index,
        idempotencyKey: assistantDeliveryKey(runId, index, target),
        target,
      }));
    await this.prepareAssistantDeliveries(runId, deliveries);
  }

  private async handleEvent(event: InboundRuntimeEvent): Promise<void> {
    await this.send({
      agent: event.agent,
      runId: event.runId,
      input: {
        kind: event.kind ?? 'user',
        content: event.input,
        attrs: event.attrs,
      },
      checkpoint: event.checkpoint,
      resumable: event.resumable,
    });
  }

  private async startRun<TVars extends Vars = Vars>(
    options: PromptTrailRunOptions<TVars>,
  ): Promise<DurableRunResult<TVars>> {
    const checkpoint =
      options.checkpoint ??
      (options.resumable ? true : undefined) ??
      this.defaultCheckpoint;
    this.assertAppCheckpointStore(checkpoint);
    const durable = checkpoint !== undefined;
    const agent = this.resolveAgent(options.agent);
    if (!agent) {
      throw new Error(`Unknown agent: ${String(options.agent)}`);
    }
    if (durable) {
      const graph = agent.toGraph();
      const graphManifest = createAgentGraphManifest(graph);
      const runId = options.runId ?? `${graph.name}-${++this.runCounter}`;
      const run: StoredRun<TVars> = {
        agent,
        agentName: graph.name,
        graphManifest,
        initial: options.session ?? Session.create<TVars>(),
        status: 'open',
        once: createCheckpointOnceMemoStore(),
        outbox: [],
        inbox: [],
        providerSessions: {},
        recordLevel: this.recordLevel,
        graphCursor: 0,
        services: cloneDurableRuntimeValue(options.services),
      };
      await this.store.create(runId, run);
      this.setPersistedSessionBaseline(runId, run.initial);
      if (options.input !== undefined) {
        await this.append(runId, normalizeInbound(options.input));
      }
      return this.resumeImpl<TVars>(runId);
    }
    return this.executeAgentRun(agent, options);
  }

  private assertAppCheckpointStore(
    checkpoint: CheckpointOption | undefined,
  ): void {
    const store = checkpointOptionStore(checkpoint);
    if (store && store !== this.store && store !== this.baseStore) {
      throw new Error(
        'App checkpoint store overrides are not supported yet. Configure the store on PromptTrail.app({ store }) and use checkpoint: true.',
      );
    }
  }

  private async executeAgentRun<TVars extends Vars = Vars>(
    agent: Agent<TVars>,
    options: PromptTrailRunOptions<TVars>,
  ): Promise<DurableRunResult<TVars>> {
    const graph = agent.toGraph();
    const runId = options.runId ?? `${graph.name}-${++this.runCounter}`;
    let eventSeq = 0;
    const emitGraphRunEvent = async (
      type: 'run.started' | 'run.completed' | 'run.suspended' | 'error',
      event: Partial<ExecutionEvent> = {},
    ) => {
      const seq = eventSeq++;
      await this.observerBus.emit(
        {
          id: `${runId}:${seq}:${type}`,
          type,
          at: new Date().toISOString(),
          seq,
          conversationId: runId,
          runId,
          source: 'app',
          ...event,
          idempotencyKey:
            event.idempotencyKey ?? runEventIdempotencyKey(runId, seq, type),
        },
        observerContextFromRunServices(options.services),
      );
    };
    await emitGraphRunEvent('run.started', { sessionVersion: 0 });
    try {
      const session = await agent.execute({
        session: options.session,
        input:
          options.input === undefined
            ? undefined
            : graphInboundFromAppInput(options.input),
        services: options.services,
      });
      await emitGraphRunEvent('run.completed', {
        sessionVersion: session.messages.length,
      });
      return { status: 'done', runId, session };
    } catch (error) {
      if (error instanceof GraphExecutionSuspended) {
        const session =
          (error.session as Session<TVars> | undefined) ??
          options.session ??
          Session.create<TVars>();
        await emitGraphRunEvent('run.suspended', {
          stepId: error.nodePath,
          sessionVersion: session.messages.length,
        });
        return {
          status: 'suspended',
          runId,
          awaiting: error.nodePath,
          session,
        };
      }
      await emitGraphRunEvent('error', {
        sessionVersion: 0,
        raw: { error },
      });
      throw error;
    }
  }

  private async resumeAgentRun<TVars extends Vars = Vars>(
    runId: string,
    run: StoredRun<TVars> & { agent: Agent<TVars> },
  ): Promise<DurableRunResult<TVars>> {
    const graph = run.agent.toGraph();
    const checkpoint = beginCheckpointGraphExecution(run);
    // The persisted inbox cursor must never run ahead of the session the graph
    // has actually produced, so it is advanced only at a terminal boundary
    // (completion/suspension) to a value derived from how much of the inbox the
    // executor consumed. `consumedInSlice` tracks that count for the tail slice
    // handed to this attempt; the absolute cursor is `checkpoint.cursor + it`.
    let consumedInSlice = 0;
    const skipNodePaths = checkpoint.isContinuation
      ? computeCheckpointContinuationSkipNodes(
          graph.nodes,
          graph.name,
          checkpoint.resumeFromNode,
        )
      : undefined;
    const inbox = checkpoint.inbox.map((input) =>
      graphInboundFromStoredInbound(input),
    );
    const durableBoundary = createCheckpointOnceBoundary(run, (entry) =>
      this.recordOnce(runId, entry),
    );

    try {
      const session = await executeAgentGraph<TVars>(
        {
          ...graph,
          middleware: [
            ...graph.middleware,
            ...(this.middleware as readonly MiddlewareDefinition<TVars>[]),
          ],
          hooks: [
            ...graph.hooks,
            ...(this.hooks as readonly HookDefinition<TVars>[]),
          ],
        },
        {
          session: checkpoint.session,
          input: inbox,
          services: cloneDurableRuntimeValue(run.services),
          eventScopeId: runId,
          nextEventSeq: () => this.nextRunEventSeq(runId),
          durableBoundary: () => durableBoundary,
          durableToolExecution: (_context, execute) => {
            return execute(durableBoundary);
          },
          providerSessions: run.providerSessions,
          recordProviderSession: (nodePath, binding) =>
            this.recordProviderSession(runId, run, nodePath, binding),
          observerDeliveryBindings: this.observerDeliveryBindingOptions,
          strictObservers: this.strictObservers,
          resumeFromNode: checkpoint.resumeFromNode,
          skipNode: createCheckpointContinuationSkipPredicate(skipNodePaths),
          onInboxConsumed: (consumed) => {
            consumedInSlice = consumed;
          },
          firedTimers: firedTimerIds(run),
          armTimer: (timerId, durationMs) =>
            this.armTimer(runId, run, timerId, durationMs),
          observers: [
            async (event) => {
              await this.emitObservers(run, event);
              await this.persistRun(runId, run);
            },
          ],
        },
      );
      await recordCheckpointGraphCompletion(
        run,
        session,
        checkpoint.cursor + consumedInSlice,
        async () => {
          await this.materializeAssistantDeliveriesForRun(runId, run);
          await this.persistRun(runId, run);
        },
      );
      return { status: 'done', runId, session };
    } catch (error) {
      if (error instanceof GraphExecutionSuspended) {
        const session =
          (error.session as Session<TVars> | undefined) ??
          run.result ??
          run.initial;
        await recordCheckpointGraphSuspension(
          run,
          error.nodePath,
          session,
          checkpoint.cursor + consumedInSlice,
          () => this.persistRun(runId, run),
        );
        return {
          status: 'suspended',
          runId,
          awaiting: error.nodePath,
          session,
        };
      }
      try {
        await restoreCheckpointGraphEntryPoint(run, checkpoint, () =>
          this.persistRun(runId, run),
        );
      } catch (rollbackError) {
        throw new CheckpointRollbackError(error, rollbackError);
      }
      throw error;
    }
  }

  private async assertGraphRunManifest<TVars extends Vars = Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): Promise<void> {
    const graph = run.agent.toGraph();
    const manifest = createAgentGraphManifest(graph);
    if (!run.graphManifest) {
      run.graphManifest = manifest;
      await this.persistRun(runId, run);
      return;
    }
    if (run.graphManifest.hash !== manifest.hash) {
      throw new AgentGraphVersionError(
        run.graphManifest.hash,
        manifest.hash,
        graph.name,
      );
    }
  }

  private async emitObservers<TVars extends Vars>(
    run: StoredRun<TVars>,
    event: ExecutionEvent,
  ): Promise<void> {
    await this.emitObserverBuses(run, event);
  }

  private async emitObserverBuses<TVars extends Vars>(
    run: StoredRun<TVars>,
    event: ExecutionEvent,
  ): Promise<void> {
    const context = observerContextFromRunServices(run.services);
    await this.observerBus.emit(event, context);
    for (const bus of this.observerBuses) {
      await bus.emit(event, context);
    }
  }

  private registeredAgents(): Record<string, PromptTrailRegisteredAgent> {
    return Object.fromEntries(this.agents.entries());
  }

  private nextRunEventSeq(runId: string): number {
    const seq = this.runEventSeqs.get(runId) ?? 0;
    this.runEventSeqs.set(runId, seq + 1);
    return seq;
  }

  private async append(
    runId: string,
    message: Omit<Inbound, 'offset'>,
  ): Promise<void> {
    const run = await this.getRun(runId);
    const inbound = { ...message, offset: run.inbox.length };
    run.inbox.push(inbound);
    await this.store.appendInbox(runId, inbound);
    if (run.status === 'done') {
      run.status = 'open';
      await this.store.patch(runId, { status: run.status });
    }
  }

  private async persistRun<TVars extends Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): Promise<void> {
    const delta = this.computeSessionCheckpointDelta(runId, run);
    if (delta) {
      await this.store.appendSessionDelta(runId, delta);
      this.setPersistedSessionBaseline(runId, run.result ?? run.initial);
    }
    await this.store.patch(runId, {
      status: run.status,
      graphCursor: run.graphCursor,
      graphSuspendedAt: run.graphSuspendedAt,
      services: run.services,
      agentName: run.agentName,
      graphManifest: run.graphManifest,
    });
  }

  private async recordOnce(
    runId: string,
    entry: CheckpointOnceMemoEntry,
  ): Promise<void> {
    await this.store.recordOnce(runId, entry.scope, entry.key, entry.value);
  }

  private async recordProviderSession<TVars extends Vars>(
    runId: string,
    run: StoredRun<TVars>,
    nodePath: string,
    binding: ProviderSessionBinding,
  ): Promise<void> {
    run.providerSessions = {
      ...(run.providerSessions ?? {}),
      [nodePath]: binding,
    };
    await this.store.recordProviderSession(runId, nodePath, binding);
  }

  private async persistAssistantDeliveryOutbox<TVars extends Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): Promise<void> {
    for (const entry of run.outbox ?? []) {
      await this.store.upsertOutbox(runId, entry);
    }
  }

  private computeSessionCheckpointDelta<TVars extends Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): SessionCheckpointDelta<TVars> | undefined {
    const session = run.result ?? run.initial;
    const baseline =
      this.persistedSessions.get(runId) ??
      this.setPersistedSessionBaseline(runId, session);
    if (session.version === baseline.version) {
      return undefined;
    }

    if (session.historyRewrittenAtVersion > baseline.version) {
      return {
        fromVersion: baseline.version,
        toVersion: session.version,
        appendedMessages: session.messages,
        varsSet: { ...session.vars },
        rewrite: true,
      };
    }

    const varsDiff = diffVars(baseline.vars, session.vars);
    return {
      fromVersion: baseline.version,
      toVersion: session.version,
      appendedMessages: session.messages.slice(baseline.messageCount),
      ...(Object.keys(varsDiff.varsSet).length > 0
        ? { varsSet: varsDiff.varsSet }
        : {}),
      ...(varsDiff.varsDeleted.length > 0
        ? { varsDeleted: varsDiff.varsDeleted }
        : {}),
    };
  }

  private setPersistedSessionBaseline<TVars extends Vars>(
    runId: string,
    session: Session<TVars>,
  ): { version: number; messageCount: number; vars: Record<string, unknown> } {
    const baseline = {
      version: session.version,
      messageCount: session.messages.length,
      vars: { ...session.vars },
    };
    this.persistedSessions.set(runId, baseline);
    return baseline;
  }

  private resolveAgent<TVars extends Vars>(
    registeredAgent: string | PromptTrailRegisteredAgent<TVars>,
  ): Agent<TVars> | undefined {
    if (typeof registeredAgent === 'string') {
      return this.agents.get(registeredAgent) as Agent<TVars> | undefined;
    }
    return registeredAgent;
  }

  private async getRun<TVars extends Vars>(
    runId: string,
  ): Promise<StoredRun<TVars>> {
    const run = await this.store.get(runId);
    if (!run) {
      throw new Error(`Unknown durable run: ${runId}`);
    }
    return run as StoredRun<TVars>;
  }
}

function normalizeInbound(
  input: string | Omit<Inbound, 'offset'>,
): Omit<Inbound, 'offset'> {
  return typeof input === 'string' ? { kind: 'user', content: input } : input;
}

/** Ids of the run's already-fired timers — the sleep executor's pass-through set. */
function firedTimerIds(run: StoredRun<any>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const timer of run.timers ?? []) {
    if (timer.firedAt !== undefined) {
      ids.add(timer.id);
    }
  }
  return ids;
}

function deliveryTargetFromServices(
  services: Record<string, unknown> | undefined,
): DeliveryTarget | undefined {
  const delivery = services?.delivery;
  if (
    delivery &&
    typeof delivery === 'object' &&
    'platform' in delivery &&
    typeof (delivery as { platform?: unknown }).platform === 'string'
  ) {
    return delivery as DeliveryTarget;
  }
  return undefined;
}

function observerContextFromRunServices(
  services: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    runServices: cloneDurableRuntimeValue(services),
    delivery: cloneDurableRuntimeValue(deliveryTargetFromServices(services)),
  };
}

function isRetryableAssistantDeliveryStatus(
  status: AssistantDeliveryOutboxEntry['status'],
): boolean {
  return status === 'pending' || status === 'delivering' || status === 'failed';
}

function createAssistantDeliveryOutboxEntry(
  conversationId: string,
  delivery: AssistantDeliveryOutboxInput,
): AssistantDeliveryOutboxEntry {
  return completeAssistantDeliveryOutboxMetadata(conversationId, {
    ...delivery,
    target: cloneDurableRuntimeValue(delivery.target),
    status: 'pending',
    attempts: 0,
  });
}

function completeAssistantDeliveryOutboxMetadata(
  conversationId: string,
  entry: AssistantDeliveryOutboxInput &
    Partial<
      Pick<
        AssistantDeliveryOutboxEntry,
        'id' | 'conversationId' | 'messageRef' | 'platformBinding'
      >
    > &
    Pick<
      AssistantDeliveryOutboxEntry,
      'status' | 'attempts' | 'lastError' | 'error'
    >,
): AssistantDeliveryOutboxEntry {
  return {
    ...entry,
    id: entry.id ?? entry.idempotencyKey,
    conversationId: entry.conversationId ?? conversationId,
    messageRef: entry.messageRef ?? {
      conversationId,
      assistantIndex: entry.assistantIndex,
    },
  };
}

function cloneDurableRuntimeValue<T>(value: T): T {
  if (!value || typeof value !== 'object') {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    if (Array.isArray(value)) {
      return [...value] as T;
    }
    return { ...(value as Record<string, unknown>) } as T;
  }
}

function applySessionCheckpointDelta<TVars extends Vars>(
  run: StoredRun<TVars>,
  delta: SessionCheckpointDelta<TVars>,
): void {
  const current = run.result ?? run.initial;
  if (current.version >= delta.toVersion) {
    return;
  }
  if (delta.rewrite) {
    run.result = new Session<TVars>(
      [...delta.appendedMessages],
      { ...(delta.varsSet ?? {}) } as TVars,
      current.print,
      delta.toVersion,
      delta.toVersion,
    );
    return;
  }
  const vars = { ...current.vars } as Record<string, unknown>;
  for (const key of delta.varsDeleted ?? []) {
    delete vars[key];
  }
  Object.assign(vars, delta.varsSet);
  run.result = new Session<TVars>(
    [...current.messages, ...delta.appendedMessages],
    vars as TVars,
    current.print,
    delta.toVersion,
  );
}

function diffVars(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): { varsSet: Record<string, unknown>; varsDeleted: string[] } {
  const varsSet: Record<string, unknown> = {};
  const varsDeleted: string[] = [];
  for (const key of Object.keys(previous)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      varsDeleted.push(key);
    }
  }
  for (const [key, value] of Object.entries(next)) {
    if (!Object.is(previous[key], value)) {
      varsSet[key] = value;
    }
  }
  return { varsSet, varsDeleted };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registeredAgentName(agent: PromptTrailRegisteredAgent): string {
  if (typeof agent.name === 'string' && agent.name.length > 0) {
    return agent.name;
  }
  throw new Error('PromptTrail.app.agent requires Agent.create(name).');
}

function graphInboundFromAppInput(
  input: string | Omit<Inbound, 'offset'>,
): GraphInboundInput {
  if (typeof input === 'string') {
    return { kind: 'user', content: input };
  }
  return {
    kind: input.kind,
    content: input.content,
    attrs: input.attrs,
  };
}

function graphInboundFromStoredInbound(input: Inbound): GraphInboundInput {
  return {
    kind: input.kind,
    content: input.content,
    attrs: input.attrs,
  };
}

function runEventIdempotencyKey(
  runId: string,
  seq: number,
  type: string,
): string {
  return `${runId}:run:${seq}:${type}`;
}

function checkpointOptionStore(
  option: CheckpointOption | undefined,
): RunStore | undefined {
  if (option === undefined || option === true) {
    return undefined;
  }
  if (isRunStore(option)) {
    return option;
  }
  return option.store;
}

function isRunStore(value: unknown): value is RunStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    'get' in value &&
    'has' in value &&
    'create' in value &&
    'patch' in value &&
    'appendInbox' in value &&
    'appendSessionDelta' in value &&
    'recordOnce' in value &&
    'upsertOutbox' in value &&
    'delete' in value &&
    'entries' in value
  );
}

export function memoryStore(): DurableRunStore {
  return new MemoryRunStore();
}

export function app(options: PromptTrailAppOptions = {}): PromptTrailApp {
  return new PromptTrailApp(options);
}

export function manualGateway(): AppGateway & {
  emit(event: InboundRuntimeEvent): Promise<void>;
} {
  let emitEvent: ((event: InboundRuntimeEvent) => Promise<void>) | undefined;
  return {
    start(emit) {
      emitEvent = emit;
    },
    async emit(event) {
      if (!emitEvent) {
        throw new Error('Manual gateway has not been started');
      }
      await emitEvent(event);
    },
  };
}

export const PromptTrail = {
  app,
  runtimeBundle: createRuntimeBundle,
  server,
};
