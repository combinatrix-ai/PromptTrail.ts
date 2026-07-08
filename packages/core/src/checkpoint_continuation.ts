import type { AgentGraphNode } from './graph';
import type { GraphExecutionOptions } from './graph_executor';
import { Session, type Vars } from './session';

export type CheckpointOnceScope = 'run' | 'conversation';

export interface CheckpointOnceOptions {
  scope?: CheckpointOnceScope;
}

export interface CheckpointOnceBoundary {
  once<T>(
    name: string,
    dep: unknown,
    fn: () => T | Promise<T>,
    options?: CheckpointOnceOptions,
  ): Promise<T>;
}

export interface CheckpointOnceMemoStore {
  run: Map<string, unknown>;
  conversation: Map<string, unknown>;
}

export interface CheckpointOnceMemoEntry {
  scope: CheckpointOnceScope;
  key: string;
  value: unknown;
}

interface CheckpointGraphRunState<TVars extends Vars, TInbound> {
  initial: Session<TVars>;
  result?: Session<TVars>;
  inbox: TInbound[];
  graphCursor?: number;
  graphSuspendedAt?: string;
}

interface CompletableCheckpointGraphRunState<TVars extends Vars, TInbound>
  extends CheckpointGraphRunState<TVars, TInbound> {
  status: 'open' | 'done';
}

export interface CheckpointGraphExecutionStart<TVars extends Vars, TInbound> {
  cursor: number;
  session: Session<TVars>;
  inbox: TInbound[];
  resumeFromNode?: string;
  isContinuation: boolean;
}

/**
 * Checkpoint continuation model:
 *
 * The run store keeps the latest session checkpoint and inbox cursor at graph
 * boundaries. A resume never replays an old journal; it starts from the stored
 * session and the stored inbox cursor and runs the graph forward over the
 * unconsumed inbox tail. For continuations, deterministic bootstrap nodes before
 * the next inbound/suspended coordinate are skipped once so static system/user
 * prefixes are not duplicated, while `resumeFromNode` lets loops re-enter the
 * suspended node's children even when their condition is currently false.
 *
 * Persistence contract (crash-durability): the inbox cursor is NEVER advanced
 * before the graph runs. It advances only at a terminal boundary — suspension
 * ({@link recordCheckpointGraphSuspension}) or completion
 * ({@link recordCheckpointGraphCompletion}) — in the SAME persist that writes the
 * session the graph produced, and to a value derived from how much inbox the
 * executor actually consumed. Because that single persist writes the session
 * delta before the cursor, at every rest point (including a hard process crash
 * mid-execution, which the error handler cannot intercept) the persisted
 * `(graphCursor, session)` pair is mutually consistent and the cursor is never
 * ahead of the consumption the persisted session reflects. A cold restart after
 * a mid-execution crash therefore re-delivers the still-unconsumed inbox tail
 * (at-least-once); keyed effects dedupe via the once memo / declared idempotency
 * keys so re-running the interrupted attempt is safe.
 *
 * Keyed external effects are still at-least-once. The local once memo records
 * keyed durable effect results after the effect and before the next checkpoint
 * so retries can reuse the recorded value when the store has it; effective-once
 * still requires the remote system to deduplicate by the declared idempotency
 * key. Repeatable effects deliberately bypass this memo.
 *
 * Error rollback: a non-suspend error discards the attempt via
 * {@link restoreCheckpointGraphEntryPoint}, re-asserting the entry-point cursor,
 * session, and suspension coordinate captured here. Because none of those fields
 * are advanced before a boundary, the reset is a no-op in the common case, but
 * the explicit re-assert keeps the persisted `(graphCursor, session)` pair
 * consistent even if a future change mutates them mid-attempt. A suspension is
 * NOT a failure and never rolls back. If the rollback persist itself fails, both
 * the original run error and the rollback error are surfaced together via
 * {@link CheckpointRollbackError}.
 */
export function beginCheckpointGraphExecution<TVars extends Vars, TInbound>(
  run: CheckpointGraphRunState<TVars, TInbound>,
): CheckpointGraphExecutionStart<TVars, TInbound> {
  const cursor = run.graphCursor ?? 0;
  return {
    cursor,
    session: run.result ?? run.initial,
    inbox: run.inbox.slice(cursor),
    resumeFromNode: deriveCheckpointResumeCoordinate(run),
    isContinuation: run.result !== undefined,
  };
}

