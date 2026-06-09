import type { CallToolResult } from './capabilities';
import {
  ObserverBus,
  type ExecutionEvent,
  type ObserverDeliveryBindingOptions,
  type ObserverLike,
  type ResolvedExecutionCommand,
} from './execution';
import type { AgentGraph, AgentGraphNode } from './graph';
import {
  createExecutionRuntimeState,
  runRuntimeExecutionPhase,
  runRuntimeMiddlewareWrapper,
  type ExecutionRuntimeState,
} from './interceptors';
import {
  Message,
  type AssistantMessage,
  type Message as PromptTrailMessage,
} from './message';
import { Session, type Attrs, type Vars } from './session';
import { type ModelOutput, Source } from './source';
import type { Template } from './templates/base';
import { executeRuntimeModelCall } from './templates/primitives/model_runtime';
import {
  executePromptTrailTool,
  isPromptTrailTool,
  type PromptTrailTool,
} from './tool';

export interface GraphExecutionOptions<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  session?: Session<TVars, TAttrs>;
  input?:
    | string
    | GraphInboundInput<TAttrs>
    | readonly GraphInboundInput<TAttrs>[];
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  maxLoopIterations?: number;
  observers?: readonly ObserverLike[];
  observerDeliveryBindings?: ObserverDeliveryBindingOptions;
  strictObservers?: boolean;
  eventScopeId?: string;
  nextEventSeq?: () => number;
  skipNode?: (
    node: AgentGraphNode,
    nodePath: string,
    session: Session<TVars, TAttrs>,
  ) => boolean;
  resumeFromNode?: string;
}

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

export interface GraphInboundInput<TAttrs extends Attrs = Attrs> {
  kind?: 'user' | 'system' | 'control';
  content: string;
  attrs?: TAttrs;
}

interface GraphExecutionState<TVars extends Vars, TAttrs extends Attrs> {
  graph: AgentGraph;
  session: Session<TVars, TAttrs>;
  inbox: GraphInboundInput<TAttrs>[];
  cursor: number;
  maxLoopIterations: number;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  runtime: ExecutionRuntimeState<TVars, TAttrs>;
  skipNode?: GraphExecutionOptions<TVars, TAttrs>['skipNode'];
  resumeFromNode?: string;
  activeGoal?: ActiveGoalExecution;
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

export async function executeAgentGraph<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
>(
  graph: AgentGraph,
  options: GraphExecutionOptions<TVars, TAttrs> = {},
): Promise<Session<TVars, TAttrs>> {
  const observerBus = new ObserverBus(
    [...graph.observers, ...(options.observers ?? [])],
    {
      strictObservers: options.strictObservers,
      ...options.observerDeliveryBindings,
    },
  );
  const eventScopeId =
    options.eventScopeId ?? createGraphExecutionEventScopeId();
  let eventSeq = 0;
  const nextEventSeq = options.nextEventSeq ?? (() => eventSeq++);
  const emitEvent = (event: ExecutionEvent) =>
    observerBus.emit(event, {
      ...options.context,
      signal: options.signal,
    });
  const state: GraphExecutionState<TVars, TAttrs> = {
    graph,
    session: options.session ?? Session.create<TVars, TAttrs>(),
    inbox: normalizeGraphInbox<TAttrs>(options.input),
    cursor: 0,
    maxLoopIterations: options.maxLoopIterations ?? 10,
    context: options.context,
    signal: options.signal,
    runtime: createExecutionRuntimeState<TVars, TAttrs>({
      middleware: graph.middleware,
      hooks: graph.hooks,
      context: options.context,
      signal: options.signal,
      emitEvent,
      eventScopeId,
      nextEventSeq,
    }),
    skipNode: options.skipNode,
    resumeFromNode: options.resumeFromNode,
  };

  await emitGraphRunEvent('run.started', state, {
    sessionVersion: state.session.messages.length,
  });
  try {
    const before = await runRuntimeExecutionPhase(state.runtime, {
      phase: 'beforeAgent',
      session: state.session,
    });
    state.session = before.session;
    if (before.command.type !== 'none') {
      if (before.command.type === 'halt') {
        await emitGraphRunEvent('run.completed', state, {
          sessionVersion: state.session.messages.length,
        });
        return state.session;
      }
      throwUnsupportedGraphCommand(before.command, 'beforeAgent');
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
      await executeGraphNode(node, `${graph.name}/${node.id}`, state);
    }
    if (materializeInboxWithoutConsumer && !inboxMaterialized) {
      materializeRemainingInbox(state);
    }

    const after = await runRuntimeExecutionPhase(state.runtime, {
      phase: 'afterAgent',
      session: state.session,
    });
    state.session = after.session;
    if (after.command.type !== 'none') {
      if (after.command.type === 'halt') {
        await emitGraphRunEvent('run.completed', state, {
          sessionVersion: state.session.messages.length,
        });
        return state.session;
      }
      throwUnsupportedGraphCommand(after.command, 'afterAgent');
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
  }
}

async function emitGraphRunEvent<TVars extends Vars, TAttrs extends Attrs>(
  type: 'run.started' | 'run.completed' | 'run.suspended' | 'run.failed',
  state: GraphExecutionState<TVars, TAttrs>,
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
    replay: 'live',
    source: 'graph',
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

function assertGraphPhaseCommandSupported(
  command: ResolvedExecutionCommand,
  phase: string,
): void {
  if (command.type === 'none') {
    return;
  }
  throwUnsupportedGraphCommand(command, phase);
}

async function executeGraphNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  throwIfGraphAborted(state);
  if (state.skipNode?.(node, nodePath, state.session)) {
    return;
  }
  switch (node.type) {
    case 'system':
      addMessageFromNode(state, node, 'system');
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
    case 'turn':
      await executeChildren(node.children ?? [], nodePath, state);
      return;
    case 'goal':
      await executeGoalNode(node, nodePath, state);
      return;
    case 'subroutine':
      await executeSubroutineNode(node, nodePath, state);
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
        if (!consumedKind && graphNodeData(node).required !== false) {
          throw new GraphExecutionSuspended(nodePath, undefined, state.session);
        }
      }
      return;
    case 'patch':
      await executePatchNode(node, nodePath, state);
      return;
    case 'messages':
      await executeMessagesNode(node, nodePath, state);
      return;
    case 'structured':
    case 'codexTurn':
    case 'claudeTurn':
    case 'parallel':
    case 'transform':
      await executeTemplateNode(node, nodePath, state);
      return;
  }
}

async function executeChildren<TVars extends Vars, TAttrs extends Attrs>(
  nodes: readonly AgentGraphNode[],
  parentPath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  for (const child of nodes) {
    await executeGraphNode(child, `${parentPath}/${child.id}`, state);
  }
}

async function executeLoopNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  const data = graphNodeData(node);
  if (data.kind === 'goalAttempts') {
    await executeGoalAttemptsNode(node, nodePath, state);
    return;
  }
  const shouldContinue = () =>
    resolveGraphCondition(data.condition, nodePath, state);

