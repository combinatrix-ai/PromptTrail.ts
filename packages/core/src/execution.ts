import type { Message } from './message';
import { Session, type Attrs, type Vars } from './session';

export interface DeleteValue {
  readonly __prompttrailDelete: true;
}

export const DELETE_VALUE: DeleteValue = Object.freeze({
  __prompttrailDelete: true,
});

export function isDeleteValue(value: unknown): value is DeleteValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).__prompttrailDelete === true
  );
}

export type AuthoredSessionPatch<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> =
  | Session<TVars, TAttrs>
  | ((session: Session<TVars, TAttrs>) => Session<TVars, TAttrs>)
  | {
      appendMessages?: readonly Message<TAttrs>[];
      replaceMessages?: readonly Message<TAttrs>[];
      vars?: Record<string, unknown | DeleteValue>;
      middlewareState?: Record<string, unknown | DeleteValue>;
    };

export type ResolvedExecutionCommand =
  | { type: 'none' }
  | { type: 'suspend'; reason?: string }
  | { type: 'jump'; target: string }
  | { type: 'halt'; reason?: string }
  | { type: 'retry'; reason?: string };

export interface ExecutionPatch<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  session?: AuthoredSessionPatch<TVars, TAttrs>;
  request?: unknown;
  result?: unknown;
  command?: Exclude<ResolvedExecutionCommand, { type: 'none' }>;
}

export interface ResolvedSessionDelta<TAttrs extends Attrs = Attrs> {
  messageOp:
    | { type: 'append'; messages: readonly Message<TAttrs>[] }
    | { type: 'replace'; messages: readonly Message<TAttrs>[] }
    | { type: 'none' };
  varsSet: Record<string, unknown>;
  varsDelete: readonly string[];
  middlewareStateSet: Record<string, unknown>;
  middlewareStateDelete: readonly string[];
}

export interface ResolvedExecutionTransition<TAttrs extends Attrs = Attrs> {
  schemaVersion: 1;
  beforeVersion: number;
  afterVersion: number;
  session: ResolvedSessionDelta<TAttrs>;
  command: ResolvedExecutionCommand;
}

export interface ResolveExecutionTransitionOptions {
  beforeVersion?: number;
}

export function resolveExecutionTransition<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
>(
  session: Session<TVars, TAttrs>,
  patch: ExecutionPatch<TVars, TAttrs> = {},
  options: ResolveExecutionTransitionOptions = {},
): ResolvedExecutionTransition<TAttrs> {
  const beforeVersion = options.beforeVersion ?? 0;
  const sessionDelta = patch.session
    ? resolveSessionDelta(session, patch.session)
    : emptySessionDelta<TAttrs>();
  return {
    schemaVersion: 1,
    beforeVersion,
    afterVersion: isEmptySessionDelta(sessionDelta)
      ? beforeVersion
      : beforeVersion + 1,
    session: sessionDelta,
    command: patch.command ?? { type: 'none' },
  };
}

export function resolveSessionDelta<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
>(
  session: Session<TVars, TAttrs>,
  patch: AuthoredSessionPatch<TVars, TAttrs>,
): ResolvedSessionDelta<TAttrs> {
  if (patch instanceof Session) {
    return diffSession(session, patch);
  }
  if (typeof patch === 'function') {
    return diffSession(session, patch(session));
  }

  if (patch.appendMessages && patch.replaceMessages) {
    throw new Error(
      'Session patch cannot include both appendMessages and replaceMessages.',
    );
  }

  return {
    messageOp: patch.replaceMessages
      ? { type: 'replace', messages: [...patch.replaceMessages] }
      : patch.appendMessages
        ? { type: 'append', messages: [...patch.appendMessages] }
        : { type: 'none' },
    ...partitionWrites(patch.vars, 'vars'),
    ...partitionMiddlewareState(patch.middlewareState),
  };
}

export interface ApplyExecutionTransitionOptions {
  middlewareState?: Record<string, unknown>;
}

export interface ApplyExecutionTransitionResult<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  session: Session<TVars, TAttrs>;
  middlewareState: Record<string, unknown>;
  command: ResolvedExecutionCommand;
}

export function applyResolvedExecutionTransition<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
>(
  session: Session<TVars, TAttrs>,
  transition: ResolvedExecutionTransition<TAttrs>,
  options: ApplyExecutionTransitionOptions = {},
): ApplyExecutionTransitionResult<TVars, TAttrs> {
  const messages =
    transition.session.messageOp.type === 'append'
      ? [...session.messages, ...transition.session.messageOp.messages]
      : transition.session.messageOp.type === 'replace'
        ? [...transition.session.messageOp.messages]
        : [...session.messages];
  const vars = applyKeyWrites(
    session.getVarsObject(),
    transition.session.varsSet,
    transition.session.varsDelete,
  ) as TVars;
  const middlewareState = applyKeyWrites(
    options.middlewareState ?? {},
    transition.session.middlewareStateSet,
    transition.session.middlewareStateDelete,
  );

  return {
    session: new Session<TVars, TAttrs>(messages, vars, session.print),
    middlewareState,
    command: transition.command,
  };
}

