import { Message, type Message as PromptTrailMessage } from './message';
import {
  ObserverBus,
  applyResolvedExecutionTransition,
  normalizeObserver,
  resolveExecutionTransition,
  type ExecutionEvent,
  type ExecutionPatch,
  type ObserverDeliveryBindingOptions,
  type ObserverLike,
  type ResolvedExecutionCommand,
  type ResolvedExecutionTransition,
} from './execution';
import {
  runExecutionPhase,
  runMiddlewareWrapper,
  assertHookDefinitionSupported,
  type ExecutionDurableActivityOptions,
  type ExecutionDurableRetryPolicy,
  type ExecutionDurableBoundary,
  type ExecutionDurableBoundaryProvider,
  type ExecutionHandlerDescriptor,
  type ExecutionPhase,
  type ExecutionLifecyclePhase,
  type ExecutionPhaseStep,
  type ExecutionWrapperPhase,
  type HookDefinition,
  type MiddlewareDefinition,
  type RunMiddlewareWrapperResult,
  type RunExecutionPhaseResult,
} from './interceptors';
import { assistantDeliveryKey } from './runtime_delivery_keys';
import { bundle, type DeliveryTarget } from './runtime_bindings';
import { server } from './runtime_server';
import { Session, type Attrs, type Vars } from './session';

export type InboundKind = 'user' | 'system' | 'control';

export interface Inbound {
  offset: number;
  kind: InboundKind;
  content: string;
  attrs?: Attrs;
}

export interface DurableTool<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> {
  description?: string;
  activity?:
    | DurableActivityOptions
    | ((
        call: ToolCall,
        context: DurableActivityContext,
      ) => DurableActivityOptions);
  execute(
    args: TArgs,
    context: DurableToolExecutionContext,
  ): Promise<TResult> | TResult;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id: string;
}

export type DurableActivityKind =
  | 'pure-call'
  | 'external-read'
  | 'external-write';

export type DurableActivityOptions =
  | {
      kind: Exclude<DurableActivityKind, 'external-write'>;
      idempotencyKey?: string;
      retry?: ExecutionDurableRetryPolicy;
    }
  | {
      kind: 'external-write';
      idempotencyKey: string;
      retry?: ExecutionDurableRetryPolicy;
    };

export interface DurableActivityContext {
  runId: string;
  stepId: string;
  session: Session<any, any>;
  context?: Record<string, unknown>;
}

export interface DurableToolExecutionContext extends DurableActivityContext {
  toolCall: ToolCall;
  activity: DurableActivityOptions;
  durable: ExecutionDurableBoundary;
}

export type AssistantResult<TAttrs extends Attrs = Attrs> =
  | string
  | PromptTrailMessage<TAttrs>
  | {
      content: string;
      attrs?: TAttrs;
      toolCalls?: ToolCall[];
      structuredContent?: Record<string, unknown>;
    };

export type AssistantHandler<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> = (
  session: Session<TVars, TAttrs>,
) => Promise<AssistantResult<TAttrs>> | AssistantResult<TAttrs>;

export type DurablePatchHandler<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> = (
  session: Session<TVars, TAttrs>,
) => Promise<ExecutionPatch<TVars, TAttrs>> | ExecutionPatch<TVars, TAttrs>;

export interface DurableRunResult<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  status: 'done' | 'suspended';
  runId: string;
  session: Session<TVars, TAttrs>;
  awaiting?: string;
}

export interface AssistantDeliveryOutboxInput<TAttrs extends Attrs = Attrs> {
  message: PromptTrailMessage<TAttrs> & { type: 'assistant' };
  assistantIndex: number;
  idempotencyKey: string;
  target?: unknown;
}

export interface AssistantDeliveryOutboxEntry<TAttrs extends Attrs = Attrs>
  extends AssistantDeliveryOutboxInput<TAttrs> {
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

export interface PendingAssistantDeliveryOutboxEntry<
  TAttrs extends Attrs = Attrs,
> {
  runId: string;
  entry: AssistantDeliveryOutboxEntry<TAttrs>;
}

export class Suspend extends Error {
  constructor(readonly stepId: string) {
    super(`suspend:${stepId}`);
    this.name = 'Suspend';
  }
}

export class Halt<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> extends Error {
  constructor(readonly session: Session<TVars, TAttrs>) {
    super('halt');
    this.name = 'Halt';
  }
}

export class NondeterminismError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly position: number,
  ) {
    super(
      `Durable replay diverged at journal position ${position}: expected ${expected}, got ${actual}`,
    );
    this.name = 'NondeterminismError';
  }
}

interface JournalState {
  results: Map<string, unknown>;
  sequence: string[];
}

interface DurableExecutionState<TVars extends Vars, TAttrs extends Attrs> {
  runId: string;
  session: Session<TVars, TAttrs>;
  journal: JournalState;
  inbox: Inbound[];
  cursor: number;
  sequencePosition: number;
  transitionVersion: number;
  middleware: readonly MiddlewareDefinition<TVars, TAttrs>[];
  hooks: readonly HookDefinition<TVars, TAttrs>[];
  middlewareState: Record<string, unknown>;
  context?: Record<string, unknown>;
  emitEvent?: (event: ExecutionEvent) => Promise<void> | void;
  nextEventSeq?: () => number;
}

interface DurableModelRequest<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  session: Session<TVars, TAttrs>;
}

interface DurablePhaseJournal<TAttrs extends Attrs = Attrs> {
  request?: unknown;
  result?: unknown;
  command: ResolvedExecutionCommand;
  beforeVersion: number;
  afterVersion: number;
  middlewareState: Record<string, unknown>;
  steps: ExecutionPhaseStep<TAttrs>[];
  nestedStepIds: string[];
}

interface DurableWrapperJournal<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  session: Session<TVars, TAttrs>;
  request: unknown;
  result: unknown;
  command: ResolvedExecutionCommand;
  beforeVersion: number;
  afterVersion: number;
  middlewareState: Record<string, unknown>;
  steps: ExecutionPhaseStep<TAttrs>[];
  nestedStepIds: string[];
}

interface DurableCompositeJournal {
  __promptTrailComposite: true;
  result: unknown;
  nestedStepIds: string[];
}

type DurableNode<TVars extends Vars, TAttrs extends Attrs> =
  | { type: 'system'; id: string; content: string }
  | {
      type: 'patch';
      id: string;
      handler: DurablePatchHandler<TVars, TAttrs>;
    }
  | {
      type: 'assistant';
      id: string;
      handler: AssistantHandler<TVars, TAttrs>;
    }
  | {
      type: 'chat';
      id: string;
      handler: AssistantHandler<TVars, TAttrs>;
    }
  | { type: 'runTools'; id: string }
  | { type: 'awaitUser'; id: string }
  | { type: 'steer'; id: string; mode: 'all' | 'one' }
  | {
      type: 'turn';
      id: string;
      nodes: DurableNode<TVars, TAttrs>[];
      untilNoToolCalls: boolean;
    };

function normalizeAssistantMessage<TAttrs extends Attrs>(
  result: AssistantResult<TAttrs>,
): PromptTrailMessage<TAttrs> {
  if (typeof result === 'string') {
    return Message.assistant(result);
  }
  if ('type' in result) {
    return result;
  }
  return {
    type: 'assistant',
    content: result.content,
    attrs: result.attrs,
    toolCalls: result.toolCalls,
    structuredContent: result.structuredContent,
  };
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  return JSON.stringify(result);
}

function normalizeToolResultMessage<TAttrs extends Attrs>(
  result: unknown,
  call: ToolCall,
): PromptTrailMessage<TAttrs> {
  if (
    result &&
    typeof result === 'object' &&
    'type' in result &&
    (result as { type?: unknown }).type === 'tool_result'
  ) {
    return result as PromptTrailMessage<TAttrs>;
  }
  return {
    type: 'tool_result',
    content: stringifyToolResult(result),
    attrs: { toolCallId: call.id } as unknown as TAttrs,
  };
}

function toolCallsOf<TAttrs extends Attrs>(
  session: Session<any, TAttrs>,
): ToolCall[] {
  return (session.getLastMessage()?.toolCalls ?? []) as ToolCall[];
}

function resolveDurableToolActivity(
  tool: DurableTool,
  call: ToolCall,
  context: DurableActivityContext,
): DurableActivityOptions {
  const activity =
    typeof tool.activity === 'function'
      ? tool.activity(call, context)
      : (tool.activity ?? { kind: 'external-read' });
  if (activity.kind === 'external-write' && !activity.idempotencyKey) {
    throw new Error(
      `Durable tool ${call.name} external-write activity requires idempotencyKey.`,
    );
  }
  return activity;
}

function assertUniqueDurableToolSteps(
  stepIds: readonly string[],
  nodePath: string,
): void {
  const seen = new Set<string>();
  for (const stepId of stepIds) {
    if (seen.has(stepId)) {
      throw new Error(
        `Duplicate durable tool step: ${stepId}. Tool call ids must be unique within ${nodePath}.`,
      );
    }
    seen.add(stepId);
  }
}

function childPath(parent: string, id: string): string {
  return parent ? `${parent}/${id}` : id;
}

function durableTemplateLifecycleRequest<TVars extends Vars, TAttrs extends Attrs>(
  node: DurableNode<TVars, TAttrs>,
  nodePath: string,
): Record<string, unknown> {
  return {
    templateId: node.id,
    templateName: node.type,
    templatePath: nodePath,
  };
}

async function journaled<T, TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const expected = state.journal.sequence[state.sequencePosition];
  if (state.journal.results.has(stepId)) {
    if (expected !== stepId) {
      throw new NondeterminismError(expected, stepId, state.sequencePosition);
    }
    state.sequencePosition++;
    return state.journal.results.get(stepId) as T;
  }
  if (expected !== undefined) {
    throw new NondeterminismError(expected, stepId, state.sequencePosition);
  }
  const result = await fn();
  state.journal.results.set(stepId, result);
  state.journal.sequence.push(stepId);
  state.sequencePosition++;
  return result;
}

