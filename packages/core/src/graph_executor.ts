import type { CallToolResult } from './capabilities';
import {
  ObserverBus,
  adoptSessionResult,
  type ExecutionEvent,
  type ObserverDeliveryBindingOptions,
  type ObserverLike,
  type ResolvedExecutionCommand,
} from './execution';
import type { AgentGraph, AgentGraphNode } from './graph';
import {
  createExecutionRuntimeState,
  extendExecutionRuntimeState,
  runRuntimeExecutionPhase,
  runRuntimeMiddlewareWrapper,
  type ExecutionDurableBoundary,
  type ExecutionDurableBoundaryProvider,
  type ExecutionEffectDeclaration,
  type ExecutionRuntimeState,
  type HookDefinition,
  type MiddlewareDefinition,
} from './interceptors';
import {
  Message,
  type AssistantMessage,
  type Message as PromptTrailMessage,
} from './message';
import { Session, type Vars } from './session';
import { type ModelOutput, Source } from './source';
import { Parallel } from './templates/composite/parallel';
import type { Template } from './templates/base';
import { ClaudeTurn } from './templates/primitives/claude_turn';
import { CodexTurn } from './templates/primitives/codex_turn';
import { executeRuntimeModelCall } from './templates/primitives/model_runtime';
import { Structured } from './templates/primitives/structured';
import {
  executePromptTrailTool,
  isPromptTrailTool,
  type PromptTrailTool,
} from './tool';
import type { ProviderSessionBinding } from './provider_session';
import type { IValidator } from './validators';

export interface GraphExecutionOptions<TVars extends Vars = Vars> {
  session?: Session<TVars>;
  input?: string | GraphInboundInput | readonly GraphInboundInput[];
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  maxLoopIterations?: number;
  observers?: readonly ObserverLike[];
  observerDeliveryBindings?: ObserverDeliveryBindingOptions;
  strictObservers?: boolean;
  eventScopeId?: string;
  nextEventSeq?: () => number;
  runtime?: ExecutionRuntimeState<TVars>;
  skipNode?: (
    node: AgentGraphNode,
    nodePath: string,
    session: Session<TVars>,
  ) => boolean;
  resumeFromNode?: string;
  durableToolBoundary?: (
    context: GraphToolDurableBoundaryContext<TVars>,
  ) => ExecutionDurableBoundary | undefined;
  durableToolExecution?: <T>(
    context: GraphDurableBoundaryContext<TVars>,
    execute: (durable?: ExecutionDurableBoundary) => Promise<T>,
  ) => Promise<T>;
  durableBoundary?: ExecutionDurableBoundaryProvider;
  providerSessions?: Record<string, ProviderSessionBinding>;
  recordProviderSession?: (
    nodePath: string,
    binding: ProviderSessionBinding,
  ) => Promise<void>;
  runEventSource?: ExecutionEvent['source'];
  unsupportedCommandLabel?: string;
  /**
   * Invoked whenever an inbox message is consumed, with the running count of
   * consumed messages (the executor's inbox cursor). Callers use the final
   * value to persist a durable inbox cursor that never runs ahead of the
   * session the graph actually produced. See the checkpoint continuation model.
   */
  onInboxConsumed?: (consumedCount: number) => void;
}

export interface GraphToolDurableBoundaryContext<TVars extends Vars = Vars> {
  kind: 'tool';
  nodePath: string;
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  session: Session<TVars>;
  tool: PromptTrailTool<unknown, unknown>;
}

export interface GraphTransformDurableBoundaryContext<
  TVars extends Vars = Vars,
> {
  kind: 'transform';
  nodePath: string;
  session: Session<TVars>;
  effect: ExecutionEffectDeclaration;
  idempotencyKey?: string;
}

export type GraphDurableBoundaryContext<TVars extends Vars = Vars> =
  | GraphToolDurableBoundaryContext<TVars>
  | GraphTransformDurableBoundaryContext<TVars>;

export class GraphExecutionSuspended extends Error {
  constructor(
    public readonly nodePath: string,
    message = `Graph execution suspended at ${nodePath}`,
    public readonly session?: Session,
  ) {
    super(message);
    this.name = 'GraphExecutionSuspended';
  }
}

export interface GraphInboundInput {
  kind?: 'user' | 'system' | 'control';
  content: string;
  attrs?: Readonly<Record<string, unknown>>;
}

interface GraphExecutionState<TVars extends Vars> {
  graph: AgentGraph;
  session: Session<TVars>;
  inbox: GraphInboundInput[];
  cursor: number;
  maxLoopIterations: number;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  runtime: ExecutionRuntimeState<TVars>;
  skipNode?: GraphExecutionOptions<TVars>['skipNode'];
  resumeFromNode?: string;
  durableToolBoundary?: GraphExecutionOptions<TVars>['durableToolBoundary'];
  durableToolExecution?: GraphExecutionOptions<TVars>['durableToolExecution'];
  runEventSource: ExecutionEvent['source'];
  unsupportedCommandLabel?: string;
  activeGoal?: ActiveGoalExecution;
  onInboxConsumed?: (consumedCount: number) => void;
}

type GraphNodeData = Record<string, unknown>;
type ConsumedInboxKind = 'user' | 'system' | 'control' | false;

interface ActiveGoalExecution {
  goal: string;
  nodePath: string;
  attempt: number;
  maxAttempts: number;
  onUnsatisfied: 'retry' | 'continue' | 'halt';
  interaction: 'none' | 'optional' | 'required';
  interacted: boolean;
  satisfied: boolean;
  stopped: boolean;
}