  let iterations = 0;
  const maxIterations =
    positiveInteger(data.maxIterations) ?? state.maxLoopIterations;
  let resumeIterationPending =
    state.resumeFromNode !== undefined &&
    isGraphDescendantPath(state.resumeFromNode, nodePath);
  while (shouldContinue() || resumeIterationPending) {
    if (iterations++ >= maxIterations) {
      throw new Error(`Graph loop ${nodePath} exceeded max iterations.`);
    }
    resumeIterationPending = false;
    await executeChildren(node.children ?? [], nodePath, state);
  }
}

async function executeConditionalNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  const data = graphNodeData(node);
  const branchId = resolveGraphCondition(data.condition, nodePath, state)
    ? 'then'
    : 'else';
  const branch = (node.children ?? []).find((child) => child.id === branchId);
  if (!branch) {
    return;
  }
  await executeGraphNode(branch, `${nodePath}/${branch.id}`, state);
}

async function executeGoalNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
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

async function executeSubroutineNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  const data = graphNodeData(node);
  const parentSession = state.session;
  const initWith = data.initWith;
  const subroutineInitial =
    typeof initWith === 'function'
      ? await initWith(parentSession)
      : defaultSubroutineInitialSession(parentSession, data);
  if (!(subroutineInitial instanceof Session)) {
    throw new Error(`Graph node ${nodePath} returned an invalid init session.`);
  }

  const subState: GraphExecutionState<TVars, TAttrs> = {
    ...state,
    session: subroutineInitial as Session<TVars, TAttrs>,
  };
  try {
    await executeChildren(node.children ?? [], nodePath, subState);
    state.cursor = subState.cursor;
    state.session = await squashSubroutineSession(
      nodePath,
      data,
      parentSession,
      subroutineInitial as Session<TVars, TAttrs>,
      subState.session,
    );
  } catch (error) {
    state.cursor = subState.cursor;
    if (error instanceof GraphExecutionSuspended) {
      const suspendedSession = await squashSubroutineSession(
        nodePath,
        data,
        parentSession,
        subroutineInitial as Session<TVars, TAttrs>,
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

async function executeGoalAttemptsNode<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
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

async function executeUserNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
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

async function executeAssistantNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  const data = graphNodeData(node);
  const input = data.input;
  if (input === undefined) {
    throw new Error(
      `Graph node ${nodePath} requires an assistant source or handler.`,
    );
  }
  const modelCall = await executeRuntimeModelCall<
    TVars,
    TAttrs,
    string | ModelOutput
  >(
    state.runtime,
    state.session,
    (modelSession) =>
      resolveGraphAssistantInput(input, nodePath, modelSession, state),
    `Graph node ${nodePath} model execution`,
  );
  state.session = modelCall.session;
  const result = modelCall.result;
  state.session = state.session.addMessage(
    normalizeAssistantResult(result, nodePath),
  );
}

async function executePatchNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  const data = graphNodeData(node);
  if (data.kind === 'goalSatisfaction') {
    await executeGoalSatisfactionNode(data, nodePath, state);
    return;
  }
  const handler = data.handler;
  if (typeof handler !== 'function') {
    throw new Error(`Graph node ${nodePath} requires a patch handler.`);
  }
  const result = await handler(state.session, {
    context: state.context,
    signal: state.signal,
  });
  if (result instanceof Session) {
    state.session = result as Session<TVars, TAttrs>;
    return;
  }
  if (result !== undefined) {
    throw new Error(`Graph node ${nodePath} returned an invalid patch result.`);
  }
}

async function executeTemplateNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  const template = graphNodeData(node).template;
  if (!isTemplate<TVars, TAttrs>(template)) {
    throw new Error(`Graph node ${nodePath} requires a template.`);
  }
  state.session = await template.execute(state.session, state.runtime);
}

