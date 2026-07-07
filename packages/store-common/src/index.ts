import {
  Session,
  type Agent,
  type AssistantDeliveryOutboxEntry,
  type Inbound,
  type Message,
  type OnceScope,
  type ProviderSessionBinding,
  type SessionCheckpointDelta,
  type StoredRun,
  type Vars,
} from '@prompttrail/core';

/**
 * @prompttrail/store-common
 *
 * Pure, driver-agnostic reconstruction helpers shared by every durable run
 * store backend (sqlite, postgres, and future redis/libsql). These helpers
 * contain NO database or driver imports so any backend can reuse them after
 * reading its rows.
 */

/**
 * Fold a single session checkpoint delta onto a run's reconstructed session.
 *
 * Lifted verbatim from the per-store copies (sqlite + postgres were
 * byte-identical). A `rewrite` delta replaces the message history and vars at
 * `toVersion`; a non-rewrite delta appends messages and applies the vars diff.
 */
export function applySessionDelta<TVars extends Vars>(
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

export function normalizeStoredMessages(
  messages: readonly Message[],
): Message[] {
  return messages.map(normalizeStoredMessage);
}

export function normalizeStoredMessage(message: Message): Message {
  if (message.type !== 'tool_result' || message.toolCallId !== undefined) {
    return message;
  }
  const toolCallId = message.attrs?.toolCallId;
  return typeof toolCallId === 'string' ? { ...message, toolCallId } : message;
}

export function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function parseJson<T = any>(
  json: string | null | undefined,
): T | undefined {
  return json == null ? undefined : (JSON.parse(json) as T);
}

export function parseJsonRequired<T = any>(json: string): T {
  return JSON.parse(json) as T;
}

/** One reconstructed once-memo entry (already parsed). */
export interface ReconstructOnceEntry {
  scope: OnceScope;
  key: string;
  value: unknown;
}

/**
 * Already-parsed components of a single stored run, ready to be assembled into
 * a {@link StoredRun}. Backends read their own rows, parse/normalize them, and
 * hand the results here.
 */
export interface ReconstructStoredRunInput {
  agentName: string;
  status: StoredRun<any>['status'];
  graphCursor?: number;
  graphSuspendedAt?: string;
  context?: unknown;
  /** The initial session in its `Session.toJSON()` form. */
  initialSession: unknown;
  graphManifest?: unknown;
  /** Parsed + normalized deltas, in seq order. */
  deltas: SessionCheckpointDelta<any>[];
  once: ReconstructOnceEntry[];
  inbox: Inbound[];
  outbox: AssistantDeliveryOutboxEntry[];
  providerSessions: Record<string, ProviderSessionBinding>;
}

/**
 * Assemble a {@link StoredRun} from already-parsed components.
 *
 * This is the shared body factored out of `SqliteRunStore.hydrate()` (per-run
 * portion) and `PostgresRunStore.reconstructRun()`. It is pure: callers parse
 * their backend rows first, then pass the parsed components in.
 */
export function reconstructStoredRun(
  input: ReconstructStoredRunInput,
  agents: Record<string, Agent>,
): StoredRun<any> {
  const agent = agents[input.agentName];
  if (!agent) {
    throw new Error(
      `Cannot reconstruct durable run for agent "${input.agentName}".`,
    );
  }

  const run: StoredRun<any> = {
    agent,
    agentName: input.agentName,
    graphManifest: input.graphManifest as StoredRun<any>['graphManifest'],
    initial: Session.fromJSON(input.initialSession as Record<string, unknown>),
    status: input.status,
    once: { run: new Map(), conversation: new Map() },
    outbox: [],
    inbox: [],
    providerSessions: {},
    graphCursor: input.graphCursor,
    graphSuspendedAt: input.graphSuspendedAt,
    context: input.context as StoredRun<any>['context'],
  };

  for (const delta of input.deltas) {
    applySessionDelta(run, delta);
  }

  for (const entry of input.once) {
    run.once[entry.scope].set(entry.key, entry.value);
  }

  for (const inbound of input.inbox) {
    run.inbox.push(inbound);
  }

  for (const entry of input.outbox) {
    run.outbox.push(entry);
  }

  run.providerSessions = { ...input.providerSessions };

  return run;
}