function createDurableBoundaryProvider<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  parentStepId: string,
  nestedStepIds: string[],
): ExecutionDurableBoundaryProvider {
  return (handler) => {
    const memo = async <T>(
      name: string,
      fn: () => T | Promise<T>,
    ): Promise<T> => {
      const nestedStepId = durableEffectStepId(
        parentStepId,
        handler,
        'memo',
        name,
      );
      nestedStepIds.push(nestedStepId);
      return journaled(state, nestedStepId, fn);
    };
    return {
      memo,
      now: (name) => memo(name, () => Date.now()),
      randomId: (name) => memo(name, () => durableRandomId()),
      activity: async (name, options, fn) => {
        assertDurableHandlerActivityOptions(handler, name, options);
        const nestedStepId = durableEffectStepId(
          parentStepId,
          handler,
          'activity',
          name,
        );
        nestedStepIds.push(nestedStepId);
        return journaled(state, nestedStepId, () =>
          runDurableActivityWithRetry(options, fn),
        );
      },
    };
  };
}

function durableEffectStepId(
  parentStepId: string,
  handler: ExecutionHandlerDescriptor,
  kind: 'memo' | 'activity',
  name: string,
): string {
  return `${parentStepId}/${handler.kind}[${handler.registrationIndex}]/${handler.phase}/${handler.name ?? '<anonymous>'}/${kind}/${name}`;
}

function assertDurableHandlerActivityOptions(
  handler: ExecutionHandlerDescriptor,
  name: string,
  options: ExecutionDurableActivityOptions,
): void {
  if (options.kind === 'external-write' && !options.idempotencyKey) {
    throw new Error(
      `Durable ${handler.kind} ${handler.name ?? '<anonymous>'} activity ${name} external-write requires idempotencyKey.`,
    );
  }
}

function createDurableToolBoundary<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  parentStepId: string,
  call: ToolCall,
  nestedStepIds: string[],
): ExecutionDurableBoundary {
  const memo = async <T>(
    name: string,
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    const nestedStepId = durableToolEffectStepId(
      parentStepId,
      call,
      'memo',
      name,
    );
    nestedStepIds.push(nestedStepId);
    return journaled(state, nestedStepId, fn);
  };
  return {
    memo,
    now: (name) => memo(name, () => Date.now()),
    randomId: (name) => memo(name, () => durableRandomId()),
    activity: async (name, options, fn) => {
      assertDurableToolActivityOptions(call, name, options);
      const nestedStepId = durableToolEffectStepId(
        parentStepId,
        call,
        'activity',
        name,
      );
      nestedStepIds.push(nestedStepId);
      return journaled(state, nestedStepId, () =>
        runDurableActivityWithRetry(options, fn),
      );
    },
  };
}

function durableRandomId(): string {
  const cryptoLike = globalThis.crypto as
    | { randomUUID?: () => string }
    | undefined;
  return (
    cryptoLike?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function durableToolEffectStepId(
  parentStepId: string,
  call: ToolCall,
  kind: 'memo' | 'activity',
  name: string,
): string {
  return `${parentStepId}/tool/${call.name}/${kind}/${name}`;
}

function assertDurableToolActivityOptions(
  call: ToolCall,
  name: string,
  options: ExecutionDurableActivityOptions,
): void {
  if (options.kind === 'external-write' && !options.idempotencyKey) {
    throw new Error(
      `Durable tool ${call.name} activity ${name} external-write requires idempotencyKey.`,
    );
  }
}

async function runDurableActivityWithRetry<T>(
  options: ExecutionDurableActivityOptions,
  fn: () => T | Promise<T>,
): Promise<T> {
  const maxAttempts = durableActivityMaxAttempts(options);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }
    }
  }
  throw lastError;
}

function durableActivityMaxAttempts(
  options: ExecutionDurableActivityOptions,
): number {
  const maxAttempts = options.retry?.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      'Durable activity retry.maxAttempts must be a positive integer.',
    );
  }
  return maxAttempts;
}

async function runDurableCompositeJournal<
  T,
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  fn: (nestedStepIds: string[]) => Promise<T> | T,
): Promise<T> {
  if (state.journal.results.has(stepId)) {
    const record = state.journal.results.get(stepId);
    if (isDurableCompositeJournal(record)) {
      return applyDurableCompositeJournal(state, stepId, record) as T;
    }
    return journaled(state, stepId, async () => record as T);
  }
  assertCanRunDurableCompositeStep(state, stepId);
  const nestedStepIds: string[] = [];
  const result = await fn(nestedStepIds);
  commitDurableJournalRecord(state, stepId, {
    __promptTrailComposite: true,
    result,
    nestedStepIds,
  } satisfies DurableCompositeJournal);
  return result;
}

function applyDurableCompositeJournal<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  record: DurableCompositeJournal,
): unknown {
  replayNestedJournalSteps(state, record.nestedStepIds ?? []);
  const expected = state.journal.sequence[state.sequencePosition];
  if (expected !== stepId) {
    throw new NondeterminismError(expected, stepId, state.sequencePosition);
  }
  state.sequencePosition++;
  return record.result;
}

function isDurableCompositeJournal(
  value: unknown,
): value is DurableCompositeJournal {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __promptTrailComposite?: unknown }).__promptTrailComposite ===
      true
  );
}

async function runDurableExecutionPhase<
  TVars extends Vars,
  TAttrs extends Attrs,
  TRequest = unknown,
  TResult = unknown,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  options: {
    phase: ExecutionLifecyclePhase;
    session: Session<TVars, TAttrs>;
    request?: TRequest;
    result?: TResult;
  },
): Promise<RunExecutionPhaseResult<TVars, TAttrs, TRequest, TResult>> {
  if (!hasDurablePhaseHandler(state, options.phase)) {
    return {
      session: options.session,
      request: options.request,
      result: options.result,
      middlewareState: state.middlewareState,
      command: { type: 'none' },
      beforeVersion: state.transitionVersion,
      afterVersion: state.transitionVersion,
      steps: [],
    };
  }

  if (state.journal.results.has(stepId)) {
    const record = state.journal.results.get(
      stepId,
    ) as DurablePhaseJournal<TAttrs>;
    return await applyDurablePhaseJournal<TVars, TAttrs, TRequest, TResult>(
      state,
      stepId,
      options.session,
      record,
      'journaled',
    );
  }

  assertCanRunDurableCompositeStep(state, stepId);
  const nestedStepIds: string[] = [];
  const phase = await runExecutionPhase({
    phase: options.phase,
    session: options.session,
    request: options.request,
    result: options.result,
    middlewareState: state.middlewareState,
    middleware: state.middleware,
    hooks: state.hooks,
    context: state.context,
    beforeVersion: state.transitionVersion,
    durableBoundary: createDurableBoundaryProvider(
      state,
      stepId,
      nestedStepIds,
    ),
  });
  const record = {
    request: phase.request,
    result: phase.result,
    command: phase.command,
    beforeVersion: phase.beforeVersion,
    afterVersion: phase.afterVersion,
    middlewareState: phase.middlewareState,
    steps: phase.steps,
    nestedStepIds,
  } satisfies DurablePhaseJournal<TAttrs>;
  commitDurableJournalRecord(state, stepId, record);

  return await applyDurablePhaseJournal<TVars, TAttrs, TRequest, TResult>(
    state,
    stepId,
    options.session,
    record,
    'live',
  );
}

async function applyDurablePhaseJournal<
  TVars extends Vars,
  TAttrs extends Attrs,
  TRequest = unknown,
  TResult = unknown,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  baseSession: Session<TVars, TAttrs>,
  record: DurablePhaseJournal<TAttrs>,
  replay: 'live' | 'journaled',
): Promise<RunExecutionPhaseResult<TVars, TAttrs, TRequest, TResult>> {
  if (replay === 'journaled') {
    replayNestedJournalSteps(state, record.nestedStepIds ?? []);
    const expected = state.journal.sequence[state.sequencePosition];
    if (expected !== stepId) {
      throw new NondeterminismError(expected, stepId, state.sequencePosition);
    }
    state.sequencePosition++;
  }
  if (record.beforeVersion !== state.transitionVersion) {
    throw new NondeterminismError(
      `version:${state.transitionVersion}`,
      `version:${record.beforeVersion}`,
      state.sequencePosition - 1,
    );
  }
  assertDurablePhaseStepOrder(state, record.steps);

  let session = baseSession;
  let middlewareState = state.middlewareState;
  for (const step of record.steps) {
    if (step.transition.beforeVersion !== state.transitionVersion) {
      throw new NondeterminismError(
        `version:${state.transitionVersion}`,
        `version:${step.transition.beforeVersion}`,
        state.sequencePosition - 1,
      );
    }
    const applied = applyResolvedExecutionTransition(session, step.transition, {
      middlewareState,
    });
    session = applied.session;
    middlewareState = applied.middlewareState;
    state.transitionVersion = step.transition.afterVersion;
    await emitDurablePhaseStepEvent(state, stepId, step, replay);
  }
  state.middlewareState = middlewareState;

  return {
    session,
    request: record.request as TRequest | undefined,
    result: record.result as TResult | undefined,
    middlewareState,
    command: record.command,
    beforeVersion: record.beforeVersion,
    afterVersion: record.afterVersion,
    steps: record.steps,
  };
}

function hasDurablePhaseHandler<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  phase: ExecutionLifecyclePhase,
): boolean {
  if (phase === 'suspend') {
    return state.hooks.some((hook) => Boolean(hook.onSuspend ?? hook.onResume));
  }
  return (
    state.middleware.some((middleware) =>
      Boolean(durableMiddlewareHandlerForPhase(middleware, phase)),
    ) ||
    state.hooks.some((hook) => Boolean(hookHandlerForDurablePhase(hook, phase)))
  );
}