export async function executeAgentGraph<TVars extends Vars = Vars>(
  graph: AgentGraph,
  options: GraphExecutionOptions<TVars> = {},
): Promise<Session<TVars>> {
  const observerBus = new ObserverBus(
    [...graph.observers, ...(options.observers ?? [])],
    {
      strictObservers: options.strictObservers,
      ...options.observerDeliveryBindings,
    },
  );
  const eventScopeId =
    options.eventScopeId ??
    options.runtime?.eventScopeId ??
    createGraphExecutionEventScopeId();
  let eventSeq = 0;
  const nextEventSeq =
    options.nextEventSeq ?? options.runtime?.nextEventSeq ?? (() => eventSeq++);
  const context = options.context ?? options.runtime?.context;
  const signal = options.signal ?? options.runtime?.signal;
  const emitEvent = (event: ExecutionEvent) =>
    Promise.resolve(options.runtime?.emitEvent?.(event)).then(() =>
      observerBus.emit(event, {
        ...context,
        signal,
      }),
    );
  const runtime = options.runtime
    ? extendExecutionRuntimeState(options.runtime, {
        middleware: graph.middleware,
        hooks: graph.hooks,
      })
    : createExecutionRuntimeState<TVars>({
        middleware: graph.middleware,
        hooks: graph.hooks,
        context,
        signal,
        emitEvent,
        eventScopeId,
        nextEventSeq,
        durableBoundary: options.durableBoundary,
        providerSessions: options.providerSessions,
        recordProviderSession: options.recordProviderSession,
      });
  if (options.runtime) {
    runtime.context = context;
    runtime.signal = signal;
    runtime.emitEvent = emitEvent;
    runtime.eventScopeId = eventScopeId;
    runtime.nextEventSeq = nextEventSeq;
    runtime.durableBoundary =
      options.durableBoundary ?? options.runtime.durableBoundary;
    runtime.providerSessions =
      options.providerSessions ?? options.runtime.providerSessions;
    runtime.recordProviderSession =
      options.recordProviderSession ?? options.runtime.recordProviderSession;
  }
  const state: GraphExecutionState<TVars> = {
    graph,
    session: options.session ?? Session.create<TVars>(),
    inbox: normalizeGraphInbox(options.input),
    cursor: 0,
    maxLoopIterations: options.maxLoopIterations ?? 10,
    context,
    signal,
    runtime,
    skipNode: options.skipNode,
    resumeFromNode: options.resumeFromNode,
    durableToolBoundary: options.durableToolBoundary,
    durableToolExecution: options.durableToolExecution,
    runEventSource: options.runEventSource ?? 'graph',
    unsupportedCommandLabel: options.unsupportedCommandLabel,
    onInboxConsumed: options.onInboxConsumed,
  };

  await emitGraphRunEvent('run.started', state, {
    sessionVersion: state.session.messages.length,
  });
  try {
    const before = await runRuntimeExecutionPhase(state.runtime, {
      phase: 'beforeAgent',
      session: state.session,
      middleware: graph.middleware as readonly MiddlewareDefinition<TVars>[],
      hooks: graph.hooks as readonly HookDefinition<TVars>[],
    });
    state.session = before.session;
    if (before.command.type !== 'none') {
      if (before.command.type === 'halt') {
        await emitGraphRunEvent('run.completed', state, {
          sessionVersion: state.session.messages.length,
        });
        return state.session;
      }
      throwUnsupportedGraphCommandForState(
        state,
        before.command,
        'beforeAgent',
      );
    }

    const materializeInboxWithoutConsumer =
      state.inbox.length > 0 && !graphHasInboundConsumer(graph.nodes);
    let inboxMaterialized = false;
    for (const node of graph.nodes) {
      if (
        materializeInboxWithoutConsumer &&
        !inboxMaterialized &&
        node.type !== 'system'
      ) {
        materializeRemainingInbox(state);
        inboxMaterialized = true;
      }
      const halted = await executeGraphNodeWithLegacyLifecycle(
        node,
        `${graph.name}/${node.id}`,
        state,
      );
      if (halted) break;
    }
    if (materializeInboxWithoutConsumer && !inboxMaterialized) {
      materializeRemainingInbox(state);
    }

    const after = await runRuntimeExecutionPhase(state.runtime, {
      phase: 'afterAgent',
      session: state.session,
      middleware: graph.middleware as readonly MiddlewareDefinition<TVars>[],
      hooks: graph.hooks as readonly HookDefinition<TVars>[],
    });
    state.session = after.session;
    if (after.command.type !== 'none') {
      if (after.command.type === 'halt') {
        await emitGraphRunEvent('run.completed', state, {
          sessionVersion: state.session.messages.length,
        });
        return state.session;
      }
      throwUnsupportedGraphCommandForState(state, after.command, 'afterAgent');
    }

    await emitGraphRunEvent('run.completed', state, {
      sessionVersion: state.session.messages.length,
    });
    return state.session;
  } catch (error) {
    if (error instanceof GraphExecutionSuspended) {
      await emitGraphRunEvent('run.suspended', state, {
        stepId: error.nodePath,
        sessionVersion:
          error.session?.messages.length ?? state.session.messages.length,
      });
      throw error;
    }
    await emitGraphRunEvent('run.failed', state, {
      sessionVersion: state.session.messages.length,
      error,
    });
    throw error;
  } finally {
    if (options.runtime) {
      options.runtime.middlewareState = state.runtime.middlewareState;
      options.runtime.version = state.runtime.version;
    }
  }
}

