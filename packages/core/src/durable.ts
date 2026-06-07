import { Message, type Message as PromptTrailMessage } from './message';
import {
  ObserverBus,
  applyResolvedExecutionTransition,
  resolveExecutionTransition,
  type ExecutionEvent,
  type ExecutionPatch,
  type ObserverLike,
  type ResolvedExecutionCommand,
  type ResolvedExecutionTransition,
} from './execution';
import {
  runExecutionPhase,
  runMiddlewareWrapper,
  type ExecutionLifecyclePhase,
  type ExecutionPhaseStep,
  type ExecutionWrapperPhase,
  type HookDefinition,
  type MiddlewareDefinition,
  type RunMiddlewareWrapperResult,
  type RunExecutionPhaseResult,
} from './interceptors';
import { bundle } from './runtime_bindings';
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

export interface DurableActivityOptions {
  kind: DurableActivityKind;
  idempotencyKey?: string;
}

export interface DurableActivityContext {
  runId: string;
  stepId: string;
  session: Session<any, any>;
}

export interface DurableToolExecutionContext extends DurableActivityContext {
  toolCall: ToolCall;
  activity: DurableActivityOptions;
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
  status: 'pending' | 'completed' | 'failed' | 'skipped';
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

  const record = await journaled(state, stepId, async () => {
    const phase = await runExecutionPhase({
      phase: options.phase,
      session: options.session,
      request: options.request,
      result: options.result,
      middlewareState: state.middlewareState,
      middleware: state.middleware,
      hooks: state.hooks,
      beforeVersion: state.transitionVersion,
    });
    return {
      request: phase.request,
      result: phase.result,
      command: phase.command,
      beforeVersion: phase.beforeVersion,
      afterVersion: phase.afterVersion,
      middlewareState: phase.middlewareState,
      steps: phase.steps,
    } satisfies DurablePhaseJournal<TAttrs>;
  });

  if (record.beforeVersion !== state.transitionVersion) {
    throw new NondeterminismError(
      `version:${state.transitionVersion}`,
      `version:${record.beforeVersion}`,
      state.sequencePosition - 1,
    );
  }

  let session = options.session;
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
  return (
    state.middleware.some((middleware) => Boolean(middleware[phase])) ||
    state.hooks.some((hook) => Boolean(hookHandlerForDurablePhase(hook, phase)))
  );
}

function hookHandlerForDurablePhase<TVars extends Vars, TAttrs extends Attrs>(
  hook: HookDefinition<TVars, TAttrs>,
  phase: ExecutionLifecyclePhase,
): unknown {
  switch (phase) {
    case 'beforeAgent':
      return hook.onBeforeAgent;
    case 'afterAgent':
      return hook.onAfterAgent;
    case 'beforeModel':
      return hook.onBeforeModel;
    case 'afterModel':
      return hook.onAfterModel;
    case 'beforeTool':
      return hook.onBeforeTool;
    case 'afterTool':
      return hook.onAfterTool;
    case 'prepareModelInput':
      return undefined;
  }
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
    }) => Promise<TResult>;
  },
): Promise<RunMiddlewareWrapperResult<TVars, TAttrs, TRequest, TResult>> {
  if (state.journal.results.has(stepId)) {
    const record = state.journal.results.get(stepId) as DurableWrapperJournal<
      TVars,
      TAttrs
    >;
    return replayDurableWrapperJournal(state, stepId, options.session, record);
  }

  const nestedStepIds: string[] = [];
  let nestedCallIndex = 0;
  const wrapped = await runMiddlewareWrapper({
    phase: options.phase,
    session: options.session,
    request: options.request,
    call: async (input) => {
      const nestedStepId = `${stepId}/next/${nestedCallIndex++}`;
      nestedStepIds.push(nestedStepId);
      return journaled(state, nestedStepId, () => options.call(input));
    },
    middlewareState: state.middlewareState,
    middleware: state.middleware,
    beforeVersion: state.transitionVersion,
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
  commitDurableWrapperJournal(state, stepId, record);

  return applyDurableWrapperJournal(state, options.session, record);
}

function commitDurableWrapperJournal<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  record: DurableWrapperJournal<TVars, TAttrs>,
): void {
  const expected = state.journal.sequence[state.sequencePosition];
  if (expected !== undefined) {
    throw new NondeterminismError(expected, stepId, state.sequencePosition);
  }
  state.journal.results.set(stepId, record);
  state.journal.sequence.push(stepId);
  state.sequencePosition++;
}

function replayDurableWrapperJournal<
  TVars extends Vars,
  TAttrs extends Attrs,
  TRequest,
  TResult,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  session: Session<TVars, TAttrs>,
  record: DurableWrapperJournal<TVars, TAttrs>,
): RunMiddlewareWrapperResult<TVars, TAttrs, TRequest, TResult> {
  for (const nestedStepId of record.nestedStepIds) {
    const expected = state.journal.sequence[state.sequencePosition];
    if (expected !== nestedStepId) {
      throw new NondeterminismError(
        expected,
        nestedStepId,
        state.sequencePosition,
      );
    }
    if (!state.journal.results.has(nestedStepId)) {
      throw new Error(`Missing durable wrapper nested step ${nestedStepId}.`);
    }
    state.sequencePosition++;
  }

  const expected = state.journal.sequence[state.sequencePosition];
  if (expected !== stepId) {
    throw new NondeterminismError(expected, stepId, state.sequencePosition);
  }
  state.sequencePosition++;
  return applyDurableWrapperJournal(state, session, record);
}