function durableMiddlewareHandlerForPhase<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  middleware: MiddlewareDefinition<TVars, TAttrs>,
  phase: ExecutionLifecyclePhase,
): unknown {
  switch (phase) {
    case 'beforeAgent':
      return middleware.beforeAgent;
    case 'afterAgent':
      return middleware.afterAgent;
    case 'beforeTemplate':
    case 'afterTemplate':
      return undefined;
    case 'beforeModel':
      return middleware.beforeModel;
    case 'prepareModelInput':
      return middleware.prepareModelInput;
    case 'afterModel':
      return middleware.afterModel;
    case 'beforeTool':
      return middleware.beforeTool;
    case 'afterTool':
      return middleware.afterTool;
    case 'suspend':
    case 'resume':
      return undefined;
  }
}

function hookHandlerForDurablePhase<TVars extends Vars, TAttrs extends Attrs>(
  hook: HookDefinition<TVars, TAttrs>,
  phase: ExecutionLifecyclePhase,
): unknown {
  assertHookDefinitionSupported(hook);
  switch (phase) {
    case 'beforeAgent':
      return hook.onRunStart ?? hook.onBeforeAgent;
    case 'afterAgent':
      return hook.onRunEnd ?? hook.onAfterAgent;
    case 'beforeTemplate':
      return hook.onBeforeTemplate;
    case 'afterTemplate':
      return hook.onAfterTemplate;
    case 'beforeModel':
      return hook.onBeforeModel;
    case 'afterModel':
      return hook.onAfterModel;
    case 'beforeTool':
      return hook.onBeforeTool;
    case 'afterTool':
      return hook.onAfterTool;
    case 'suspend':
      return hook.onSuspend;
    case 'resume':
      return hook.onResume;
    case 'prepareModelInput':
      return undefined;
  }
}

function assertDurablePhaseStepOrder<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  steps: readonly ExecutionPhaseStep<TAttrs>[],
): void {
  for (const step of steps) {
    const current = durablePhaseStepCoordinate(state, step);
    const expected = durableRecordedStepCoordinate(step);
    if (current !== expected) {
      throw new NondeterminismError(
        expected,
        current,
        state.sequencePosition - 1,
      );
    }
  }
}

function durableRecordedStepCoordinate<TAttrs extends Attrs>(
  step: ExecutionPhaseStep<TAttrs>,
): string {
  return `${step.kind}:${step.phase}:${step.registrationIndex}:${step.name ?? '<anonymous>'}`;
}

function durablePhaseStepCoordinate<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  step: ExecutionPhaseStep<TAttrs>,
): string {
  if (step.kind === 'middleware') {
    const middleware = state.middleware[step.registrationIndex];
    const handler = middleware
      ? durableMiddlewareStepHandlerForPhase(middleware, step.phase)
      : undefined;
    if (!handler) {
      return `${step.kind}:${step.phase}:${step.registrationIndex}:<missing>`;
    }
    return `${step.kind}:${step.phase}:${step.registrationIndex}:${middleware.name ?? '<anonymous>'}`;
  }
  if (step.phase === 'wrapModelCall' || step.phase === 'wrapToolCall') {
    return `${step.kind}:${step.phase}:${step.registrationIndex}:<missing>`;
  }
  const hook = state.hooks[step.registrationIndex];
  const handler = hook
    ? hookHandlerForDurablePhase(hook, step.phase)
    : undefined;
  if (!handler) {
    return `${step.kind}:${step.phase}:${step.registrationIndex}:<missing>`;
  }
  return `${step.kind}:${step.phase}:${step.registrationIndex}:${hook.name ?? '<anonymous>'}`;
}

function durableMiddlewareStepHandlerForPhase<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  middleware: MiddlewareDefinition<TVars, TAttrs>,
  phase: ExecutionPhase,
): unknown {
  if (phase === 'wrapModelCall') {
    return middleware.wrapModelCall;
  }
  if (phase === 'wrapToolCall') {
    return middleware.wrapToolCall;
  }
  return durableMiddlewareHandlerForPhase(middleware, phase);
}

async function runDurableMiddlewareWrapper<
  TVars extends Vars,
  TAttrs extends Attrs,
  TRequest,
  TResult,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  options: {
    phase: ExecutionWrapperPhase;
    session: Session<TVars, TAttrs>;
    request: TRequest;
    call: (input: {
      session: Session<TVars, TAttrs>;
      request: TRequest;
      journalStepId: string;
      nestedStepIds: string[];
    }) => Promise<TResult>;
  },
): Promise<RunMiddlewareWrapperResult<TVars, TAttrs, TRequest, TResult>> {
  if (state.journal.results.has(stepId)) {
    const record = state.journal.results.get(stepId) as DurableWrapperJournal<
      TVars,
      TAttrs
    >;
    return await replayDurableWrapperJournal(
      state,
      stepId,
      options.session,
      record,
    );
  }

  assertCanRunDurableCompositeStep(state, stepId);
  const nestedStepIds: string[] = [];
  let nestedCallIndex = 0;
  const wrapped = await runMiddlewareWrapper({
    phase: options.phase,
    session: options.session,
    request: options.request,
    call: async (input) => {
      const nestedStepId = `${stepId}/next/${nestedCallIndex++}`;
      nestedStepIds.push(nestedStepId);
      return runDurableCompositeJournal(
        state,
        nestedStepId,
        (callNestedStepIds) =>
          options.call({
            ...input,
            journalStepId: nestedStepId,
            nestedStepIds: callNestedStepIds,
          }),
      );
    },
    middlewareState: state.middlewareState,
    middleware: state.middleware,
    context: state.context,
    beforeVersion: state.transitionVersion,
    durableBoundary: createDurableBoundaryProvider(
      state,
      stepId,
      nestedStepIds,
    ),
  });
  const record = {
    session: wrapped.session,
    request: wrapped.request,
    result: wrapped.result,
    command: wrapped.command,
    beforeVersion: wrapped.beforeVersion,
    afterVersion: wrapped.afterVersion,
    middlewareState: wrapped.middlewareState,
    steps: wrapped.steps,
    nestedStepIds,
  } satisfies DurableWrapperJournal<TVars, TAttrs>;
  commitDurableJournalRecord(state, stepId, record);

  return await applyDurableWrapperJournal(
    state,
    stepId,
    options.session,
    record,
    'live',
  );
}

function commitDurableJournalRecord<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  record: unknown,
): void {
  const expected = state.journal.sequence[state.sequencePosition];
  if (expected !== undefined) {
    throw new NondeterminismError(expected, stepId, state.sequencePosition);
  }
  state.journal.results.set(stepId, record);
  state.journal.sequence.push(stepId);
  state.sequencePosition++;
}

function assertCanRunDurableCompositeStep<
  TVars extends Vars,
  TAttrs extends Attrs,
>(state: DurableExecutionState<TVars, TAttrs>, stepId: string): void {
  const expected = state.journal.sequence[state.sequencePosition];
  if (expected !== undefined && !expected.startsWith(`${stepId}/`)) {
    throw new NondeterminismError(expected, stepId, state.sequencePosition);
  }
}

function replayNestedJournalSteps<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  nestedStepIds: readonly string[],
): void {
  for (const nestedStepId of nestedStepIds) {
    const record = state.journal.results.get(nestedStepId);
    if (isDurableCompositeJournal(record)) {
      applyDurableCompositeJournal(state, nestedStepId, record);
      continue;
    }
    const expected = state.journal.sequence[state.sequencePosition];
    if (expected !== nestedStepId) {
      throw new NondeterminismError(
        expected,
        nestedStepId,
        state.sequencePosition,
      );
    }
    if (record === undefined && !state.journal.results.has(nestedStepId)) {
      throw new Error(`Missing durable nested step ${nestedStepId}.`);
    }
    state.sequencePosition++;
  }
}

async function replayDurableWrapperJournal<
  TVars extends Vars,
  TAttrs extends Attrs,
  TRequest,
  TResult,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  session: Session<TVars, TAttrs>,
  record: DurableWrapperJournal<TVars, TAttrs>,
): Promise<RunMiddlewareWrapperResult<TVars, TAttrs, TRequest, TResult>> {
  replayNestedJournalSteps(state, record.nestedStepIds ?? []);

  const expected = state.journal.sequence[state.sequencePosition];
  if (expected !== stepId) {
    throw new NondeterminismError(expected, stepId, state.sequencePosition);
  }
  state.sequencePosition++;
  return await applyDurableWrapperJournal(
    state,
    stepId,
    session,
    record,
    'journaled',
  );
}

async function applyDurableWrapperJournal<
  TVars extends Vars,
  TAttrs extends Attrs,
  TRequest,
  TResult,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  baseSession: Session<TVars, TAttrs>,
  record: DurableWrapperJournal<TVars, TAttrs>,
  replay: 'live' | 'journaled',
): Promise<RunMiddlewareWrapperResult<TVars, TAttrs, TRequest, TResult>> {
  if (record.beforeVersion !== state.transitionVersion) {
    throw new NondeterminismError(
      `version:${state.transitionVersion}`,
      `version:${record.beforeVersion}`,
      state.sequencePosition - 1,
    );
  }
  assertDurablePhaseStepOrder(state, record.steps);

  let session = baseSession;
  let middlewareState = state.middlewareState;
  for (const step of record.steps) {
    if (step.transition.beforeVersion !== state.transitionVersion) {
      throw new NondeterminismError(
        `version:${state.transitionVersion}`,
        `version:${step.transition.beforeVersion}`,
        state.sequencePosition - 1,
      );
    }
    const applied = applyResolvedExecutionTransition(session, step.transition, {
      middlewareState,
    });
    session = applied.session;
    middlewareState = applied.middlewareState;
    state.transitionVersion = step.transition.afterVersion;
    await emitDurablePhaseStepEvent(state, stepId, step, replay);
  }
  state.middlewareState = middlewareState;

  return {
    session: record.session,
    request: record.request as TRequest,
    result: record.result as TResult,
    middlewareState,
    command: record.command,
    beforeVersion: record.beforeVersion,
    afterVersion: record.afterVersion,
    steps: record.steps,
  };
}