async function emitGraphRunEvent<TVars extends Vars>(
  type: 'run.started' | 'run.completed' | 'run.suspended' | 'run.failed',
  state: GraphExecutionState<TVars>,
  event: Partial<ExecutionEvent> = {},
): Promise<void> {
  if (!state.runtime.emitEvent || !state.runtime.nextEventSeq) {
    return;
  }
  const seq = state.runtime.nextEventSeq();
  await state.runtime.emitEvent({
    id: `agent:${seq}`,
    type,
    at: new Date().toISOString(),
    seq,
    source: state.runEventSource,
    ...event,
    idempotencyKey:
      event.idempotencyKey ??
      graphExecutionEventIdempotencyKey(
        state.runtime.eventScopeId ?? state.graph.name,
        seq,
        type,
      ),
  });
}

function graphExecutionEventIdempotencyKey(
  eventScopeId: string,
  seq: number,
  type: string,
): string {
  return `${eventScopeId}:agent:${seq}:${type}`;
}

function createGraphExecutionEventScopeId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `graph-agent:${random}`;
}

function throwUnsupportedGraphCommand(
  command: ResolvedExecutionCommand,
  phase: string,
): never {
  throw new Error(
    `GraphExecutor does not support execution command ${command.type} in ${phase} yet.`,
  );
}

function throwUnsupportedGraphCommandForState<TVars extends Vars>(
  state: GraphExecutionState<TVars>,
  command: ResolvedExecutionCommand,
  phase: string,
): never {
  if (state.unsupportedCommandLabel) {
    throw new Error(
      `${state.unsupportedCommandLabel} does not support execution command ${command.type} yet.`,
    );
  }
  throwUnsupportedGraphCommand(command, phase);
}

function assertGraphPhaseCommandSupported(
  command: ResolvedExecutionCommand,
  phase: string,
): void {
  if (command.type === 'none') {
    return;
  }
  throwUnsupportedGraphCommand(command, phase);
}

async function executeGraphNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  throwIfGraphAborted(state);
  if (state.skipNode?.(node, nodePath, state.session)) {
    return;
  }
  switch (node.type) {
    case 'system':
      await executeSystemNode(node, nodePath, state);
      return;
    case 'user':
      await executeUserNode(node, nodePath, state);
      return;
    case 'assistant':
      await executeAssistantNode(node, nodePath, state);
      return;
    case 'inbox':
      consumeInbox(state);
      return;
    case 'goal':
      await executeGoalNode(node, nodePath, state);
      return;
    case 'scope':
      await executeScopeNode(node, nodePath, state);
      return;
    case 'loop':
      await executeLoopNode(node, nodePath, state);
      return;
    case 'conditional':
      await executeConditionalNode(node, nodePath, state);
      return;
    case 'tools':
      await executeToolsNode(node, nodePath, state);
      return;
    case 'awaitInput':
      {
        const consumedKind = consumeInbox(state);
        if (state.activeGoal && consumedKind === 'user') {
          state.activeGoal.interacted = true;
        }
        if (consumedKind && nodePath === state.resumeFromNode) {
          state.resumeFromNode = undefined;
        }
        if (!consumedKind && graphNodeData(node).required !== false) {
          throw new GraphExecutionSuspended(nodePath, undefined, state.session);
        }
      }
      return;
    case 'structured':
      await executeStructuredNode(node, nodePath, state);
      return;
    case 'codexTurn':
      await executeCodexTurnNode(node, nodePath, state);
      return;
    case 'claudeTurn':
      await executeClaudeTurnNode(node, nodePath, state);
      return;
    case 'parallel':
      await executeParallelNode(node, nodePath, state);
      return;
    case 'transform':
      await executeTransformNode(node, nodePath, state);
      return;
  }
}

async function executeChildren<TVars extends Vars>(
  nodes: readonly AgentGraphNode[],
  parentPath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  for (const child of nodes) {
    const halted = await executeGraphNodeWithLegacyLifecycle(
      child,
      `${parentPath}/${child.id}`,
      state,
    );
    if (halted) break;
  }
}

/**
 * Execute a single graph node, firing legacy beforeTemplate/afterTemplate
 * lifecycle hooks when the node carries legacyTemplateLifecycle metadata.
 *
 * Returns true if execution should halt (sibling iteration should stop).
 */
async function executeGraphNodeWithLegacyLifecycle<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<boolean> {
  const data = graphNodeData(node);
  const lifecycle = isRecord(data.legacyTemplateLifecycle)
    ? (data.legacyTemplateLifecycle as {
        templateIndex: number;
        templateName: string;
      })
    : null;

  if (lifecycle) {
    const before = await runRuntimeExecutionPhase(state.runtime, {
      phase: 'beforeTemplate',
      session: state.session,
      request: lifecycle,
    });
    state.session = before.session;
    if (before.command.type === 'halt') {
      return true;
    }
  }

  await executeGraphNode(node, nodePath, state);

  if (lifecycle) {
    const after = await runRuntimeExecutionPhase(state.runtime, {
      phase: 'afterTemplate',
      session: state.session,
      request: lifecycle,
    });
    state.session = after.session;
    if (after.command.type === 'halt') {
      return true;
    }
  }

  return false;
}