/**
 * Returns the graph coordinate where a checkpoint continuation should resume.
 *
 * The coordinate is undefined for ordinary forward resumes and set only when the
 * previous execution suspended inside the graph.
 */
export function deriveCheckpointResumeCoordinate(
  run: Pick<CheckpointGraphRunState<Vars, unknown>, 'graphSuspendedAt'>,
): string | undefined {
  return run.graphSuspendedAt;
}

/**
 * Computes the deterministic graph prefix to skip for a continuation.
 *
 * Traversal stops at the suspended coordinate when present; otherwise it stops
 * at the first inbound consumer. Static bootstrap nodes and leaf nodes before
 * that entry point are skipped once by the caller's skip predicate.
 */
export function computeCheckpointContinuationSkipNodes(
  nodes: readonly AgentGraphNode[],
  graphName: string,
  resumeFromNode?: string,
): Set<string> {
  const skipNodePaths = new Set<string>();
  let reachedContinuationEntry = false;

  const visit = (
    children: readonly AgentGraphNode[],
    parentPath: string,
  ): void => {
    for (const child of children) {
      if (reachedContinuationEntry) {
        return;
      }
      const nodePath = `${parentPath}/${child.id}`;
      if (
        (resumeFromNode && nodePath === resumeFromNode) ||
        (!resumeFromNode && isGraphInboundConsumerNode(child))
      ) {
        reachedContinuationEntry = true;
        return;
      }
      if (
        skipCheckpointBootstrapNode(child) ||
        (child.children ?? []).length === 0
      ) {
        skipNodePaths.add(nodePath);
      }
      visit(child.children ?? [], nodePath);
    }
  };

  visit(nodes, graphName);
  return skipNodePaths;
}

export function createCheckpointContinuationSkipPredicate<TVars extends Vars>(
  skipNodePaths: Set<string> | undefined,
): GraphExecutionOptions<TVars>['skipNode'] {
  if (!skipNodePaths) {
    return undefined;
  }
  return (_node, nodePath) => {
    if (!skipNodePaths.has(nodePath)) {
      return false;
    }
    skipNodePaths.delete(nodePath);
    return true;
  };
}

export async function recordCheckpointGraphCompletion<
  TVars extends Vars,
  TInbound,
>(
  run: CompletableCheckpointGraphRunState<TVars, TInbound>,
  session: Session<TVars>,
  graphCursor: number,
  persist: () => Promise<void>,
): Promise<void> {
  run.status = 'done';
  run.result = session;
  run.graphCursor = graphCursor;
  run.graphSuspendedAt = undefined;
  await persist();
}

export async function recordCheckpointGraphSuspension<
  TVars extends Vars,
  TInbound,
>(
  run: CheckpointGraphRunState<TVars, TInbound>,
  nodePath: string,
  session: Session<TVars>,
  graphCursor: number,
  persist: () => Promise<void>,
): Promise<void> {
  run.result = session;
  run.graphCursor = graphCursor;
  run.graphSuspendedAt = nodePath;
  await persist();
}

/**
 * Error raised when a checkpoint rollback cannot be persisted after a run
 * error. Both the original run error and the rollback error are retained so
 * neither is lost: `cause` and `runError` carry the original failure that
 * triggered the rollback, `rollbackError` carries the persist failure.
 */
export class CheckpointRollbackError extends Error {
  readonly cause: unknown;
  constructor(
    readonly runError: unknown,
    readonly rollbackError: unknown,
  ) {
    super(
      `Failed to persist checkpoint rollback after a run error. ` +
        `Rollback error: ${describeError(rollbackError)}. ` +
        `Original run error: ${describeError(runError)}.`,
    );
    this.name = 'CheckpointRollbackError';
    this.cause = runError;
  }
}