function hasDurableWrapperHandler<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  phase: ExecutionWrapperPhase,
): boolean {
  return state.middleware.some((middleware) => Boolean(middleware[phase]));
}

async function emitDurablePhaseStepEvent<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  step: ExecutionPhaseStep<TAttrs>,
  replay: 'live' | 'journaled',
): Promise<void> {
  if (
    !state.emitEvent ||
    !state.nextEventSeq ||
    step.transition.beforeVersion === step.transition.afterVersion
  ) {
    return;
  }
  const seq = state.nextEventSeq();
  await state.emitEvent({
    id: `${state.runId}:${seq}:session.patched`,
    type: 'session.patched',
    at: new Date().toISOString(),
    seq,
    conversationId: state.runId,
    runId: state.runId,
    stepId,
    phase: step.phase,
    replay,
      idempotencyKey: durableEventIdempotencyKey(state, {
        stepId,
        phase: step.phase,
        type: 'session.patched',
        scope: durablePhaseStepEventScope(step),
      }),
    source: step.kind,
    sessionVersion: step.transition.afterVersion,
    raw: {
      kind: step.kind,
      name: step.name,
      registrationIndex: step.registrationIndex,
      beforeVersion: step.transition.beforeVersion,
      afterVersion: step.transition.afterVersion,
      command: step.transition.command,
    },
  });
}

async function emitDurableExecutionEvent<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  type: string,
  options: Partial<ExecutionEvent> = {},
): Promise<void> {
  if (!state.emitEvent || !state.nextEventSeq) {
    return;
  }
  const seq = state.nextEventSeq();
  try {
    await state.emitEvent({
      id: `${state.runId}:${seq}:${type}`,
      type,
      at: new Date().toISOString(),
      seq,
      conversationId: state.runId,
      runId: state.runId,
      replay: 'live',
      source: 'durable',
      sessionVersion: state.transitionVersion,
      ...options,
      idempotencyKey:
        options.idempotencyKey ??
        durableEventIdempotencyKey(state, {
          stepId: options.stepId,
          phase: options.phase,
          type,
        }),
    });
  } catch {
    // Tool/model progress events are observer side effects. They must not
    // prevent the surrounding durable activity result from being journaled.
  }
}

function durableEventIdempotencyKey<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  options: {
    stepId?: string;
    phase?: string;
    type: string;
    scope?: string;
  },
): string {
  return [
    state.runId,
    options.stepId ?? '-',
    options.phase ?? '-',
    options.type,
    options.scope ?? '-',
  ].join(':');
}

function durablePhaseStepEventScope<TAttrs extends Attrs>(
  step: ExecutionPhaseStep<TAttrs>,
): string {
  return [
    step.kind,
    step.registrationIndex,
    step.name ?? '<anonymous>',
  ].join(':');
}

async function awaitInbound<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
): Promise<Inbound> {
  const hadSuspended = await applyAwaitLifecyclePhaseIfNext(
    state,
    stepId,
    'suspend',
  );
  const inbound = state.inbox.find((message) => message.offset >= state.cursor);
  if (!inbound) {
    if (!hadSuspended) {
      await runAwaitLifecyclePhase(state, stepId, 'suspend');
    }
    throw new Suspend(stepId);
  }
  if (hadSuspended) {
    await runAwaitLifecyclePhase(state, stepId, 'resume');
  }
  const offset = await journaled(state, stepId, async () => {
    return inbound.offset;
  });
  state.cursor = offset + 1;
  const resolvedInbound = state.inbox.find(
    (message) => message.offset === offset,
  );
  if (!resolvedInbound) {
    throw new Error(`Missing inbox message at offset ${offset}`);
  }
  return resolvedInbound;
}

async function applyAwaitLifecyclePhaseIfNext<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  phase: 'suspend' | 'resume',
): Promise<boolean> {
  const lifecycleStepId = awaitLifecycleStepId(stepId, phase);
  if (state.journal.sequence[state.sequencePosition] !== lifecycleStepId) {
    return false;
  }
  await runAwaitLifecyclePhase(state, stepId, phase);
  return true;
}

async function runAwaitLifecyclePhase<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  phase: 'suspend' | 'resume',
): Promise<void> {
  const result = await runDurableExecutionPhase(
    state,
    awaitLifecycleStepId(stepId, phase),
    {
      phase,
      session: state.session,
      request: { stepId },
    },
  );
  handleDurablePhaseCommand(result.command, stepId, result.session);
  state.session = result.session;
}

function awaitLifecycleStepId(
  stepId: string,
  phase: 'suspend' | 'resume',
): string {
  return `${stepId}/on${phase === 'suspend' ? 'Suspend' : 'Resume'}`;
}

async function peekInbox<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  mode: 'all' | 'one',
): Promise<Inbound[]> {
  const offsets = await journaled(state, stepId, async () => {
    const visible = state.inbox.filter(
      (message) => message.offset >= state.cursor,
    );
    return (mode === 'one' ? visible.slice(0, 1) : visible).map(
      (message) => message.offset,
    );
  });
  if (offsets.length > 0) {
    state.cursor = offsets[offsets.length - 1] + 1;
  }
  return offsets.map((offset) => {
    const inbound = state.inbox.find((message) => message.offset === offset);
    if (!inbound) {
      throw new Error(`Missing inbox message at offset ${offset}`);
    }
    return inbound;
  });
}

export class DurableTurnBuilder<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  private nodes: DurableNode<TVars, TAttrs>[] = [];
  private shouldLoopUntilNoToolCalls = false;

  steer(id = 'steer', mode: 'all' | 'one' = 'all'): this {
    this.nodes.push({ type: 'steer', id, mode });
    return this;
  }

  assistant(id: string, handler: AssistantHandler<TVars, TAttrs>): this {
    this.nodes.push({ type: 'assistant', id, handler });
    return this;
  }

  patch(id: string, handler: DurablePatchHandler<TVars, TAttrs>): this {
    this.nodes.push({ type: 'patch', id, handler });
    return this;
  }

  runTools(id = 'tools'): this {
    this.nodes.push({ type: 'runTools', id });
    return this;
  }

  untilNoToolCalls(): this {
    this.shouldLoopUntilNoToolCalls = true;
    return this;
  }

  awaitUser(id = 'input'): this {
    this.nodes.push({ type: 'awaitUser', id });
    return this;
  }

  build(): {
    nodes: DurableNode<TVars, TAttrs>[];
    untilNoToolCalls: boolean;
  } {
    return {
      nodes: [...this.nodes],
      untilNoToolCalls: this.shouldLoopUntilNoToolCalls,
    };
  }
}

