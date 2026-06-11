import type { AgentGraphNode } from './graph';
import type { GraphExecutionOptions } from './graph_executor';
import { Session, type Attrs, type Vars } from './session';

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

interface CheckpointGraphRunState<
  TVars extends Vars,
  TAttrs extends Attrs,
  TInbound,
> {
  initial: Session<TVars, TAttrs>;
  result?: Session<TVars, TAttrs>;
  inbox: TInbound[];
  graphCursor?: number;
  graphSuspendedAt?: string;
}

interface CompletableCheckpointGraphRunState<
  TVars extends Vars,
  TAttrs extends Attrs,
  TInbound,
> extends CheckpointGraphRunState<TVars, TAttrs, TInbound> {
  status: 'open' | 'done';
}

export interface CheckpointGraphExecutionStart<
  TVars extends Vars,
  TAttrs extends Attrs,
  TInbound,
> {
  cursor: number;
  session: Session<TVars, TAttrs>;
  inbox: TInbound[];
  resumeFromNode?: string;
  isContinuation: boolean;
}

/**
 * Checkpoint continuation model:
 *
 * The run store keeps the latest session checkpoint and inbox cursor at graph
 * boundaries. A resume never replays an old journal; it starts from the stored
 * session, advances the inbox cursor optimistically to the current end, and runs
 * the graph forward. For continuations, deterministic bootstrap nodes before the
 * next inbound/suspended coordinate are skipped once so static system/user
 * prefixes are not duplicated, while `resumeFromNode` lets loops re-enter the
 * suspended node's children even when their condition is currently false.
 *
 * Keyed external effects are still at-least-once. The local once memo records
 * keyed durable effect results after the effect and before the next checkpoint
 * so retries can reuse the recorded value when the store has it; effective-once
 * still requires the remote system to deduplicate by the declared idempotency
 * key. Repeatable effects deliberately bypass this memo.
 */
export async function beginCheckpointGraphExecution<
  TVars extends Vars,
  TAttrs extends Attrs,
  TInbound,
>(
  run: CheckpointGraphRunState<TVars, TAttrs, TInbound>,
  persist: () => Promise<void>,
): Promise<CheckpointGraphExecutionStart<TVars, TAttrs, TInbound>> {
  const cursor = run.graphCursor ?? 0;
  const start: CheckpointGraphExecutionStart<TVars, TAttrs, TInbound> = {
    cursor,
    session: run.result ?? run.initial,
    inbox: run.inbox.slice(cursor),
    resumeFromNode: deriveCheckpointResumeCoordinate(run),
    isContinuation: run.result !== undefined,
  };
  run.graphCursor = run.inbox.length;
  await persist();
  return start;
}

/**
 * Returns the graph coordinate where a checkpoint continuation should resume.
 *
 * The coordinate is undefined for ordinary forward resumes and set only when the
 * previous execution suspended inside the graph.
 */
export function deriveCheckpointResumeCoordinate(
  run: Pick<CheckpointGraphRunState<Vars, Attrs, unknown>, 'graphSuspendedAt'>,
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

export function createCheckpointContinuationSkipPredicate<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  skipNodePaths: Set<string> | undefined,
): GraphExecutionOptions<TVars, TAttrs>['skipNode'] {
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
  TAttrs extends Attrs,
  TInbound,
>(
  run: CompletableCheckpointGraphRunState<TVars, TAttrs, TInbound>,
  session: Session<TVars, TAttrs>,
  persist: () => Promise<void>,
): Promise<void> {
  run.status = 'done';
  run.result = session;
  run.graphSuspendedAt = undefined;
  await persist();
}

export async function recordCheckpointGraphSuspension<
  TVars extends Vars,
  TAttrs extends Attrs,
  TInbound,
>(
  run: CheckpointGraphRunState<TVars, TAttrs, TInbound>,
  nodePath: string,
  session: Session<TVars, TAttrs>,
  persist: () => Promise<void>,
): Promise<void> {
  run.result = session;
  run.graphSuspendedAt = nodePath;
  await persist();
}

export async function restoreCheckpointGraphCursor<
  TVars extends Vars,
  TAttrs extends Attrs,
  TInbound,
>(
  run: CheckpointGraphRunState<TVars, TAttrs, TInbound>,
  cursor: number,
  persist: () => Promise<void>,
): Promise<void> {
  run.graphCursor = cursor;
  await persist();
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