function applyDurableWrapperJournal<
  TVars extends Vars,
  TAttrs extends Attrs,
  TRequest,
  TResult,
>(
  state: DurableExecutionState<TVars, TAttrs>,
  baseSession: Session<TVars, TAttrs>,
  record: DurableWrapperJournal<TVars, TAttrs>,
): RunMiddlewareWrapperResult<TVars, TAttrs, TRequest, TResult> {
  if (record.beforeVersion !== state.transitionVersion) {
    throw new NondeterminismError(
      `version:${state.transitionVersion}`,
      `version:${record.beforeVersion}`,
      state.sequencePosition - 1,
    );
  }

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
    });
  } catch {
    // Tool/model progress events are observer side effects. They must not
    // prevent the surrounding durable activity result from being journaled.
  }
}

async function awaitInbound<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
): Promise<Inbound> {
  const offset = await journaled(state, stepId, async () => {
    const inbound = state.inbox.find(
      (message) => message.offset >= state.cursor,
    );
    if (!inbound) {
      throw new Suspend(stepId);
    }
    return inbound.offset;
  });
  state.cursor = offset + 1;
  const inbound = state.inbox.find((message) => message.offset === offset);
  if (!inbound) {
    throw new Error(`Missing inbox message at offset ${offset}`);
  }
  return inbound;
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

  constructor(readonly name: string) {}

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
    for (const node of this.nodes) {
      session = await this.executeNode(state, node, '', session);
      state.session = session;
    }
    return session;
  }

  private async executeNode(
    state: DurableExecutionState<TVars, TAttrs>,
    node: DurableNode<TVars, TAttrs>,
    path: string,
    session: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const nodePath = childPath(path, node.id);
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
        const applied = applyResolvedExecutionTransition(session, transition);
        state.transitionVersion = transition.afterVersion;
        state.session = applied.session;
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
        assertDurablePhaseCommandSupported(before.command, nodePath);
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
        assertDurablePhaseCommandSupported(prepared.command, nodePath);
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
            call: async ({ request }) => node.handler(request.session),
          });
          assertDurablePhaseCommandSupported(wrapped.command, nodePath);
          session = wrapped.session;
          state.session = session;
          message = normalizeAssistantMessage(wrapped.result);
        } else {
          message = await journaled(state, `${nodePath}/model`, async () =>
            normalizeAssistantMessage(await node.handler(modelSession)),
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
        assertDurablePhaseCommandSupported(after.command, nodePath);
        const finalMessage = normalizeAssistantMessage(
          (after.result as AssistantResult<TAttrs> | undefined) ?? message,
        );
        return after.session.addMessage(finalMessage);
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
          assertDurablePhaseCommandSupported(before.command, nodePath);
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
          assertDurablePhaseCommandSupported(prepared.command, nodePath);
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
              call: async ({ request }) => node.handler(request.session),
            });
            assertDurablePhaseCommandSupported(wrapped.command, nodePath);
            current = wrapped.session;
            state.session = current;
            message = normalizeAssistantMessage(wrapped.result);
          } else {
            message = await journaled(
              state,
              `${nodePath}#${iteration}/model`,
              async () =>
                normalizeAssistantMessage(await node.handler(modelSession)),
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
          assertDurablePhaseCommandSupported(after.command, nodePath);
          const finalMessage = normalizeAssistantMessage(
            (after.result as AssistantResult<TAttrs> | undefined) ?? message,
          );
          current = after.session.addMessage(finalMessage);
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
          assertDurablePhaseCommandSupported(before.command, stepId);
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
              call: async ({ session, request }) =>
                this.executeDurableTool(state, stepId, request, session),
            });
            assertDurablePhaseCommandSupported(wrapped.command, stepId);
            nextCall = (wrapped.request as ToolCall | undefined) ?? nextCall;
            toolSession = wrapped.session;
            message = normalizeToolResultMessage(wrapped.result, nextCall);
          } else {
            const result = await journaled(state, stepId, () =>
              this.executeDurableTool(state, stepId, nextCall, before.session),
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
          assertDurablePhaseCommandSupported(after.command, stepId);
          next = after.session.addMessage(
            (after.result as PromptTrailMessage<TAttrs> | undefined) ?? message,
          );
        }
        return next;
      }
      case 'awaitUser': {
        const inbound = await awaitInbound(state, `${nodePath}/input`);
        return session.addMessage(
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

  private async executeDurableTool<TAttrs extends Attrs>(
    state: DurableExecutionState<any, TAttrs>,
    stepId: string,
    call: ToolCall,
    session: Session<any, TAttrs>,
  ): Promise<unknown> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      throw new Error(`Unknown durable tool: ${call.name}`);
    }
    const activity = resolveDurableToolActivity(tool, call, {
      runId: state.runId,
      stepId,
      session,
    });
    await emitDurableExecutionEvent(state, 'tool.started', {
      stepId,
      phase: 'tool',
      raw: { toolCall: call, activity },
      toolCallId: call.id,
      name: call.name,
    });
    const result = await tool.execute(call.arguments, {
      runId: state.runId,
      stepId,
      session,
      toolCall: call,
      activity,
    });
    await emitDurableExecutionEvent(state, 'tool.completed', {
      stepId,
      phase: 'tool',
      raw: { toolCall: call, activity },
      toolCallId: call.id,
      name: call.name,
    });
    return result;
  }
}