export class DurableAgent<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  private nodes: DurableNode<TVars, TAttrs>[] = [];
  private tools = new Map<string, DurableTool>();
  private middlewareDefinitions: MiddlewareDefinition<TVars, TAttrs>[] = [];
  private hookDefinitions: HookDefinition<TVars, TAttrs>[] = [];
  private observerDefinitions: ObserverLike[] = [];

  constructor(readonly name: string) {}

  use(middleware: MiddlewareDefinition<TVars, TAttrs>): this {
    this.middlewareDefinitions.push(middleware);
    return this;
  }

  hook(hook: HookDefinition<TVars, TAttrs>): this {
    this.hookDefinitions.push(hook);
    return this;
  }

  observe(observer: ObserverLike): this {
    this.observerDefinitions.push(observer);
    return this;
  }

  runtimeMiddleware(): readonly MiddlewareDefinition<TVars, TAttrs>[] {
    return this.middlewareDefinitions;
  }

  runtimeHooks(): readonly HookDefinition<TVars, TAttrs>[] {
    return this.hookDefinitions;
  }

  runtimeObservers(): readonly ObserverLike[] {
    return this.observerDefinitions;
  }

  system(content: string, id = 'system'): this {
    this.nodes.push({ type: 'system', id, content });
    return this;
  }

  tool(name: string, tool: DurableTool): this {
    this.tools.set(name, tool);
    return this;
  }

  assistant(id: string, handler: AssistantHandler<TVars, TAttrs>): this {
    this.nodes.push({ type: 'assistant', id, handler });
    return this;
  }

  patch(id: string, handler: DurablePatchHandler<TVars, TAttrs>): this {
    this.nodes.push({ type: 'patch', id, handler });
    return this;
  }

  chat(id: string, handler: AssistantHandler<TVars, TAttrs>): this {
    this.nodes.push({ type: 'chat', id, handler });
    return this;
  }

  runTools(id = 'tools'): this {
    this.nodes.push({ type: 'runTools', id });
    return this;
  }

  turn(
    id: string,
    builder: (
      turn: DurableTurnBuilder<TVars, TAttrs>,
    ) => DurableTurnBuilder<TVars, TAttrs>,
  ): this {
    const turn = builder(new DurableTurnBuilder<TVars, TAttrs>()).build();
    this.nodes.push({
      type: 'turn',
      id,
      nodes: turn.nodes,
      untilNoToolCalls: turn.untilNoToolCalls,
    });
    return this;
  }

  async execute(
    state: DurableExecutionState<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    let session = state.session;
    const before = await runDurableExecutionPhase(state, 'beforeAgent', {
      phase: 'beforeAgent',
      session,
    });
    handleDurablePhaseCommand(before.command, 'beforeAgent', before.session);
    session = before.session;
    state.session = session;
    for (const node of this.nodes) {
      session = await this.executeNode(state, node, '', session);
      state.session = session;
    }
    const after = await runDurableExecutionPhase(state, 'afterAgent', {
      phase: 'afterAgent',
      session,
    });
    handleDurablePhaseCommand(after.command, 'afterAgent', after.session);
    state.session = after.session;
    return after.session;
  }

  private async executeNode(
    state: DurableExecutionState<TVars, TAttrs>,
    node: DurableNode<TVars, TAttrs>,
    path: string,
    session: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const nodePath = childPath(path, node.id);
    const request = durableTemplateLifecycleRequest(node, nodePath);
    const before = await runDurableExecutionPhase(state, `${nodePath}/beforeTemplate`, {
      phase: 'beforeTemplate',
      session,
      request,
    });
    handleDurablePhaseCommand(before.command, nodePath, before.session);
    state.session = before.session;

    const executed = await this.executeNodeBody(
      state,
      node,
      nodePath,
      before.session,
    );
    state.session = executed;

    const after = await runDurableExecutionPhase(state, `${nodePath}/afterTemplate`, {
      phase: 'afterTemplate',
      session: executed,
      request,
    });
    handleDurablePhaseCommand(after.command, nodePath, after.session);
    state.session = after.session;
    return after.session;
  }

  private async executeNodeBody(
    state: DurableExecutionState<TVars, TAttrs>,
    node: DurableNode<TVars, TAttrs>,
    nodePath: string,
    session: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    switch (node.type) {
      case 'system':
        return session.addMessage(Message.system(node.content));
      case 'patch': {
        const transition = await journaled(
          state,
          `${nodePath}/transition`,
          async () => {
            const resolved = resolveExecutionTransition(
              session,
              await node.handler(session),
              {
                beforeVersion: state.transitionVersion,
              },
            );
            assertDurablePatchTransitionSupported(resolved, nodePath);
            return resolved;
          },
        );
        if (transition.beforeVersion !== state.transitionVersion) {
          // This catches corrupted or hand-edited transition journals. Normal
          // code-order nondeterminism is still detected by journaled step ids.
          throw new NondeterminismError(
            `version:${state.transitionVersion}`,
            `version:${transition.beforeVersion}`,
            state.sequencePosition - 1,
          );
        }
        assertDurablePatchTransitionSupported(transition, nodePath);
        const applied = applyResolvedExecutionTransition(session, transition, {
          middlewareState: state.middlewareState,
        });
        state.transitionVersion = transition.afterVersion;
        state.middlewareState = applied.middlewareState;
        state.session = applied.session;
        handleDurablePhaseCommand(transition.command, nodePath, applied.session);
        return applied.session;
      }
      case 'assistant': {
        const before = await runDurableExecutionPhase(
          state,
          `${nodePath}/beforeModel`,
          {
            phase: 'beforeModel',
            session,
          },
        );
        handleDurablePhaseCommand(before.command, nodePath, before.session);
        session = before.session;
        state.session = session;

        const request: DurableModelRequest<TVars, TAttrs> = { session };
        const prepared = await runDurableExecutionPhase<
          TVars,
          TAttrs,
          DurableModelRequest<TVars, TAttrs>
        >(state, `${nodePath}/prepareModelInput`, {
          phase: 'prepareModelInput',
          session,
          request,
        });
        handleDurablePhaseCommand(
          prepared.command,
          nodePath,
          prepared.session,
        );
        assertPrepareModelInputDidNotPersistSession(prepared.steps, nodePath);
        const modelSession =
          (prepared.request as DurableModelRequest<TVars, TAttrs> | undefined)
            ?.session ?? session;

        let message: PromptTrailMessage<TAttrs>;
        if (hasDurableWrapperHandler(state, 'wrapModelCall')) {
          const wrapped = await runDurableMiddlewareWrapper<
            TVars,
            TAttrs,
            DurableModelRequest<TVars, TAttrs>,
            AssistantResult<TAttrs>
          >(state, `${nodePath}/wrapModelCall`, {
            phase: 'wrapModelCall',
            session,
            request: { session: modelSession },
            call: async ({ request, journalStepId }) =>
              this.executeDurableModel(
                state,
                journalStepId,
                request.session,
                node.handler,
              ),
          });
          session = wrapped.session;
          state.session = session;
          message = normalizeAssistantMessage(wrapped.result);
          handleDurablePhaseCommand(
            wrapped.command,
            nodePath,
            session.addMessage(message),
          );
        } else {
          message = await journaled(state, `${nodePath}/model`, async () =>
            normalizeAssistantMessage(
              await this.executeDurableModel(
                state,
                `${nodePath}/model`,
                modelSession,
                node.handler,
              ),
            ),
          );
        }
        const after = await runDurableExecutionPhase(
          state,
          `${nodePath}/afterModel`,
          {
            phase: 'afterModel',
            session,
            result: message,
          },
        );
        const finalMessage = normalizeAssistantMessage(
          (after.result as AssistantResult<TAttrs> | undefined) ?? message,
        );
        const completed = after.session.addMessage(finalMessage);
        handleDurablePhaseCommand(after.command, nodePath, completed);
        return completed;
      }
      case 'chat': {
        let current = session;
        let iteration = 0;
        while (true) {
          const inbound = await awaitInbound(
            state,
            `${nodePath}#${iteration}/input`,
          );
          current = current.addMessage(
            Message.user(inbound.content, inbound.attrs as TAttrs | undefined),
          );
          state.session = current;
          const before = await runDurableExecutionPhase(
            state,
            `${nodePath}#${iteration}/beforeModel`,
            {
              phase: 'beforeModel',
              session: current,
            },
          );
          handleDurablePhaseCommand(before.command, nodePath, before.session);
          current = before.session;
          state.session = current;
          const request: DurableModelRequest<TVars, TAttrs> = {
            session: current,
          };
          const prepared = await runDurableExecutionPhase<
            TVars,
            TAttrs,
            DurableModelRequest<TVars, TAttrs>
          >(state, `${nodePath}#${iteration}/prepareModelInput`, {
            phase: 'prepareModelInput',
            session: current,
            request,
          });
          handleDurablePhaseCommand(
            prepared.command,
            nodePath,
            prepared.session,
          );
          assertPrepareModelInputDidNotPersistSession(prepared.steps, nodePath);
          const modelSession =
            (prepared.request as DurableModelRequest<TVars, TAttrs> | undefined)
              ?.session ?? current;
          let message: PromptTrailMessage<TAttrs>;
          if (hasDurableWrapperHandler(state, 'wrapModelCall')) {
            const wrapped = await runDurableMiddlewareWrapper<
              TVars,
              TAttrs,
              DurableModelRequest<TVars, TAttrs>,
              AssistantResult<TAttrs>
            >(state, `${nodePath}#${iteration}/wrapModelCall`, {
              phase: 'wrapModelCall',
              session: current,
              request: { session: modelSession },
              call: async ({ request, journalStepId }) =>
                this.executeDurableModel(
                  state,
                  journalStepId,
                  request.session,
                  node.handler,
                ),
            });
            current = wrapped.session;
            state.session = current;
            message = normalizeAssistantMessage(wrapped.result);
            handleDurablePhaseCommand(
              wrapped.command,
              nodePath,
              current.addMessage(message),
            );
          } else {
            message = await journaled(
              state,
              `${nodePath}#${iteration}/model`,
              async () =>
                normalizeAssistantMessage(
                  await this.executeDurableModel(
                    state,
                    `${nodePath}#${iteration}/model`,
                    modelSession,
                    node.handler,
                  ),
                ),
            );
          }
          const after = await runDurableExecutionPhase(
            state,
            `${nodePath}#${iteration}/afterModel`,
            {
              phase: 'afterModel',
              session: current,
              result: message,
            },
          );
          const finalMessage = normalizeAssistantMessage(
            (after.result as AssistantResult<TAttrs> | undefined) ?? message,
          );
          current = after.session.addMessage(finalMessage);
          handleDurablePhaseCommand(after.command, nodePath, current);
          state.session = current;
          iteration++;
        }
      }
      case 'runTools': {
        let next = session;
        const calls = toolCallsOf(session);
        const stepIds = calls.map(
          (call, index) => `${nodePath}/${call.id || index}`,
        );
        assertUniqueDurableToolSteps(stepIds, nodePath);
        for (let index = 0; index < calls.length; index++) {
          const call = calls[index];
          const stepId = stepIds[index];
          const before = await runDurableExecutionPhase<
            TVars,
            TAttrs,
            ToolCall
          >(state, `${stepId}/beforeTool`, {
            phase: 'beforeTool',
            session: next,
            request: call,
          });
          handleDurablePhaseCommand(before.command, stepId, before.session);
          let nextCall = (before.request as ToolCall | undefined) ?? call;
          let message: PromptTrailMessage<TAttrs>;
          let toolSession = before.session;
          if (hasDurableWrapperHandler(state, 'wrapToolCall')) {
            const wrapped = await runDurableMiddlewareWrapper<
              TVars,
              TAttrs,
              ToolCall,
              unknown
            >(state, `${stepId}/wrapToolCall`, {
              phase: 'wrapToolCall',
              session: before.session,
              request: nextCall,
              call: async ({
                session,
                request,
                journalStepId,
                nestedStepIds,
              }) =>
                this.executeDurableTool(state, stepId, request, session, {
                  journalStepId,
                  nestedStepIds,
                  eventStepId: journalStepId,
                }),
            });
            nextCall = (wrapped.request as ToolCall | undefined) ?? nextCall;
            toolSession = wrapped.session;
            message = normalizeToolResultMessage(wrapped.result, nextCall);
            handleDurablePhaseCommand(
              wrapped.command,
              stepId,
              toolSession.addMessage(message),
            );
          } else {
            const result = await runDurableCompositeJournal(
              state,
              stepId,
              (nestedStepIds) =>
                this.executeDurableTool(
                  state,
                  stepId,
                  nextCall,
                  before.session,
                  {
                    journalStepId: stepId,
                    nestedStepIds,
                  },
                ),
            );
            message = normalizeToolResultMessage(result, nextCall);
          }
          const after = await runDurableExecutionPhase<
            TVars,
            TAttrs,
            ToolCall,
            PromptTrailMessage<TAttrs>
          >(state, `${stepId}/afterTool`, {
            phase: 'afterTool',
            session: toolSession,
            request: nextCall,
            result: message,
          });
          next = after.session.addMessage(
            (after.result as PromptTrailMessage<TAttrs> | undefined) ?? message,
          );
          handleDurablePhaseCommand(after.command, stepId, next);
        }
        return next;
      }
      case 'awaitUser': {
        const inbound = await awaitInbound(state, `${nodePath}/input`);
        return state.session.addMessage(
          Message.user(inbound.content, inbound.attrs as TAttrs | undefined),
        );
      }
      case 'steer': {
        const inbound = await peekInbox(state, `${nodePath}/peek`, node.mode);
        return inbound.reduce(
          (current, message) =>
            current.addMessage(
              Message.user(
                message.content,
                message.attrs as TAttrs | undefined,
              ),
            ),
          session,
        );
      }
      case 'turn': {
        if (!node.untilNoToolCalls) {
          let current = session;
          for (const child of node.nodes) {
            current = await this.executeNode(state, child, nodePath, current);
            state.session = current;
          }
          return current;
        }

        const awaitIndex = node.nodes.findIndex(
          (child) => child.type === 'awaitUser',
        );
        const loopNodes =
          awaitIndex === -1 ? node.nodes : node.nodes.slice(0, awaitIndex);
        const tailNodes = awaitIndex === -1 ? [] : node.nodes.slice(awaitIndex);

        let current = session;
        let iteration = 0;
        let shouldLoop = false;
        do {
          shouldLoop = false;
          for (const child of loopNodes) {
            current = await this.executeNode(
              state,
              child,
              `${nodePath}#${iteration}`,
              current,
            );
            state.session = current;
            if (child.type === 'assistant' && toolCallsOf(current).length > 0) {
              shouldLoop = true;
            }
          }
          iteration++;
        } while (shouldLoop);

        for (const child of tailNodes) {
          current = await this.executeNode(state, child, nodePath, current);
          state.session = current;
        }
        return current;
      }
    }
  }

  private async executeDurableModel<TVars extends Vars, TAttrs extends Attrs>(
    state: DurableExecutionState<TVars, TAttrs>,
    stepId: string,
    session: Session<TVars, TAttrs>,
    handler: AssistantHandler<TVars, TAttrs>,
  ): Promise<AssistantResult<TAttrs>> {
    await emitDurableExecutionEvent(state, 'model.started', {
      stepId,
      phase: 'model',
    });
    try {
      const result = await handler(session);
      await emitDurableExecutionEvent(state, 'model.completed', {
        stepId,
        phase: 'model',
      });
      return result;
    } catch (error) {
      await emitDurableExecutionEvent(state, 'model.failed', {
        stepId,
        phase: 'model',
        error,
      });
      throw error;
    }
  }

  private async executeDurableTool<TAttrs extends Attrs>(
    state: DurableExecutionState<any, TAttrs>,
    stepId: string,
    call: ToolCall,
    session: Session<any, TAttrs>,
    journal: {
      journalStepId: string;
      nestedStepIds: string[];
      eventStepId?: string;
    },
  ): Promise<unknown> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      throw new Error(`Unknown durable tool: ${call.name}`);
    }
    const activity = resolveDurableToolActivity(tool, call, {
      runId: state.runId,
      stepId,
      session,
      context: state.context,
    });
    await emitDurableExecutionEvent(state, 'tool.started', {
      stepId: journal.eventStepId ?? stepId,
      phase: 'tool',
      raw: { toolCall: call, activity },
      toolCallId: call.id,
      name: call.name,
    });
    try {
      const result = await this.executeDurableToolWithRetry(
        tool,
        call,
        activity,
        state,
        stepId,
        session,
        journal,
      );
      await emitDurableExecutionEvent(state, 'tool.completed', {
        stepId: journal.eventStepId ?? stepId,
        phase: 'tool',
        raw: { toolCall: call, activity },
        toolCallId: call.id,
        name: call.name,
      });
      return result;
    } catch (error) {
      await emitDurableExecutionEvent(state, 'tool.failed', {
        stepId: journal.eventStepId ?? stepId,
        phase: 'tool',
        raw: { toolCall: call, activity },
        toolCallId: call.id,
        name: call.name,
        error,
      });
      throw error;
    }
  }

  private async executeDurableToolWithRetry<TAttrs extends Attrs>(
    tool: DurableTool,
    call: ToolCall,
    activity: DurableActivityOptions,
    state: DurableExecutionState<any, TAttrs>,
    stepId: string,
    session: Session<any, TAttrs>,
    journal: {
      journalStepId: string;
      nestedStepIds: string[];
    },
  ): Promise<unknown> {
    const maxAttempts = durableActivityMaxAttempts(activity);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const nestedStart = journal.nestedStepIds.length;
      try {
        return await tool.execute(call.arguments, {
          runId: state.runId,
          stepId,
          session,
          context: state.context,
          toolCall: call,
          activity,
          durable: createDurableToolBoundary(
            state,
            journal.journalStepId,
            call,
            journal.nestedStepIds,
          ),
        });
      } catch (error) {
        if (
          attempt === maxAttempts ||
          journal.nestedStepIds.length !== nestedStart
        ) {
          throw error;
        }
      }
    }
    throw new Error('Durable tool retry exhausted without an error.');
  }
}