async function executeLoopNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const data = graphNodeData(node);
  if (data.kind === 'goalAttempts') {
    await executeGoalAttemptsNode(node, nodePath, state);
    return;
  }
  // Legacy-compiled loops may carry no condition (Loop created without loopIf):
  // treat them as a one-shot sequence and warn, matching Composite.execute().
  if (data.legacyNoCondition === true) {
    console.warn(`Loop ${nodePath} executed without a loop condition.`);
    await executeChildren(node.children ?? [], nodePath, state);
    return;
  }
  const shouldContinue = () =>
    resolveGraphCondition(data.condition, nodePath, state);

  let iterations = 0;
  const maxIterations =
    positiveInteger(data.maxIterations) ?? state.maxLoopIterations;
  // Legacy-compiled loops warn on max-iterations instead of throwing, matching
  // the Composite.execute() behaviour (which never threw on the limit).
  const warnOnMax = data.legacyWarnOnMaxIterations === true;
  let resumeIterationPending =
    state.resumeFromNode !== undefined &&
    isGraphDescendantPath(state.resumeFromNode, nodePath);
  while (shouldContinue() || resumeIterationPending) {
    if (iterations++ >= maxIterations) {
      if (warnOnMax) {
        console.warn(
          `Loop ${nodePath} reached maximum iterations (${maxIterations}). Exiting.`,
        );
        break;
      }
      throw new Error(`Graph loop ${nodePath} exceeded max iterations.`);
    }
    resumeIterationPending = false;
    await executeChildren(node.children ?? [], nodePath, state);
  }
}

async function executeConditionalNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const data = graphNodeData(node);
  const branchId = resolveGraphCondition(data.condition, nodePath, state)
    ? 'then'
    : 'else';
  const branchNodeIds = getConditionalBranchNodeIds(data.branches, branchId);
  if (branchNodeIds.length === 0) {
    return;
  }
  const branchNodeIdSet = new Set(branchNodeIds);
  const branchChildren = (node.children ?? []).filter((child) =>
    branchNodeIdSet.has(child.id),
  );
  await executeChildren(branchChildren, nodePath, state);
}

async function executeGoalNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const data = graphNodeData(node);
  const goal = stringValue(data.goal);
  if (!goal) {
    throw new Error(`Graph node ${nodePath} requires a goal.`);
  }
  const previousGoal = state.activeGoal;
  state.activeGoal = {
    goal,
    nodePath,
    attempt: 0,
    maxAttempts: positiveInteger(data.maxAttempts) ?? state.maxLoopIterations,
    onUnsatisfied: goalOnUnsatisfied(data.onUnsatisfied),
    interaction: goalInteraction(data.interaction),
    interacted: false,
    satisfied: false,
    stopped: false,
  };
  try {
    await executeChildren(node.children ?? [], nodePath, state);
  } finally {
    state.activeGoal = previousGoal;
  }
}

async function executeScopeNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const data = graphNodeData(node);
  if (!hasSessionPolicy(data)) {
    await executeChildren(node.children ?? [], nodePath, state);
    return;
  }
  const parentSession = state.session;
  const init = data.init;
  const subroutineInitial =
    typeof init === 'function'
      ? await init(parentSession)
      : defaultSubroutineInitialSession(parentSession, data);
  if (!(subroutineInitial instanceof Session)) {
    throw new Error(`Graph node ${nodePath} returned an invalid init session.`);
  }

  const subState: GraphExecutionState<TVars> = {
    ...state,
    session: subroutineInitial as Session<TVars>,
  };
  try {
    await executeChildren(node.children ?? [], nodePath, subState);
    state.cursor = subState.cursor;
    state.session = adoptSessionResult(
      parentSession,
      await squashSubroutineSession(
        nodePath,
        data,
        parentSession,
        subroutineInitial as Session<TVars>,
        subState.session,
      ),
    );
  } catch (error) {
    state.cursor = subState.cursor;
    if (error instanceof GraphExecutionSuspended) {
      const suspendedSession = await squashSubroutineSession(
        nodePath,
        data,
        parentSession,
        subroutineInitial as Session<TVars>,
        subState.session,
      );
      state.session = suspendedSession;
      throw new GraphExecutionSuspended(
        error.nodePath,
        error.message,
        suspendedSession,
      );
    }
    throw error;
  }
}

async function executeGoalAttemptsNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const goal = state.activeGoal;
  if (!goal) {
    throw new Error(`Graph node ${nodePath} requires an active goal.`);
  }

  while (!goal.satisfied && !goal.stopped) {
    const countsAsAttempt = goal.interaction !== 'required' || goal.interacted;
    if (countsAsAttempt) {
      if (goal.attempt >= goal.maxAttempts) {
        handleUnsatisfiedGoal(goal, nodePath, 'exceeded max attempts');
        return;
      }
      goal.attempt += 1;
    }
    for (const child of node.children ?? []) {
      await executeGraphNode(child, `${nodePath}/${child.id}`, state);
      if (goal.satisfied || goal.stopped) {
        break;
      }
    }
  }
}

async function executeUserNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const data = graphNodeData(node);
  const input = data.input ?? data.content;
  if (input === undefined) {
    consumeInbox(state);
    return;
  }
  const content = await resolveGraphContent(
    input,
    nodePath,
    state.session,
    state.runtime,
  );
  state.session = state.session.addMessage(
    Message.user(typeof content === 'string' ? content : content.content),
  );
}

async function executeSystemNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const data = graphNodeData(node);
  const input = data.input ?? data.content;
  if (input === undefined) {
    return;
  }
  const content = await resolveGraphContent(
    input,
    nodePath,
    state.session,
    state.runtime,
  );
  if (typeof content !== 'string') {
    throw new Error(`Graph node ${nodePath} expected system string content.`);
  }
  state.session = state.session.addMessage(Message.system(content));
}

