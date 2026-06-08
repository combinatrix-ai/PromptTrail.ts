import type { CallToolResult } from './capabilities';
import type { AgentGraph, AgentGraphNode } from './graph';
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
  maxLoopIterations?: number;
}

export class GraphExecutionSuspended extends Error {
  constructor(
    public readonly nodePath: string,
    message = `Graph execution suspended at ${nodePath}`,
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
}

type GraphNodeData = Record<string, unknown>;

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
      throw new Error(`Graph node ${nodePath} is not executable yet: goal`);
    case 'subroutine':
      throw new Error(
        `Graph node ${nodePath} is not executable yet: subroutine`,
      );
    case 'loop':
      await executeLoopNode(node, nodePath, state);
      return;
    case 'tools':
      await executeToolsNode(node, nodePath, state);
      return;
    case 'awaitInput':
      if (!consumeInbox(state)) {
        throw new GraphExecutionSuspended(nodePath);
      }
      return;
    case 'patch':
      await executePatchNode(node, nodePath, state);
      return;
    case 'messages':
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
    throw new Error(
      `Graph node ${nodePath} is not executable yet: goal attempts`,
    );
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
  const content = await resolveGraphContent(input, nodePath, state.session);
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
      ? await input(state.session)
      : await resolveGraphContent(input, nodePath, state.session);
  state.session = state.session.addMessage(normalizeAssistantResult(result));
}

async function executePatchNode<TVars extends Vars, TAttrs extends Attrs>(
  node: AgentGraphNode,
  nodePath: string,
  state: GraphExecutionState<TVars, TAttrs>,
): Promise<void> {
  const data = graphNodeData(node);
  if (data.kind === 'goalSatisfaction') {
    throw new Error(
      `Graph node ${nodePath} is not executable yet: goal satisfaction`,
    );
  }
  const handler = data.handler;
  if (typeof handler !== 'function') {
    throw new Error(`Graph node ${nodePath} requires a patch handler.`);
  }
  const result = await handler(state.session);
  if (result instanceof Session) {
    state.session = result as Session<TVars, TAttrs>;
  }
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
): boolean {
  const inbound = state.inbox[state.cursor++];
  if (!inbound) {
    return false;
  }
  if (inbound.kind === 'system') {
    state.session = state.session.addMessage(
      Message.system(inbound.content, inbound.attrs),
    );
    return true;
  }
  state.session = state.session.addMessage(
    Message.user(inbound.content, inbound.attrs),
  );
  return true;
}

async function resolveGraphContent<TVars extends Vars, TAttrs extends Attrs>(
  input: unknown,
  nodePath: string,
  session: Session<TVars, TAttrs>,
): Promise<string | ModelOutput> {
  if (input instanceof Source) {
    return input.getContent(session);
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
): AssistantMessage<TAttrs> {
  if (typeof result === 'string') {
    return Message.assistant(result) as AssistantMessage<TAttrs>;
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
  if (isAssistantMessage(result)) {
    return result as AssistantMessage<TAttrs>;
  }
  return Message.assistant(String(result)) as AssistantMessage<TAttrs>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isModelOutput(value: unknown): value is ModelOutput {
  return isRecord(value) && typeof value.content === 'string';
}

function isAssistantMessage(value: unknown): value is { type: 'assistant' } {
  return isRecord(value) && value.type === 'assistant';
}