function assertDurablePatchTransitionSupported(
  transition: ResolvedExecutionTransition,
  nodePath: string,
): void {
  if (transition.command.type !== 'none') {
    throw new Error(
      `Durable patch ${nodePath} returned unsupported command ${transition.command.type}.`,
    );
  }
  if (
    Object.keys(transition.session.middlewareStateSet).length > 0 ||
    transition.session.middlewareStateDelete.length > 0
  ) {
    throw new Error(
      `Durable patch ${nodePath} cannot write middlewareState yet.`,
    );
  }
}

function assertDurablePhaseCommandSupported(
  command: ResolvedExecutionCommand,
  nodePath: string,
): void {
  if (command.type === 'none') {
    return;
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
  outbox: AssistantDeliveryOutboxEntry<TAttrs>[];
  inbox: Inbound[];
  eventSeq?: number;
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
}

export interface PromptTrailSendOptions {
  agent?: string;
  runId: string;
  input: string | Omit<Inbound, 'offset'>;
  durable?: boolean;
  resumable?: boolean;
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
  agents?: Record<string, DurableAgent<any, any>>;
  sources?: Record<string, EventSource>;
  middleware?: readonly MiddlewareDefinition<any, any>[];
  hooks?: readonly HookDefinition<any, any>[];
  observers?: readonly ObserverLike[];
  strictObservers?: boolean;
}

export class PromptTrailApp {
  private readonly store: DurableRunStore;
  private readonly agents = new Map<string, DurableAgent<any, any>>();
  private readonly sources = new Map<string, EventSource>();
  private readonly middleware: readonly MiddlewareDefinition<any, any>[];
  private readonly hooks: readonly HookDefinition<any, any>[];
  private readonly observerBus: ObserverBus;
  private runCounter = 0;

  constructor(options: PromptTrailAppOptions = {}) {
    this.store = options.store ?? new MemoryRunStore();
    this.middleware = options.middleware ?? [];
    this.hooks = options.hooks ?? [];
    this.observerBus = new ObserverBus(options.observers ?? [], {
      strictObservers: options.strictObservers,
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
    const durable = options.durable ?? options.resumable ?? true;
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
      });
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
      middleware: this.middleware,
      hooks: this.hooks,
      middlewareState: {},
      emitEvent: (event) => this.observerBus.emit(event),
      nextEventSeq: () => this.nextRunEventSeq(run),
    };

    await this.emitRunEvent(run, runId, 'run.started', {
      sessionVersion: state.transitionVersion,
    });
    try {
      const session = await run.agent.execute(state);
      run.status = 'done';
      run.result = session;
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
      return deliveries.map((delivery) => ({
        ...delivery,
        status: 'pending',
      }));
    }
    const outbox = (run.outbox ??=
      []) as AssistantDeliveryOutboxEntry<TAttrs>[];
    for (const delivery of deliveries) {
      const existing = outbox.find(
        (entry) => entry.idempotencyKey === delivery.idempotencyKey,
      );
      if (!existing) {
        outbox.push({
          ...delivery,
          status: 'pending',
        });
      }
    }
    this.store.set(runId, run);
    return outbox.filter(
      (entry) =>
        deliveries.some(
          (delivery) => delivery.idempotencyKey === entry.idempotencyKey,
        ) &&
        (entry.status === 'pending' || entry.status === 'failed'),
    );
  }

  markAssistantDelivery(
    runId: string,
    idempotencyKey: string,
    status: AssistantDeliveryOutboxEntry['status'],
    error?: unknown,
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
    entry.error = error;
    this.store.set(runId, run);
  }

  assistantDeliveryOutbox(
    runId: string,
  ): readonly AssistantDeliveryOutboxEntry[] {
    const run = this.store.get(runId);
    return run ? [...(run.outbox ?? [])] : [];
  }

  pendingAssistantDeliveryOutbox(): PendingAssistantDeliveryOutboxEntry[] {
    const pending: PendingAssistantDeliveryOutboxEntry[] = [];
    for (const [runId, run] of this.store.entries()) {
      for (const entry of run.outbox ?? []) {
        if (entry.status === 'pending' || entry.status === 'failed') {
          pending.push({ runId, entry });
        }
      }
    }
    return pending;
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
    const durable = options.durable ?? options.resumable ?? false;
    const durableAgent = this.resolveAgent(options.agent);
    const runId = options.runId ?? `${durableAgent.name}-${++this.runCounter}`;
    const initial = options.session ?? Session.create<TVars, TAttrs>();
    const run: StoredRun<TVars, TAttrs> = {
      agent: durableAgent,
      agentName: durableAgent.name,
      initial,
      status: 'open',
      journal: { results: new Map(), sequence: [] },
      outbox: [],
      inbox: [],
      eventSeq: 0,
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
      middleware: this.middleware,
      hooks: this.hooks,
      middlewareState: {},
      emitEvent: (event) => this.observerBus.emit(event),
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
    await this.observerBus.emit({
      id: `${runId}:${seq}:${type}`,
      type,
      at: new Date().toISOString(),
      seq,
      conversationId: runId,
      runId,
      replay: 'live',
      source: 'app',
      ...options,
    });
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