async function executeAssistantNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const data = graphNodeData(node);
  const input = data.input;
  if (input === undefined) {
    throw new Error(
      `Graph node ${nodePath} requires an assistant source or handler.`,
    );
  }
  const options = graphAssistantExecutionOptions(data, input);
  let validSession = state.session;
  let attempts = 0;
  let lastError: Error | undefined;
  let lastOutput: ModelOutput | undefined;

  while (attempts < options.maxAttempts) {
    attempts++;
    try {
      const modelCall = await executeRuntimeModelCall<
        TVars,
        string | ModelOutput
      >(
        state.runtime,
        validSession,
        (modelSession) =>
          resolveGraphAssistantInput(input, nodePath, modelSession, state),
        `Graph node ${nodePath} model execution`,
      );
      validSession = modelCall.session;
      const output = normalizeAssistantOutput(modelCall.result, nodePath);
      lastOutput = output;

      if (options.validator) {
        const validationResult = await options.validator.validate(
          output.content,
          validSession,
        );
        if (!validationResult.isValid) {
          throw new Error(
            options.isStaticContent
              ? 'Assistant content validation failed'
              : 'Assistant response validation failed',
          );
        }
      }

      state.session = addAssistantOutputMessages(validSession, output);
      return;
    } catch (error) {
      lastError = error as Error;
      if (attempts < options.maxAttempts) {
        console.warn(
          `Attempt ${attempts} failed: ${lastError.message}. Retrying...`,
        );
        continue;
      }
      if (options.raiseError) {
        return Promise.reject(lastError);
      }
      console.warn(
        `Validation failed after ${attempts} attempts. raiseError is false, returning last output.`,
      );
      break;
    }
  }

  if (!options.raiseError && lastError && lastOutput) {
    state.session = validSession.addMessage(
      assistantMessageFromOutput(lastOutput),
    );
    return;
  }

  throw new Error(
    `Graph node ${nodePath} assistant execution finished in an unexpected state.`,
  );
}

async function executeTransformNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const data = graphNodeData(node);
  if (data.kind === 'goalSatisfaction') {
    executeGoalSatisfactionNode(data, nodePath, state);
    return;
  }
  const handler = data.handler;
  if (typeof handler === 'function') {
    if (isExecutionEffectDeclaration(data.effect)) {
      await executeEffectTransformNode(
        node,
        nodePath,
        state,
        handler as (...args: unknown[]) => unknown,
        data.effect,
      );
      return;
    }
    const result = handler(state.session);
    if (isThenable(result)) {
      throw new Error(
        `transform '${node.id}' returned a Promise; declare { effect } to use an async transform`,
      );
    }
    adoptTransformResult(nodePath, state, result);
    return;
  }
  await executeTemplateNode(node, nodePath, state);
}

async function executeEffectTransformNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
  handler: (...args: unknown[]) => unknown,
  effect: ExecutionEffectDeclaration,
): Promise<void> {
  const idempotencyKey = resolveTransformIdempotencyKey(effect, state.session);
  const context: GraphTransformDurableBoundaryContext<TVars> = {
    kind: 'transform',
    nodePath,
    session: state.session,
    effect,
    idempotencyKey,
  };
  const executeTransform = async (durable?: ExecutionDurableBoundary) => {
    const boundary = durable ?? directExecutionBoundary;
    const callHandler = async () => {
      return handler(state.session, {
        context: state.context,
        signal: state.signal,
        once: boundary.once.bind(boundary),
        idempotencyKey,
      });
    };
    const result =
      idempotencyKey !== undefined
        ? await boundary.once(node.id, idempotencyKey, callHandler)
        : await callHandler();
    adoptTransformResult(nodePath, state, result);
  };

  if (state.durableToolExecution) {
    await state.durableToolExecution(context, executeTransform);
    return;
  }
  await executeTransform();
}

function adoptTransformResult<TVars extends Vars>(
  nodePath: string,
  state: GraphExecutionState<TVars>,
  result: unknown,
): void {
  if (!(result instanceof Session)) {
    throw new Error(
      `Graph node ${nodePath} returned an invalid transform result.`,
    );
  }
  state.session = adoptSessionResult(state.session, result as Session<TVars>);
}

async function executeStructuredNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const data = graphNodeData(node);
  const template = data.template;
  if (!(template instanceof Structured)) {
    throw new Error(`Graph node ${nodePath} requires a Structured template.`);
  }
  const producedSession = await template.executeSource(
    state.session,
    state.runtime,
  );
  const fold = data.fold;
  if (fold === undefined) {
    state.session = producedSession;
    return;
  }
  if (typeof fold !== 'function') {
    throw new Error(
      `Graph node ${nodePath} structured fold must be a callback.`,
    );
  }
  const message = producedSession.getLastMessage();
  const structuredContent = message?.structuredContent;
  if (structuredContent === undefined) {
    throw new Error(
      `Graph node ${nodePath} structured fold requires structuredContent.`,
    );
  }
  const obj = template.parseStructuredContent(structuredContent);
  const result = fold(obj, producedSession);
  if (isThenable(result)) {
    throw new Error(
      `Graph node ${nodePath} structured fold returned a Promise; structured folds must be synchronous.`,
    );
  }
  if (!(result instanceof Session)) {
    throw new Error(
      `Graph node ${nodePath} returned an invalid structured fold result.`,
    );
  }
  state.session = adoptSessionResult(producedSession, result as Session<TVars>);
}

async function executeParallelNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const template = graphNodeData(node).template;
  if (!(template instanceof Parallel)) {
    throw new Error(`Graph node ${nodePath} requires a Parallel template.`);
  }
  const sources = template.getSources();
  if (sources.length === 0) {
    return;
  }

  const results: Session<TVars>[] = [];
  // Runtime middleware state is ordered and mutable; keep runtime-backed source
  // calls sequential so phase/version updates cannot race.
  for (const config of sources) {
    for (let i = 0; i < config.repetitions; i++) {
      results.push(
        await template.executeSource(
          config.source,
          state.session,
          state.runtime,
        ),
      );
    }
  }
  state.session = adoptSessionResult(
    state.session,
    template.aggregateResults(results, state.session),
  );
}