/**
 * Rolls a run's mutable checkpoint state back to the entry point captured by
 * {@link beginCheckpointGraphExecution} after a non-suspend error, keeping the
 * persisted `(graphCursor, session)` pair mutually consistent (see the module
 * doc comment). The failed attempt is discarded wholesale: the inbox cursor,
 * the session, and the suspension coordinate are all reset to their pre-attempt
 * values so a retry re-runs from a consistent point. Keyed effects still dedupe
 * via the once memo and deliveries via the outbox, so at-least-once semantics
 * survive the rollback.
 */
export async function restoreCheckpointGraphEntryPoint<
  TVars extends Vars,
  TInbound,
>(
  run: CheckpointGraphRunState<TVars, TInbound>,
  entry: CheckpointGraphExecutionStart<TVars, TInbound>,
  persist: () => Promise<void>,
): Promise<void> {
  run.graphCursor = entry.cursor;
  run.graphSuspendedAt = entry.resumeFromNode;
  run.result = entry.isContinuation ? entry.session : undefined;
  await persist();
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function createCheckpointOnceMemoStore(): CheckpointOnceMemoStore {
  return {
    run: new Map<string, unknown>(),
    conversation: new Map<string, unknown>(),
  };
}

export function createCheckpointOnceBoundary(
  run: { once?: CheckpointOnceMemoStore },
  recordOnce: (entry: CheckpointOnceMemoEntry) => Promise<void>,
): CheckpointOnceBoundary {
  return {
    async once(name, dep, fn, options) {
      const scope = options?.scope ?? 'run';
      const key = checkpointOnceMemoKey(name, dep);
      const memo = ensureCheckpointOnceMemoStore(run)[scope];
      if (memo.has(key)) {
        return memo.get(key) as Awaited<ReturnType<typeof fn>>;
      }
      const result = await fn();
      memo.set(key, result);
      await recordOnce({ scope, key, value: result });
      return result;
    },
  };
}

export function graphHasInboundConsumer(
  nodes: readonly AgentGraphNode[],
): boolean {
  return nodes.some(
    (node) =>
      isGraphInboundConsumerNode(node) ||
      graphHasInboundConsumer(node.children ?? []),
  );
}

function ensureCheckpointOnceMemoStore(run: {
  once?: CheckpointOnceMemoStore;
}): CheckpointOnceMemoStore {
  return (run.once ??= createCheckpointOnceMemoStore());
}

function checkpointOnceMemoKey(name: string, dep: unknown): string {
  return name + ':' + hashOnceDep(dep);
}

function hashOnceDep(dep: unknown): string {
  return fnv1a(stableSerialize(dep));
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (seen.has(value)) {
    return '"[Circular]"';
  }
  seen.add(value);
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (value instanceof Session) {
    return stableSerialize({ sessionVersion: value.version }, seen);
  }
  if (value instanceof Map) {
    return stableSerialize(
      [...value.entries()].sort(([left], [right]) =>
        stableSerialize(left).localeCompare(stableSerialize(right)),
      ),
      seen,
    );
  }
  if (value instanceof Set) {
    return stableSerialize(
      [...value.values()].sort((left, right) =>
        stableSerialize(left).localeCompare(stableSerialize(right)),
      ),
      seen,
    );
  }
  if (Array.isArray(value)) {
    return (
      '[' + value.map((item) => stableSerialize(item, seen)).join(',') + ']'
    );
  }
  const serializable = value as { toJSON?: () => unknown };
  if (typeof serializable.toJSON === 'function') {
    return stableSerialize(serializable.toJSON(), seen);
  }
  const record = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map(
        (key) => JSON.stringify(key) + ':' + stableSerialize(record[key], seen),
      )
      .join(',') +
    '}'
  );
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function skipCheckpointBootstrapNode(node: {
  type: string;
  data?: unknown;
}): boolean {
  return node.type === 'system' || isStaticGraphUserNode(node);
}

function isGraphInboundConsumerNode(node: AgentGraphNode): boolean {
  return (
    node.type === 'inbox' ||
    node.type === 'awaitInput' ||
    (node.type === 'user' && !isStaticGraphUserNode(node))
  );
}

function isStaticGraphUserNode(node: {
  type: string;
  data?: unknown;
}): boolean {
  return (
    node.type === 'user' &&
    typeof node.data === 'object' &&
    node.data !== null &&
    ('input' in node.data || 'content' in node.data)
  );
}