function assertDurablePatchTransitionSupported(
  transition: ResolvedExecutionTransition,
  nodePath: string,
): void {
  if (
    transition.command.type !== 'none' &&
    transition.command.type !== 'halt'
  ) {
    throw new Error(
      `Durable patch ${nodePath} returned unsupported command ${transition.command.type}.`,
    );
  }
}

function handleDurablePhaseCommand<TVars extends Vars, TAttrs extends Attrs>(
  command: ResolvedExecutionCommand,
  nodePath: string,
  session: Session<TVars, TAttrs>,
): void {
  if (command.type === 'none') {
    return;
  }
  if (command.type === 'halt') {
    throw new Halt(session);
  }
  throw new Error(
    `Durable phase ${nodePath} returned unsupported command ${command.type}.`,
  );
}

function assertPrepareModelInputDidNotPersistSession(
  steps: readonly ExecutionPhaseStep[],
  nodePath: string,
): void {
  const hasPersistentSessionDelta = steps.some(({ transition }) => {
    const delta = transition.session;
    return (
      delta.messageOp.type !== 'none' ||
      Object.keys(delta.varsSet).length > 0 ||
      delta.varsDelete.length > 0
    );
  });
  if (hasPersistentSessionDelta) {
    throw new Error(
      `Durable prepareModelInput ${nodePath} cannot return persistent session patches. Return request.session instead.`,
    );
  }
}

export interface StoredRun<TVars extends Vars, TAttrs extends Attrs> {
  agent: DurableAgent<TVars, TAttrs>;
  agentName: string;
  initial: Session<TVars, TAttrs>;
  status: 'open' | 'done';
  result?: Session<TVars, TAttrs>;
  journal: JournalState;
  events?: ExecutionEvent[];
  outbox: AssistantDeliveryOutboxEntry<TAttrs>[];
  inbox: Inbound[];
  eventSeq?: number;
  context?: Record<string, unknown>;
}

export interface PromptTrailRunOptions<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  agent: string | DurableAgent<TVars, TAttrs>;
  runId?: string;
  input?: string | Omit<Inbound, 'offset'>;
  session?: Session<TVars, TAttrs>;
  durable?: boolean;
  resumable?: boolean;
  context?: Record<string, unknown>;
}

export interface PromptTrailSendOptions {
  agent?: string;
  runId: string;
  input: string | Omit<Inbound, 'offset'>;
  durable?: boolean;
  resumable?: boolean;
  context?: Record<string, unknown>;
}

export interface InboundRuntimeEvent {
  source: string;
  agent: string;
  runId: string;
  input: string;
  kind?: InboundKind;
  durable?: boolean;
  resumable?: boolean;
  attrs?: Attrs;
}

export interface EventSource {
  start(
    emit: (event: InboundRuntimeEvent) => Promise<void>,
  ): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export interface DurableRunStore {
  get(runId: string): StoredRun<any, any> | undefined;
  set(runId: string, run: StoredRun<any, any>): void;
  has(runId: string): boolean;
  delete(runId: string): void;
  entries(): Iterable<[string, StoredRun<any, any>]>;
}

export class MemoryRunStore implements DurableRunStore {
  private runs = new Map<string, StoredRun<any, any>>();

  get(runId: string): StoredRun<any, any> | undefined {
    return this.runs.get(runId);
  }

  set(runId: string, run: StoredRun<any, any>): void {
    this.runs.set(runId, run);
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  entries(): Iterable<[string, StoredRun<any, any>]> {
    return this.runs.entries();
  }
}

export interface PromptTrailAppOptions {
  store?: DurableRunStore;
  /**
   * App-level durable defaults. This configures the runtime's store and the
   * default durability for new app runs. Per-run `durable` options are booleans
   * that override this default.
   */
  durable?: {
    store?: DurableRunStore;
    defaultDurable?: boolean;
  };
  agents?: Record<string, DurableAgent<any, any>>;
  sources?: Record<string, EventSource>;
  middleware?: readonly MiddlewareDefinition<any, any>[];
  hooks?: readonly HookDefinition<any, any>[];
  observers?: readonly ObserverLike[];
  strictObservers?: boolean;
  observerDeliveryBindings?: ObserverDeliveryBindingOptions;
}

export class PromptTrailApp {
  private readonly store: DurableRunStore;
  private readonly agents = new Map<string, DurableAgent<any, any>>();
  private readonly sources = new Map<string, EventSource>();
  private readonly middleware: readonly MiddlewareDefinition<any, any>[];
  private readonly hooks: readonly HookDefinition<any, any>[];
  private readonly observerBus: ObserverBus;
  private readonly strictObservers?: boolean;
  private readonly observerDeliveryBindingOptions?: ObserverDeliveryBindingOptions;
  private readonly observerBuses: ObserverBus[] = [];
  private nextObserverBusIndex = 0;
  private readonly defaultDurable: boolean;
  private readonly agentObserverBuses = new WeakMap<
    DurableAgent<any, any>,
    ObserverBus
  >();
  private runCounter = 0;

