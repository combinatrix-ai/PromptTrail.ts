import type { CallToolResult } from './capabilities';
import type { AgentGraph, AgentGraphNode } from './graph';
import {
  createExecutionRuntimeState,
  type ExecutionRuntimeState,
} from './interceptors';
import {
  Message,
  type AssistantMessage,
  type Message as PromptTrailMessage,
} from './message';
import { Session, type Attrs, type Vars } from './session';
import { type ModelOutput, Source } from './source';
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
  input?: string | GraphInboundInput<TAttrs> | readonly GraphInboundInput<TAttrs>[];
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  maxLoopIterations?: number;
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
  const state: GraphExecutionState<TVars, TAttrs> = {
    graph,
    session: options.session ?? Session.create<TVars, TAttrs>(),
    inbox: normalizeGraphInbox<TAttrs>(options.input),
    cursor: 0,
    maxLoopIterations: options.maxLoopIterations ?? 10,
    context: options.context,
    signal: options.signal,
    runtime: createExecutionRuntimeState<TVars, TAttrs>({
      context: options.context,
      signal: options.signal,
    }),
  };

  for (const node of graph.nodes) {
    await executeGraphNode(node, `${graph.name}/${node.id}`, state);
  }

  return state.session;
}

async function executeGraphNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  throwIfGraphAborted(state);
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
    case 'conditional':
    case 'parallel':
    case 'structured':
    case 'transform':
    case 'codexTurn':
    case 'claudeTurn':
      throw new Error(
        `Graph node ${nodePath} is not executable yet: ${node.type}`,
      );
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
  const condition = data.condition;
  const shouldContinue =
    typeof condition === 'function'
      ? () => Boolean(condition({ session: state.session }))
      : () => false;

  let iterations = 0;
  while (shouldContinue()) {
    if (iterations++ >= state.maxLoopIterations) {
      throw new Error(`Graph loop ${nodePath} exceeded max iterations.`);
    }
    await executeChildren(node.children ?? [], nodePath, state);
  }
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

async function executeGoalAttemptsNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  const goal = state.activeGoal;
  if (!goal) {
    throw new Error(`Graph node ${nodePath} requires an active goal.`);
  }

  while (!goal.satisfied && !goal.stopped) {
    const countsAsAttempt =
      goal.interaction !== 'required' || goal.interacted;
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
  const result =
    typeof input === 'function'
      ? await input(state.session, {
          context: state.context,
          signal: state.signal,
        })
      : await resolveGraphContent(
          input,
          nodePath,
          state.session,
          state.runtime,
        );
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
    lastMessage?.type === 'assistant' ? lastMessage.toolCalls ?? [] : [];
  if (toolCalls.length === 0) {
    return;
  }

  const tools = resolveGraphTools(data.tools, state.graph.tools, nodePath);
  for (const call of toolCalls) {
    const tool = tools[call.name];
    if (!tool) {
      throw new Error(
        `Graph node ${nodePath} cannot resolve tool ${call.name}.`,
      );
    }
    const result = await executePromptTrailTool(tool, call.arguments, {
      session: state.session,
      raw: call,
      capability: call.name,
    });
    state.session = state.session.addMessage(
      normalizeToolResultMessage(result, call),
    );
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
        throw new Error(
          `Graph node ${nodePath} allows unknown tool ${name}.`,
        );
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
  throw new Error(`Graph node ${nodePath} returned an invalid assistant result.`);
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
  throw reason instanceof Error ? reason : new Error('Graph execution aborted.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isModelOutput(value: unknown): value is ModelOutput {
  return isRecord(value) && typeof value.content === 'string';
}

function isAssistantMessage(value: unknown): value is { type: 'assistant' } {
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