async function resolveGraphAssistantInput<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  input: unknown,
  nodePath: string,
  session: Session<TVars, TAttrs>,
  state: GraphExecutionState<TVars, TAttrs>,
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

async function executeGoalSatisfactionNode<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  data: GraphNodeData,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  const goal = state.activeGoal;
  if (!goal) {
    throw new Error(`Graph node ${nodePath} requires an active goal.`);
  }
  const handler = data.isSatisfied;
  const canSatisfy = goal.interaction !== 'required' || goal.interacted;
  const satisfied =
    canSatisfy &&
    (typeof handler === 'function'
      ? Boolean(
          await handler({
            session: state.session,
            goal: goal.goal,
            attempt: goal.attempt,
            context: state.context,
            signal: state.signal,
          }),
        )
      : true);

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

async function executeMessagesNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  const handler = graphNodeData(node).handler;
  if (typeof handler !== 'function') {
    throw new Error(`Graph node ${nodePath} requires a messages handler.`);
  }
  const result = await handler(state.session, {
    context: state.context,
    signal: state.signal,
  });
  const messages = Array.isArray(result) ? result : [result];
  for (const message of messages) {
    if (!isPromptTrailMessage(message)) {
      throw new Error(
        `Graph node ${nodePath} returned an invalid message result.`,
      );
    }
    state.session = state.session.addMessage(
      message as PromptTrailMessage<TAttrs>,
    );
  }
}

function defaultSubroutineInitialSession<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  parentSession: Session<TVars, TAttrs>,
  data: GraphNodeData,
): Session<TVars, TAttrs> {
  if (data.isolatedContext === true) {
    return Session.create<TVars, TAttrs>();
  }
  let initial = Session.create<TVars, TAttrs>({
    vars: parentSession.getVarsObject(),
  });
  for (const message of parentSession.messages) {
    initial = initial.addMessage(message);
  }
  return initial;
}

async function squashSubroutineSession<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  nodePath: string,
  data: GraphNodeData,
  parentSession: Session<TVars, TAttrs>,
  initialSession: Session<TVars, TAttrs>,
  subroutineSession: Session<TVars, TAttrs>,
): Promise<Session<TVars, TAttrs>> {
  const squashWith = data.squashWith;
  if (typeof squashWith === 'function') {
    const result = await squashWith(parentSession, subroutineSession);
    if (result instanceof Session) {
      return result as Session<TVars, TAttrs>;
    }
    throw new Error(
      `Graph node ${nodePath} returned an invalid squash session.`,
    );
  }

  const retainMessages = data.retainMessages !== false;
  const isolatedContext = data.isolatedContext === true;
  const messages = retainMessages
    ? [
        ...parentSession.messages,
        ...subroutineSession.messages.slice(initialSession.messages.length),
      ]
    : [...parentSession.messages];
  const vars = isolatedContext
    ? parentSession.getVarsObject()
    : {
        ...parentSession.getVarsObject(),
        ...subroutineSession.getVarsObject(),
      };
  let merged = Session.create<TVars, TAttrs>({ vars: vars as TVars });
  for (const message of messages) {
    merged = merged.addMessage(message);
  }
  return merged;
}