  constructor(options: PromptTrailAppOptions = {}) {
    this.store = options.durable?.store ?? options.store ?? new MemoryRunStore();
    this.defaultDurable = options.durable?.defaultDurable ?? false;
    this.middleware = options.middleware ?? [];
    this.hooks = options.hooks ?? [];
    this.strictObservers = options.strictObservers;
    this.observerDeliveryBindingOptions = options.observerDeliveryBindings;
    this.observerBus = new ObserverBus(options.observers ?? [], {
      strictObservers: options.strictObservers,
      ...options.observerDeliveryBindings,
    });
    for (const [name, durableAgent] of Object.entries(options.agents ?? {})) {
      this.agent(name, durableAgent);
    }
    for (const [name, source] of Object.entries(options.sources ?? {})) {
      this.sources.set(name, source);
    }
  }

  agent(name: string, durableAgent: DurableAgent<any, any>): this {
    this.agents.set(name, durableAgent);
    return this;
  }

  source(name: string, source: EventSource): this {
    this.sources.set(name, source);
    return this;
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
    if (observerDeliveryBindings) {
      const normalized = normalizeObserver(observer);
      const namespacedObserver = normalized.name
        ? normalized
        : {
            ...normalized,
            name:
              observerNamespace ??
              `appObserver:${this.nextObserverBusIndex++}`,
          };
      const bus = new ObserverBus([namespacedObserver], {
        strictObservers: this.strictObservers,
        ...observerDeliveryBindings,
      });
      this.observerBuses.push(bus);
      return () => {
        const index = this.observerBuses.indexOf(bus);
        if (index >= 0) {
          this.observerBuses.splice(index, 1);
        }
      };
    }
    return this.observerBus.add(observer);
  }

  async start(): Promise<void> {
    for (const source of this.sources.values()) {
      await source.start((event) => this.handleEvent(event));
    }
  }

  async stop(): Promise<void> {
    for (const source of this.sources.values()) {
      await source.stop?.();
    }
  }

  async run<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    options: PromptTrailRunOptions<TVars, TAttrs>,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    return this.startRun(options);
  }

  async send<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    options: PromptTrailSendOptions,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const durable =
      options.durable ?? options.resumable ?? this.defaultDurable;
    const existing = this.store.get(options.runId);
    if (!existing) {
      if (!options.agent) {
        throw new Error(`Unknown durable run: ${options.runId}`);
      }
      return this.startRun<TVars, TAttrs>({
        agent: options.agent,
        runId: options.runId,
        input: options.input,
        durable,
        context: options.context,
      });
    }

    if (options.context) {
      existing.context = cloneDurableRuntimeValue(options.context);
    }
    this.append(options.runId, normalizeInbound(options.input));
    return this.resume<TVars, TAttrs>(options.runId);
  }

  async resume<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    runId: string,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const run = this.getRun<TVars, TAttrs>(runId);
    if (run.status === 'done' && run.result) {
      return { status: 'done', runId, session: run.result };
    }

    const state: DurableExecutionState<TVars, TAttrs> = {
      runId,
      session: run.initial,
      journal: run.journal,
      inbox: run.inbox,
      cursor: 0,
      sequencePosition: 0,
      transitionVersion: 0,
      middleware: this.middlewareForRun(run),
      hooks: this.hooksForRun(run),
      middlewareState: {},
      context: cloneDurableRuntimeValue(run.context),
      emitEvent: (event) => this.emitObservers(run, event),
      nextEventSeq: () => this.nextRunEventSeq(run),
    };

    await this.emitRunEvent(run, runId, 'run.started', {
      sessionVersion: state.transitionVersion,
    });
    try {
      const session = await run.agent.execute(state);
      run.status = 'done';
      run.result = session;
      this.materializeAssistantDeliveriesForRun(runId, run);
      await this.emitRunEvent(run, runId, 'run.completed', {
        sessionVersion: state.transitionVersion,
      });
      return { status: 'done', runId, session };
    } catch (error) {
      if (error instanceof Suspend) {
        run.result = state.session;
        await this.emitRunEvent(run, runId, 'run.suspended', {
          stepId: error.stepId,
          sessionVersion: state.transitionVersion,
        });
        return {
          status: 'suspended',
          runId,
          awaiting: error.stepId,
          session: state.session,
        };
      }
      if (error instanceof Halt) {
        run.status = 'done';
        run.result = error.session as Session<TVars, TAttrs>;
        this.materializeAssistantDeliveriesForRun(runId, run);
        await this.emitRunEvent(run, runId, 'run.completed', {
          sessionVersion: state.transitionVersion,
        });
        return {
          status: 'done',
          runId,
          session: run.result,
        };
      }
      await this.emitRunEvent(run, runId, 'error', {
        sessionVersion: state.transitionVersion,
        error,
        raw: { error },
      });
      throw error;
    }
  }

  journal(runId: string): readonly string[] {
    return [...this.getRun(runId).journal.sequence];
  }

  prepareAssistantDeliveries<TAttrs extends Attrs = Attrs>(
    runId: string,
    deliveries: readonly AssistantDeliveryOutboxInput<TAttrs>[],
  ): AssistantDeliveryOutboxEntry<TAttrs>[] {
    const run = this.store.get(runId);
    if (!run) {
      return deliveries.map((delivery) =>
        createAssistantDeliveryOutboxEntry(runId, delivery),
      );
    }
    const outbox = (run.outbox ??=
      []) as AssistantDeliveryOutboxEntry<TAttrs>[];
    for (const delivery of deliveries) {
      const existing = outbox.find(
        (entry) => entry.idempotencyKey === delivery.idempotencyKey,
      );
      if (!existing) {
        outbox.push(createAssistantDeliveryOutboxEntry(runId, delivery));
      } else {
        Object.assign(
          existing,
          completeAssistantDeliveryOutboxMetadata(runId, existing),
        );
      }
    }
    this.store.set(runId, run);
    return outbox.filter(
      (entry) =>
        deliveries.some(
          (delivery) => delivery.idempotencyKey === entry.idempotencyKey,
        ) &&
        isRetryableAssistantDeliveryStatus(entry.status),
    );
  }

  markAssistantDelivery(
    runId: string,
    idempotencyKey: string,
    status: AssistantDeliveryOutboxEntry['status'],
    error?: unknown,
    platformBinding?: unknown,
  ): void {
    const run = this.store.get(runId);
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
    this.store.set(runId, run);
  }

  assistantDeliveryOutbox(
    runId: string,
  ): readonly AssistantDeliveryOutboxEntry[] {
    const run = this.store.get(runId);
    if (!run) {
      return [];
    }
    this.materializeAssistantDeliveriesForRun(runId, run);
    if (this.backfillAssistantDeliveryOutboxMetadata(runId, run)) {
      this.store.set(runId, run);
    }
    return run ? [...(run.outbox ?? [])] : [];
  }

  events(runId: string): readonly ExecutionEvent[] {
    const run = this.store.get(runId);
    return run ? [...(run.events ?? [])] : [];
  }

  async replayEvents(
    runId: string,
    observers?: readonly ObserverLike[],
  ): Promise<readonly ExecutionEvent[]> {
    const run = this.getRun(runId);
    const events = (run.events ?? []).map((event) => ({
      ...event,
      replay: 'replayed' as const,
    }));
    if (observers) {
      const bus = new ObserverBus(observers, {
        strictObservers: this.strictObservers,
        ...this.observerDeliveryBindingOptions,
      });
      const context = observerContextFromRunContext(run.context);
      for (const event of events) {
        await bus.emit(event, context);
      }
      return events;
    }
    for (const event of events) {
      await this.emitReplayedObservers(run, event);
    }
    return events;
  }

  pendingAssistantDeliveryOutbox(): PendingAssistantDeliveryOutboxEntry[] {
    this.materializePendingAssistantDeliveries();
    const pending: PendingAssistantDeliveryOutboxEntry[] = [];
    for (const [runId, run] of this.store.entries()) {
      const changed = this.backfillAssistantDeliveryOutboxMetadata(runId, run);
      for (const entry of run.outbox ?? []) {
        if (isRetryableAssistantDeliveryStatus(entry.status)) {
          pending.push({ runId, entry });
        }
      }
      if (changed) {
        this.store.set(runId, run);
      }
    }
    return pending;
  }

  private backfillAssistantDeliveryOutboxMetadata<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(runId: string, run: StoredRun<TVars, TAttrs>): boolean {
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

  materializePendingAssistantDeliveries(): void {
    for (const [runId, run] of this.store.entries()) {
      this.materializeAssistantDeliveriesForRun(runId, run);
    }
  }

  private materializeAssistantDeliveriesForRun<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(runId: string, run: StoredRun<TVars, TAttrs>): void {
    const target = deliveryTargetFromContext(run.context);
    if (!target || !run.result) {
      return;
    }
    const deliveries = run.result.messages
      .filter(
        (message): message is PromptTrailMessage<TAttrs> & {
          type: 'assistant';
        } => message.type === 'assistant',
      )
      .map((message, index) => ({
        message,
        assistantIndex: index,
        idempotencyKey: assistantDeliveryKey(runId, index, target),
        target,
      }));
    this.prepareAssistantDeliveries(runId, deliveries);
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
      durable: event.durable,
      resumable: event.resumable,
    });
  }

  private async startRun<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(
    options: PromptTrailRunOptions<TVars, TAttrs>,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const durable =
      options.durable ?? options.resumable ?? this.defaultDurable;
    const durableAgent = this.resolveAgent(options.agent);
    const runId = options.runId ?? `${durableAgent.name}-${++this.runCounter}`;
    const initial = options.session ?? Session.create<TVars, TAttrs>();
    const context = cloneDurableRuntimeValue(options.context);
    const run: StoredRun<TVars, TAttrs> = {
      agent: durableAgent,
      agentName: durableAgent.name,
      initial,
      status: 'open',
      journal: { results: new Map(), sequence: [] },
      events: [],
      outbox: [],
      inbox: [],
      eventSeq: 0,
      context,
    };

    if (durable) {
      this.store.set(runId, run);
      if (options.input !== undefined) {
        this.append(runId, normalizeInbound(options.input));
      }
      return this.resume<TVars, TAttrs>(runId);
    }

    if (options.input !== undefined) {
      run.inbox.push({ ...normalizeInbound(options.input), offset: 0 });
    }
    return this.executeEphemeral(runId, run);
  }

  private async executeEphemeral<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(
    runId: string,
    run: StoredRun<TVars, TAttrs>,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const state: DurableExecutionState<TVars, TAttrs> = {
      runId,
      session: run.initial,
      journal: run.journal,
      inbox: run.inbox,
      cursor: 0,
      sequencePosition: 0,
      transitionVersion: 0,
      middleware: this.middlewareForRun(run),
      hooks: this.hooksForRun(run),
      middlewareState: {},
      context: cloneDurableRuntimeValue(run.context),
      emitEvent: (event) => this.emitObservers(run, event),
      nextEventSeq: () => this.nextRunEventSeq(run),
    };
    await this.emitRunEvent(run, runId, 'run.started', {
      sessionVersion: state.transitionVersion,
    });
    try {
      const session = await run.agent.execute(state);
      await this.emitRunEvent(run, runId, 'run.completed', {
        sessionVersion: state.transitionVersion,
      });
      return { status: 'done', runId, session };
    } catch (error) {
      if (error instanceof Suspend) {
        await this.emitRunEvent(run, runId, 'run.suspended', {
          stepId: error.stepId,
          sessionVersion: state.transitionVersion,
        });
        return {
          status: 'suspended',
          runId,
          awaiting: error.stepId,
          session: state.session,
        };
      }
      if (error instanceof Halt) {
        const session = error.session as Session<TVars, TAttrs>;
        await this.emitRunEvent(run, runId, 'run.completed', {
          sessionVersion: state.transitionVersion,
        });
        return { status: 'done', runId, session };
      }
      await this.emitRunEvent(run, runId, 'error', {
        sessionVersion: state.transitionVersion,
        error,
        raw: { error },
      });
      throw error;
    }
  }

  private async emitRunEvent<TVars extends Vars, TAttrs extends Attrs>(
    run: StoredRun<TVars, TAttrs>,
    runId: string,
    type: 'run.started' | 'run.completed' | 'run.suspended' | 'error',
    options: Partial<ExecutionEvent> = {},
  ): Promise<void> {
    const seq = this.nextRunEventSeq(run);
    await this.emitObservers(run, {
      id: `${runId}:${seq}:${type}`,
      type,
      at: new Date().toISOString(),
      seq,
      conversationId: runId,
      runId,
      replay: 'live',
      source: 'app',
      ...options,
      idempotencyKey:
        options.idempotencyKey ?? runEventIdempotencyKey(runId, seq, type),
    });
  }

  private middlewareForRun<TVars extends Vars, TAttrs extends Attrs>(
    run: StoredRun<TVars, TAttrs>,
  ): readonly MiddlewareDefinition<TVars, TAttrs>[] {
    return [
      ...run.agent.runtimeMiddleware(),
      ...(this.middleware as readonly MiddlewareDefinition<TVars, TAttrs>[]),
    ];
  }

  private hooksForRun<TVars extends Vars, TAttrs extends Attrs>(
    run: StoredRun<TVars, TAttrs>,
  ): readonly HookDefinition<TVars, TAttrs>[] {
    return [
      ...run.agent.runtimeHooks(),
      ...(this.hooks as readonly HookDefinition<TVars, TAttrs>[]),
    ];
  }

  private async emitObservers<TVars extends Vars, TAttrs extends Attrs>(
    run: StoredRun<TVars, TAttrs>,
    event: ExecutionEvent,
  ): Promise<void> {
    if ((event.replay ?? 'live') === 'live') {
      (run.events ??= []).push({ ...event });
    }
    await this.emitObserverBuses(run, event);
  }

  private async emitReplayedObservers<TVars extends Vars, TAttrs extends Attrs>(
    run: StoredRun<TVars, TAttrs>,
    event: ExecutionEvent,
  ): Promise<void> {
    await this.emitObserverBuses(run, event);
  }

  private async emitObserverBuses<TVars extends Vars, TAttrs extends Attrs>(
    run: StoredRun<TVars, TAttrs>,
    event: ExecutionEvent,
  ): Promise<void> {
    const context = observerContextFromRunContext(run.context);
    await this.observerBus.emit(event, context);
    for (const bus of this.observerBuses) {
      await bus.emit(event, context);
    }
    const observers = run.agent.runtimeObservers();
    if (observers.length === 0) {
      return;
    }
    await this.observerBusForAgent(run.agent, observers).emit(event, context);
  }

  private observerBusForAgent(
    agent: DurableAgent<any, any>,
    observers: readonly ObserverLike[],
  ): ObserverBus {
    const existing = this.agentObserverBuses.get(agent);
    if (existing) {
      return existing;
    }
    const bus = new ObserverBus(observers, {
      strictObservers: this.strictObservers,
      ...this.observerDeliveryBindingOptions,
    });
    this.agentObserverBuses.set(agent, bus);
    return bus;
  }

  private nextRunEventSeq<TVars extends Vars, TAttrs extends Attrs>(
    run: StoredRun<TVars, TAttrs>,
  ): number {
    const seq = run.eventSeq ?? 0;
    run.eventSeq = seq + 1;
    return seq;
  }

  private append(runId: string, message: Omit<Inbound, 'offset'>): void {
    const run = this.getRun(runId);
    run.inbox.push({ ...message, offset: run.inbox.length });
    if (run.status === 'done') {
      run.status = 'open';
      run.result = undefined;
    }
  }

  private resolveAgent<TVars extends Vars, TAttrs extends Attrs>(
    durableAgent: string | DurableAgent<TVars, TAttrs>,
  ): DurableAgent<TVars, TAttrs> {
    if (typeof durableAgent !== 'string') {
      return durableAgent;
    }
    const resolved = this.agents.get(durableAgent);
    if (!resolved) {
      throw new Error(`Unknown agent: ${durableAgent}`);
    }
    return resolved as DurableAgent<TVars, TAttrs>;
  }

  private getRun<TVars extends Vars, TAttrs extends Attrs>(
    runId: string,
  ): StoredRun<TVars, TAttrs> {
    const run = this.store.get(runId);
    if (!run) {
      throw new Error(`Unknown durable run: ${runId}`);
    }
    return run as StoredRun<TVars, TAttrs>;
  }
}