async function executeCodexTurnNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const template = graphNodeData(node).template;
  if (!(template instanceof CodexTurn)) {
    throw new Error(`Graph node ${nodePath} requires a CodexTurn template.`);
  }
  state.session = await template.executeTurn(state.session, state.runtime, {
    nodePath,
  });
}

async function executeClaudeTurnNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const template = graphNodeData(node).template;
  if (!(template instanceof ClaudeTurn)) {
    throw new Error(`Graph node ${nodePath} requires a ClaudeTurn template.`);
  }
  state.session = await template.executeTurn(state.session, state.runtime, {
    nodePath,
  });
}

async function executeTemplateNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const template = graphNodeData(node).template;
  if (!isTemplate<TVars>(template)) {
    throw new Error(`Graph node ${nodePath} requires a template.`);
  }
  state.session = await template.execute(state.session, state.runtime);
}

async function resolveGraphAssistantInput<TVars extends Vars>(
  input: unknown,
  nodePath: string,
  session: Session<TVars>,
  state: GraphExecutionState<TVars>,
): Promise<string | ModelOutput> {
  if (typeof input === 'function') {
    const result = await input(session, {
      context: state.context,
      signal: state.signal,
    });
    if (typeof result === 'string' || isModelOutput(result)) {
      return result;
    }
    if (isAssistantMessage(result)) {
      return {
        content: result.content,
        toolCalls: result.toolCalls,
        metadata: result.attrs,
        structuredOutput: result.structuredContent,
      };
    }
    throw new Error(
      `Graph node ${nodePath} returned an invalid assistant result.`,
    );
  }
  return resolveGraphContent(input, nodePath, session, state.runtime);
}

function executeGoalSatisfactionNode<TVars extends Vars>(
  data: GraphNodeData,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): void {
  const goal = state.activeGoal;
  if (!goal) {
    throw new Error(`Graph node ${nodePath} requires an active goal.`);
  }
  const handler = data.isSatisfied;
  const canSatisfy = goal.interaction !== 'required' || goal.interacted;
  let satisfied = canSatisfy;
  if (satisfied && typeof handler === 'function') {
    const result = handler({
      session: state.session,
      goal: goal.goal,
      attempt: goal.attempt,
      context: state.context,
      signal: state.signal,
    });
    if (isThenable(result)) {
      throw new Error(
        `Graph goal ${goal.nodePath} isSatisfied returned a Promise; goal satisfaction handlers must be synchronous.`,
      );
    }
    satisfied = Boolean(result);
  }

  if (satisfied) {
    goal.satisfied = true;
    return;
  }
  if (goal.onUnsatisfied === 'continue') {
    goal.stopped = true;
    return;
  }
  if (goal.onUnsatisfied === 'halt') {
    throw new Error(`Graph goal ${goal.nodePath} was not satisfied.`);
  }
}

function defaultSubroutineInitialSession<TVars extends Vars>(
  _parentSession: Session<TVars>,
  _data: GraphNodeData,
): Session<TVars> {
  return Session.create<TVars>();
}

function hasSessionPolicy(data: GraphNodeData): boolean {
  return (
    data.sessionPolicy === true ||
    data.init !== undefined ||
    data.squash !== undefined
  );
}

async function squashSubroutineSession<TVars extends Vars>(
  nodePath: string,
  data: GraphNodeData,
  parentSession: Session<TVars>,
  initialSession: Session<TVars>,
  subroutineSession: Session<TVars>,
): Promise<Session<TVars>> {
  const squash = data.squash;
  if (typeof squash === 'function') {
    const result = await squash(parentSession, subroutineSession);
    if (result instanceof Session) {
      return result as Session<TVars>;
    }
    throw new Error(
      `Graph node ${nodePath} returned an invalid squash session.`,
    );
  }

  const messages = [
    ...parentSession.messages,
    ...subroutineSession.messages.slice(initialSession.messages.length),
  ];
  let merged = Session.create<TVars>({
    vars: parentSession.getVarsObject() as TVars,
  });
  for (const message of messages) {
    merged = merged.addMessage(message);
  }
  return merged;
}

async function executeToolsNode<TVars extends Vars>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): Promise<void> {
  const data = graphNodeData(node);
  const lastMessage = state.session.getLastMessage();
  const toolCalls =
    lastMessage?.type === 'assistant' ? (lastMessage.toolCalls ?? []) : [];
  if (toolCalls.length === 0) {
    return;
  }

  const tools = resolveGraphTools(data.tools, state.graph.tools, nodePath);
  for (const call of toolCalls) {
    const beforeTool = await runRuntimeExecutionPhase(state.runtime, {
      phase: 'beforeTool',
      session: state.session,
      request: call,
    });
    assertGraphPhaseCommandSupported(beforeTool.command, 'beforeTool');
    state.session = beforeTool.session;
    const nextCall = (beforeTool.request as typeof call | undefined) ?? call;

    const tool = tools[nextCall.name];
    if (!tool) {
      throw new Error(
        `Graph node ${nodePath} cannot resolve tool ${nextCall.name}.`,
      );
    }
    const toolEffect = tool.effect ?? tool.metadata?.effect;
    if (
      state.durableToolExecution &&
      !isExecutionEffectDeclaration(toolEffect)
    ) {
      throw new Error(
        `Checkpoint tool "${nextCall.name}" at ${nodePath} is missing an ExecutionEffectDeclaration. Declare effect: { repeatable: true } or effect: { idempotencyKey: 'stable-key' } on Tool.create(...).`,
      );
    }
    const wrappedTool = await runRuntimeMiddlewareWrapper<
      TVars,
      typeof nextCall,
      PromptTrailMessage
    >(state.runtime, {
      phase: 'wrapToolCall',
      session: state.session,
      request: nextCall,
      call: async ({ session, request }) => {
        const context = {
          kind: 'tool' as const,
          nodePath,
          toolCall: request,
          session,
          tool,
        };
        const executeTool = (durable?: ExecutionDurableBoundary) =>
          executePromptTrailTool(tool, request.arguments, {
            session,
            context: state.context,
            raw: request,
            capability: request.name,
            effect: isExecutionEffectDeclaration(toolEffect)
              ? toolEffect
              : undefined,
            durable: durable ?? state.durableToolBoundary?.(context),
          });
        const result = state.durableToolExecution
          ? await state.durableToolExecution(context, executeTool)
          : await executeTool();
        return normalizeToolResultMessage(result, request);
      },
    });
    assertGraphPhaseCommandSupported(wrappedTool.command, 'wrapToolCall');
    const afterTool = await runRuntimeExecutionPhase(state.runtime, {
      phase: 'afterTool',
      session: wrappedTool.session,
      request: wrappedTool.request,
      result: wrappedTool.result,
    });
    assertGraphPhaseCommandSupported(afterTool.command, 'afterTool');
    const result =
      (afterTool.result as PromptTrailMessage | undefined) ??
      wrappedTool.result;
    state.session = afterTool.session;
    state.session = state.session.addMessage(result);
  }
}