export type RuntimeReplayMode = 'live' | 'journaled' | 'replayed';

export interface ExecutionEventBase {
  id: string;
  type: string;
  at: string;
  seq: number;
  conversationId?: string;
  runId?: string;
  turnId?: string;
  templatePath?: string;
  stepId?: string;
  phase?: string;
  source?: string;
  replay?: RuntimeReplayMode;
  idempotencyKey?: string;
  sessionVersion?: number;
  raw?: unknown;
}

export type ExecutionEvent = ExecutionEventBase & Record<string, unknown>;

export type ObserverReplayPolicy =
  | 'live-only'
  | 'live-and-journaled'
  | 'adopt-replayed';

export interface ObserverContext {
  signal?: AbortSignal;
  [key: string]: unknown;
}

export interface Observer {
  name?: string;
  replayPolicy?: ObserverReplayPolicy;
  handle(event: ExecutionEvent, context: ObserverContext): Promise<void> | void;
}

export type ObserverLike =
  | Observer
  | ((event: ExecutionEvent, context: ObserverContext) => Promise<void> | void);

export interface ObserverBusOptions {
  strictObservers?: boolean;
}

export class ObserverFailureError extends Error {
  constructor(
    readonly observerName: string,
    readonly event: ExecutionEvent,
    readonly failure: unknown,
  ) {
    super(
      `Observer ${observerName} failed handling ${event.type}: ${errorMessage(failure)}`,
    );
    this.name = 'ObserverFailureError';
  }
}

export class ObserverBus {
  private readonly observers: Observer[];
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    observers: readonly ObserverLike[] = [],
    private readonly options: ObserverBusOptions = {},
  ) {
    this.observers = observers.map(normalizeObserver);
  }

  async emit(
    event: ExecutionEvent,
    context: ObserverContext = {},
  ): Promise<void> {
    const failures = (
      await Promise.all(
        this.observers
          .map((observer, index) => ({
            key: observer.name ?? `observer:${index}`,
            observer,
          }))
          .filter(({ observer }) => observerReceives(observer, event))
          .map(async ({ key, observer }) => {
            try {
              await this.enqueue(key, observer, event, context);
              return undefined;
            } catch (error) {
              const failure = new ObserverFailureError(
                observer.name ?? key,
                event,
                error,
              );
              await this.emitObserverFailed(
                key,
                observer,
                event,
                error,
                context,
              );
              return failure;
            }
          }),
      )
    ).filter((error): error is ObserverFailureError => error !== undefined);
    if (this.options.strictObservers && failures.length > 0) {
      throw failures[0];
    }
  }

  private async emitObserverFailed(
    failedKey: string,
    failedObserver: Observer,
    originalEvent: ExecutionEvent,
    error: unknown,
    context: ObserverContext,
  ): Promise<void> {
    const failureEvent: ExecutionEvent = {
      id: `${originalEvent.id}:observer:${failedKey}:failed`,
      type: 'observer.failed',
      at: new Date().toISOString(),
      seq: originalEvent.seq,
      conversationId: originalEvent.conversationId,
      runId: originalEvent.runId,
      turnId: originalEvent.turnId,
      templatePath: originalEvent.templatePath,
      stepId: originalEvent.stepId,
      replay: originalEvent.replay ?? 'live',
      raw: {
        observer: failedObserver.name,
        observerKey: failedKey,
        event: {
          id: originalEvent.id,
          type: originalEvent.type,
          seq: originalEvent.seq,
        },
        error,
      },
    };
    await Promise.all(
      this.observers
        .map((observer, index) => ({
          key: observer.name ?? `observer:${index}`,
          observer,
        }))
        .filter(
          ({ key, observer }) =>
            key !== failedKey && observerReceives(observer, failureEvent),
        )
        .map(async ({ key, observer }) => {
          try {
            await this.enqueue(key, observer, failureEvent, context);
          } catch {
            // observer.failed is diagnostic only; failures while reporting it
            // must not recurse indefinitely.
          }
        }),
    );
  }

  private async enqueue(
    key: string,
    observer: Observer,
    event: ExecutionEvent,
    context: ObserverContext,
  ): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => observer.handle(event, context));
    this.queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    await next;
  }
}

export function normalizeObserver(observer: ObserverLike): Observer {
  if (typeof observer === 'function') {
    return { handle: observer };
  }
  return observer;
}