export class MemoryDurableRuntime {
  private readonly app = new PromptTrailApp();

  async start<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    durableAgent: DurableAgent<TVars, TAttrs>,
    options: {
      runId: string;
      session?: Session<TVars, TAttrs>;
      input?: string;
    },
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    return this.app.run<TVars, TAttrs>({
      agent: durableAgent,
      runId: options.runId,
      session: options.session,
      input: options.input,
      durable: true,
    });
  }

  async send<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    runId: string,
    content: string | Omit<Inbound, 'offset'>,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    return this.app.send<TVars, TAttrs>({
      runId,
      input: content,
      durable: true,
    });
  }

  async resume<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    runId: string,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    return this.app.resume<TVars, TAttrs>(runId);
  }

  journal(runId: string): readonly string[] {
    return this.app.journal(runId);
  }
}

function normalizeInbound(
  input: string | Omit<Inbound, 'offset'>,
): Omit<Inbound, 'offset'> {
  return typeof input === 'string' ? { kind: 'user', content: input } : input;
}

function deliveryTargetFromContext(
  context: Record<string, unknown> | undefined,
): DeliveryTarget | undefined {
  const delivery = context?.delivery;
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

function observerContextFromRunContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    runContext: cloneDurableRuntimeValue(context),
    delivery: cloneDurableRuntimeValue(deliveryTargetFromContext(context)),
  };
}

function isRetryableAssistantDeliveryStatus(
  status: AssistantDeliveryOutboxEntry['status'],
): boolean {
  return (
    status === 'pending' || status === 'delivering' || status === 'failed'
  );
}

function createAssistantDeliveryOutboxEntry<TAttrs extends Attrs>(
  conversationId: string,
  delivery: AssistantDeliveryOutboxInput<TAttrs>,
): AssistantDeliveryOutboxEntry<TAttrs> {
  return completeAssistantDeliveryOutboxMetadata(conversationId, {
    ...delivery,
    target: cloneDurableRuntimeValue(delivery.target),
    status: 'pending',
    attempts: 0,
  });
}

function completeAssistantDeliveryOutboxMetadata<TAttrs extends Attrs>(
  conversationId: string,
  entry: AssistantDeliveryOutboxInput<TAttrs> &
    Partial<
      Pick<
        AssistantDeliveryOutboxEntry<TAttrs>,
        'id' | 'conversationId' | 'messageRef' | 'platformBinding'
      >
    > &
    Pick<
      AssistantDeliveryOutboxEntry<TAttrs>,
      'status' | 'attempts' | 'lastError' | 'error'
    >,
): AssistantDeliveryOutboxEntry<TAttrs> {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runEventIdempotencyKey(
  runId: string,
  seq: number,
  type: string,
): string {
  return `${runId}:run:${seq}:${type}`;
}

export function agent<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
  name: string,
): DurableAgent<TVars, TAttrs> {
  return new DurableAgent<TVars, TAttrs>(name);
}

export function memoryStore(): DurableRunStore {
  return new MemoryRunStore();
}

export function app(options: PromptTrailAppOptions = {}): PromptTrailApp {
  return new PromptTrailApp(options);
}

export function manualSource(): EventSource & {
  emit(event: InboundRuntimeEvent): Promise<void>;
} {
  let emitEvent: ((event: InboundRuntimeEvent) => Promise<void>) | undefined;
  return {
    start(emit) {
      emitEvent = emit;
    },
    async emit(event) {
      if (!emitEvent) {
        throw new Error('Manual source has not been started');
      }
      await emitEvent(event);
    },
  };
}

export const PromptTrail = {
  app,
  bundle,
  server,
};