function resolveGraphTools(
  requestedTools: unknown,
  graphTools: Record<string, PromptTrailTool<unknown, unknown>>,
  nodePath: string,
): Record<string, PromptTrailTool<unknown, unknown>> {
  if (requestedTools === undefined) {
    return graphTools;
  }
  if (Array.isArray(requestedTools)) {
    const tools: Record<string, PromptTrailTool<unknown, unknown>> = {};
    for (const name of requestedTools) {
      if (typeof name !== 'string') {
        throw new Error(`Graph node ${nodePath} has invalid tools list.`);
      }
      const tool = graphTools[name];
      if (!tool) {
        throw new Error(`Graph node ${nodePath} allows unknown tool ${name}.`);
      }
      tools[name] = tool;
    }
    return tools;
  }
  if (isPromptTrailToolRecord(requestedTools)) {
    return requestedTools;
  }
  throw new Error(`Graph node ${nodePath} has unsupported tools config.`);
}

function normalizeToolResultMessage(
  result: CallToolResult,
  call: { id: string; name: string },
): PromptTrailMessage {
  return {
    type: 'tool_result' as const,
    content: stringifyCallToolResult(result),
    structuredContent: result.structuredContent,
    toolCallId: call.id,
    attrs: {
      toolName: call.name,
      isError: result.isError,
    },
  };
}

function stringifyCallToolResult(result: CallToolResult): string {
  if (result.content.length === 1 && result.content[0].type === 'text') {
    return result.content[0].text;
  }
  return JSON.stringify(
    result.content.map((part) =>
      part.type === 'text' ? { type: 'text', text: part.text } : part.json,
    ),
  );
}

function isPromptTrailToolRecord(
  value: unknown,
): value is Record<string, PromptTrailTool<unknown, unknown>> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every(isPromptTrailTool);
}

function consumeInbox<TVars extends Vars>(
  state: GraphExecutionState<TVars>,
): ConsumedInboxKind {
  const inbound = state.inbox[state.cursor];
  if (!inbound) {
    return false;
  }
  state.cursor += 1;
  state.onInboxConsumed?.(state.cursor);
  const kind = inbound.kind ?? 'user';
  if (inbound.kind === 'system') {
    state.session = state.session.addMessage(
      Message.system(inbound.content, inbound.attrs),
    );
    return kind;
  }
  if (inbound.kind === 'control') {
    return kind;
  }
  state.session = state.session.addMessage(
    Message.user(inbound.content, inbound.attrs),
  );
  return kind;
}

function materializeRemainingInbox<TVars extends Vars>(
  state: GraphExecutionState<TVars>,
): void {
  while (state.cursor < state.inbox.length) {
    consumeInbox(state);
  }
}

function graphHasInboundConsumer(nodes: readonly AgentGraphNode[]): boolean {
  return nodes.some(
    (node) =>
      isGraphInboundConsumerNode(node) ||
      graphHasInboundConsumer(node.children ?? []),
  );
}

function isGraphInboundConsumerNode(node: AgentGraphNode): boolean {
  if (node.type === 'inbox' || node.type === 'awaitInput') {
    return true;
  }
  return node.type === 'user' && !isStaticGraphUserNode(node);
}

function isStaticGraphUserNode(node: AgentGraphNode): boolean {
  return (
    typeof node.data === 'object' &&
    node.data !== null &&
    ('input' in node.data || 'content' in node.data)
  );
}

function resolveGraphCondition<TVars extends Vars>(
  condition: unknown,
  nodePath: string,
  state: GraphExecutionState<TVars>,
): boolean {
  if (typeof condition === 'boolean') {
    return condition;
  }
  if (typeof condition === 'function') {
    const result = condition(graphConditionContext(state));
    if (isThenable(result)) {
      throw new Error(
        `Graph node ${nodePath} condition returned a Promise; condition handlers must be synchronous.`,
      );
    }
    return Boolean(result);
  }
  throw new Error(`Graph node ${nodePath} requires a condition.`);
}

function graphConditionContext<TVars extends Vars>(
  state: GraphExecutionState<TVars>,
): {
  session: Session<TVars>;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
} {
  return Object.assign(Object.create(state.session), {
    session: state.session,
    context: state.context,
    signal: state.signal,
  });
}

const directExecutionBoundary: ExecutionDurableBoundary = {
  async once(_name, _dep, fn) {
    return fn();
  },
};