export function observerReceives(
  observer: Observer,
  event: ExecutionEvent,
): boolean {
  const replay = event.replay ?? 'live';
  switch (observer.replayPolicy ?? 'live-and-journaled') {
    case 'live-only':
      return replay === 'live';
    case 'live-and-journaled':
      return replay === 'live' || replay === 'journaled';
    case 'adopt-replayed':
      return true;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function diffSession<TVars extends Vars, TAttrs extends Attrs>(
  before: Session<TVars, TAttrs>,
  after: Session<TVars, TAttrs>,
): ResolvedSessionDelta<TAttrs> {
  const messageOp = hasMessagePrefix(before.messages, after.messages)
    ? {
        type: 'append' as const,
        messages: after.messages.slice(before.messages.length),
      }
    : { type: 'replace' as const, messages: [...after.messages] };
  const varsSet: Record<string, unknown> = {};
  const varsDelete: string[] = [];
  const beforeVars = before.getVarsObject() as Record<string, unknown>;
  const afterVars = after.getVarsObject() as Record<string, unknown>;
  for (const [key, value] of Object.entries(afterVars)) {
    if (value === undefined) {
      throw new Error(`Session patch vars.${key} cannot be undefined.`);
    }
    if (!Object.is(beforeVars[key], value)) {
      varsSet[key] = value;
    }
  }
  for (const key of Object.keys(beforeVars)) {
    if (!(key in afterVars)) {
      varsDelete.push(key);
    }
  }

  return {
    messageOp,
    varsSet,
    varsDelete,
    middlewareStateSet: {},
    middlewareStateDelete: [],
  };
}

function emptySessionDelta<
  TAttrs extends Attrs,
>(): ResolvedSessionDelta<TAttrs> {
  return {
    messageOp: { type: 'none' },
    varsSet: {},
    varsDelete: [],
    middlewareStateSet: {},
    middlewareStateDelete: [],
  };
}

function isEmptySessionDelta(delta: ResolvedSessionDelta): boolean {
  return (
    delta.messageOp.type === 'none' &&
    Object.keys(delta.varsSet).length === 0 &&
    delta.varsDelete.length === 0 &&
    Object.keys(delta.middlewareStateSet).length === 0 &&
    delta.middlewareStateDelete.length === 0
  );
}

function partitionWrites(
  input: Record<string, unknown | DeleteValue> | undefined,
  label: string,
): Pick<ResolvedSessionDelta, 'varsSet' | 'varsDelete'> {
  const varsSet: Record<string, unknown> = {};
  const varsDelete: string[] = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    if (isDeleteValue(value)) {
      varsDelete.push(key);
    } else if (value === undefined) {
      throw new Error(`Session patch ${label}.${key} cannot be undefined.`);
    } else {
      varsSet[key] = value;
    }
  }
  return { varsSet, varsDelete };
}

function partitionMiddlewareState(
  input: Record<string, unknown | DeleteValue> | undefined,
): Pick<ResolvedSessionDelta, 'middlewareStateSet' | 'middlewareStateDelete'> {
  const middlewareStateSet: Record<string, unknown> = {};
  const middlewareStateDelete: string[] = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    if (isDeleteValue(value)) {
      middlewareStateDelete.push(key);
    } else if (value === undefined) {
      throw new Error(
        `Session patch middlewareState.${key} cannot be undefined.`,
      );
    } else {
      middlewareStateSet[key] = value;
    }
  }
  return { middlewareStateSet, middlewareStateDelete };
}

function applyKeyWrites(
  base: Record<string, unknown>,
  set: Record<string, unknown>,
  deleteKeys: readonly string[],
): Record<string, unknown> {
  const next = { ...base, ...set };
  for (const key of deleteKeys) {
    delete next[key];
  }
  return next;
}

function hasMessagePrefix<TAttrs extends Attrs>(
  prefix: readonly Message<TAttrs>[],
  messages: readonly Message<TAttrs>[],
): boolean {
  if (prefix.length > messages.length) {
    return false;
  }
  return prefix.every((message, index) =>
    messagesAreEquivalent(message, messages[index]),
  );
}

function messagesAreEquivalent<TAttrs extends Attrs>(
  left: Message<TAttrs>,
  right: Message<TAttrs> | undefined,
): boolean {
  if (!right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value, new WeakSet<object>()));
}

function toStableJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined || typeof value === 'function') {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (value instanceof Date) {
    return value.toJSON();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toStableJsonValue(item, seen) ?? null);
  }
  if (seen.has(value)) {
    throw new Error('Cannot compare messages with circular references.');
  }
  seen.add(value);
  const sorted: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value).sort(
    ([leftKey], [rightKey]) =>
      leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0,
  )) {
    const stableValue = toStableJsonValue(entryValue, seen);
    if (stableValue !== undefined) {
      sorted[key] = stableValue;
    }
  }
  seen.delete(value);
  return sorted;
}