async function executeToolsNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
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
    const wrappedTool = await runRuntimeMiddlewareWrapper<
      TVars,
      TAttrs,
      typeof nextCall,
      PromptTrailMessage<TAttrs>
    >(state.runtime, {
      phase: 'wrapToolCall',
      session: state.session,
      request: nextCall,
      call: async ({ session, request }) => {
        const result = await executePromptTrailTool(tool, request.arguments, {
          session,
          context: state.context,
          raw: request,
          capability: request.name,
          activity: tool.activity,
        });
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
      (afterTool.result as PromptTrailMessage<TAttrs> | undefined) ??
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

function normalizeToolResultMessage<TAttrs extends Attrs>(
  result: CallToolResult,
  call: { id: string; name: string },
): PromptTrailMessage<TAttrs> {
  return {
    type: 'tool_result' as const,
    content: stringifyCallToolResult(result),
    structuredContent: result.structuredContent,
    attrs: {
      toolCallId: call.id,
      toolName: call.name,
      isError: result.isError,
    } as unknown as TAttrs,
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

function addMessageFromNode<TVars extends Vars, TAttrs extends Attrs>(
  state: GraphExecutionState<TVars, TAttrs>,
  node: AgentGraphNode,
  type: 'system',
): void {
  const data = graphNodeData(node);
  const content = stringValue(data.content);
  if (content === undefined) {
    return;
  }
  state.session = state.session.addMessage(Message.create(type, content));
}

function consumeInbox<TVars extends Vars, TAttrs extends Attrs>(
  state: GraphExecutionState<TVars, TAttrs>,
): ConsumedInboxKind {
  const inbound = state.inbox[state.cursor];
  if (!inbound) {
    return false;
  }
  state.cursor += 1;
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

function materializeRemainingInbox<TVars extends Vars, TAttrs extends Attrs>(
  state: GraphExecutionState<TVars, TAttrs>,
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

function resolveGraphCondition<TVars extends Vars, TAttrs extends Attrs>(
  condition: unknown,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): boolean {
  if (typeof condition === 'boolean') {
    return condition;
  }
  if (typeof condition === 'function') {
    return Boolean(
      condition({
        session: state.session,
        context: state.context,
        signal: state.signal,
      }),
    );
  }
  throw new Error(`Graph node ${nodePath} requires a condition.`);
}

function isGraphDescendantPath(path: string, ancestorPath: string): boolean {
  return path.startsWith(`${ancestorPath}/`);
}

async function resolveGraphContent<TVars extends Vars, TAttrs extends Attrs>(
  input: unknown,
  nodePath: string,
  session: Session<TVars, TAttrs>,
  runtime: ExecutionRuntimeState<TVars, TAttrs>,
): Promise<string | ModelOutput> {
  if (input instanceof Source) {
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

function normalizeAssistantResult<TAttrs extends Attrs>(
  result: unknown,
  nodePath: string,
): AssistantMessage<TAttrs> {
  if (typeof result === 'string') {
    return Message.assistant(result) as AssistantMessage<TAttrs>;
  }
  if (isAssistantMessage(result)) {
    return result as AssistantMessage<TAttrs>;
  }
  if (isModelOutput(result)) {
    return {
      type: 'assistant',
      content: result.content,
      toolCalls: result.toolCalls,
      structuredContent: result.structuredOutput,
      attrs: result.metadata as TAttrs | undefined,
    };
  }
  throw new Error(
    `Graph node ${nodePath} returned an invalid assistant result.`,
  );
}

function normalizeGraphInbox<TAttrs extends Attrs>(
  input:
    | string
    | GraphInboundInput<TAttrs>
    | readonly GraphInboundInput<TAttrs>[]
    | undefined,
): GraphInboundInput<TAttrs>[] {
  if (input === undefined) {
    return [];
  }
  if (typeof input === 'string') {
    return [{ kind: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return [...(input as readonly GraphInboundInput<TAttrs>[])];
  }
  return [input as GraphInboundInput<TAttrs>];
}

function graphNodeData(node: AgentGraphNode): GraphNodeData {
  return isRecord(node.data) ? node.data : {};
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

function throwIfGraphAborted<TVars extends Vars, TAttrs extends Attrs>(
  state: GraphExecutionState<TVars, TAttrs>,
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

function isAssistantMessage<TAttrs extends Attrs = Attrs>(
  value: unknown,
): value is AssistantMessage<TAttrs> {
  return (
    isRecord(value) &&
    value.type === 'assistant' &&
    typeof value.content === 'string'
  );
}

function isPromptTrailMessage(value: unknown): value is PromptTrailMessage {
  if (!isRecord(value) || typeof value.content !== 'string') {
    return false;
  }
  return (
    value.type === 'system' ||
    value.type === 'user' ||
    value.type === 'assistant' ||
    value.type === 'tool_result'
  );
}

function isTemplate<TVars extends Vars, TAttrs extends Attrs>(
  value: unknown,
): value is Template<TAttrs, TVars> {
  return isRecord(value) && typeof value.execute === 'function';
}