function resolveTransformIdempotencyKey(
  effect: ExecutionEffectDeclaration,
  session: Session,
): string | undefined {
  if (!('idempotencyKey' in effect)) {
    return undefined;
  }
  return typeof effect.idempotencyKey === 'function'
    ? effect.idempotencyKey(session)
    : effect.idempotencyKey;
}

function isExecutionEffectDeclaration(
  value: unknown,
): value is ExecutionEffectDeclaration {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return 'idempotencyKey' in value || 'repeatable' in value;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function isGraphDescendantPath(path: string, ancestorPath: string): boolean {
  return path.startsWith(`${ancestorPath}/`);
}

async function resolveGraphContent<TVars extends Vars>(
  input: unknown,
  nodePath: string,
  session: Session<TVars>,
  runtime: ExecutionRuntimeState<TVars>,
): Promise<string | ModelOutput> {
  if (input instanceof Source) {
    return input.getContent(session, runtime);
  }
  if (isGraphContentSource(input)) {
    return input.getContent(session, runtime);
  }
  if (typeof input === 'string') {
    return input;
  }
  if (isModelOutput(input)) {
    return input;
  }
  throw new Error(`Graph node ${nodePath} has unsupported content input.`);
}

function isGraphContentSource(input: unknown): input is {
  getContent: (
    session: Session<any>,
    runtime?: ExecutionRuntimeState<any>,
  ) => Promise<string | ModelOutput> | string | ModelOutput;
} {
  return (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { getContent?: unknown }).getContent === 'function'
  );
}

interface GraphAssistantExecutionOptions {
  validator?: IValidator;
  maxAttempts: number;
  raiseError: boolean;
  isStaticContent: boolean;
}

function graphAssistantExecutionOptions(
  data: GraphNodeData,
  input: unknown,
): GraphAssistantExecutionOptions {
  return {
    validator: isValidator(data.validator) ? data.validator : undefined,
    maxAttempts: positiveInteger(data.maxAttempts) ?? 1,
    raiseError: data.raiseError !== false,
    isStaticContent:
      typeof data.isStaticContent === 'boolean'
        ? data.isStaticContent
        : typeof input === 'string',
  };
}

function isValidator(value: unknown): value is IValidator {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { validate?: unknown }).validate === 'function'
  );
}

function normalizeAssistantOutput(
  result: unknown,
  nodePath: string,
): ModelOutput {
  if (typeof result === 'string') {
    return { content: result };
  }
  if (isAssistantMessage(result)) {
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      metadata: result.attrs,
      structuredOutput: result.structuredContent,
    };
  }
  if (isModelOutput(result)) {
    return result;
  }
  throw new Error(
    `Graph node ${nodePath} returned an invalid assistant result.`,
  );
}

function addAssistantOutputMessages<TVars extends Vars>(
  session: Session<TVars>,
  output: ModelOutput,
): Session<TVars> {
  let updatedSession = session.addMessage(assistantMessageFromOutput(output));
  for (const toolResult of output.toolResults ?? []) {
    updatedSession = updatedSession.addMessage({
      type: 'tool_result',
      content: JSON.stringify(toolResult.result),
      toolCallId: toolResult.toolCallId,
    });
  }
  return updatedSession;
}

function assistantMessageFromOutput(output: ModelOutput): AssistantMessage {
  return {
    type: 'assistant',
    content: output.content,
    toolCalls: output.toolCalls,
    attrs: output.metadata ?? {},
    structuredContent: output.structuredOutput,
  };
}

function normalizeGraphInbox(
  input: string | GraphInboundInput | readonly GraphInboundInput[] | undefined,
): GraphInboundInput[] {
  if (input === undefined) {
    return [];
  }
  if (typeof input === 'string') {
    return [{ kind: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return [...(input as readonly GraphInboundInput[])];
  }
  return [input as GraphInboundInput];
}

function graphNodeData(node: AgentGraphNode): GraphNodeData {
  return isRecord(node.data) ? node.data : {};
}

function getConditionalBranchNodeIds(
  branches: unknown,
  branchId: 'then' | 'else',
): string[] {
  if (!isRecord(branches)) {
    return [];
  }
  const nodeIds = branches[branchId];
  if (!Array.isArray(nodeIds)) {
    return [];
  }
  return nodeIds.filter(
    (nodeId): nodeId is string => typeof nodeId === 'string',
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function goalOnUnsatisfied(
  value: unknown,
): ActiveGoalExecution['onUnsatisfied'] {
  return value === 'continue' || value === 'halt' || value === 'retry'
    ? value
    : 'retry';
}

function goalInteraction(value: unknown): ActiveGoalExecution['interaction'] {
  return value === 'optional' || value === 'required' || value === 'none'
    ? value
    : 'none';
}

function handleUnsatisfiedGoal(
  goal: ActiveGoalExecution,
  nodePath: string,
  reason: string,
): void {
  if (goal.onUnsatisfied === 'continue') {
    goal.stopped = true;
    return;
  }
  throw new Error(`Graph goal ${goal.nodePath} ${reason} at ${nodePath}.`);
}

function throwIfGraphAborted<TVars extends Vars>(
  state: GraphExecutionState<TVars>,
): void {
  if (!state.signal?.aborted) {
    return;
  }
  const reason = state.signal.reason;
  throw reason instanceof Error
    ? reason
    : new Error('Graph execution aborted.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isModelOutput(value: unknown): value is ModelOutput {
  return isRecord(value) && typeof value.content === 'string';
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    isRecord(value) &&
    value.type === 'assistant' &&
    typeof value.content === 'string'
  );
}

function isTemplate<TVars extends Vars>(
  value: unknown,
): value is Template<TVars> {
  return isRecord(value) && typeof value.execute === 'function';
}
