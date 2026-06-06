import type { CapabilitySet, PromptTrailTool } from './capabilities';
import { zodToJsonSchema } from './json_schema';
import type { RetainLevel, RuntimeTurnResult } from './runtime';
import type { Attrs, Session, Vars } from './session';
import { executePromptTrailTool, isPromptTrailTool } from './tool';

export type ClaudeAgentInput<TVars extends Vars, TAttrs extends Attrs> =
  | string
  | ((session: Session<TVars, TAttrs>) => string | Promise<string>);

export interface ClaudeAgentClient {
  query(params: ClaudeAgentQueryParams): AsyncIterable<unknown>;
}

export interface ClaudeAgentQueryParams {
  prompt: string;
  options: Record<string, unknown>;
}

export interface ClaudeTurnOptions<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> {
  client?: ClaudeAgentClient;
  input?: ClaudeAgentInput<TVars, TAttrs>;
  cwd?: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  settingSources?: string[];
  skills?: string[];
  capabilities?: CapabilitySet;
  retain?: RetainLevel;
  retainMessages?: boolean;
  attrsKey?: string;
  onEvent?: (event: unknown) => void | Promise<void>;
  squashWith?: (
    session: Session<TVars, TAttrs>,
    result: RuntimeTurnResult,
  ) => Session<TVars, TAttrs> | Promise<Session<TVars, TAttrs>>;
  sdkOptions?: Record<string, unknown>;
}

export interface ClaudeAgentSdkLike {
  query?: (params: ClaudeAgentQueryParams) => AsyncIterable<unknown>;
  tool?: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (input: unknown) => Promise<unknown>,
  ) => unknown;
  createSdkMcpServer?: (options: { name: string; tools: unknown[] }) => unknown;
}

export interface ClaudeAgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => Promise<unknown>;
}

export function getClaudePromptTrailTools(
  capabilities: CapabilitySet | undefined,
): PromptTrailTool[] {
  return (capabilities ?? []).filter(isPromptTrailTool);
}

export function getClaudeAllowedToolNames(
  tools: readonly PromptTrailTool[],
  serverName = 'prompttrail',
): string[] {
  return tools.map((tool) => `mcp__${serverName}__${tool.name}`);
}

export function promptTrailToolToClaudeAgentToolDefinition(
  tool: PromptTrailTool,
  session: Session<any, any>,
): ClaudeAgentToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
    execute: (input) =>
      executePromptTrailTool(tool, input, {
        session,
        provider: 'claude-agent',
        capability: tool.name,
      }),
  };
}

export function createClaudePromptTrailMcpServer(
  tools: readonly PromptTrailTool[],
  session: Session<any, any>,
  sdk?: ClaudeAgentSdkLike,
  serverName = 'prompttrail',
): unknown {
  const definitions = tools.map((tool) =>
    promptTrailToolToClaudeAgentToolDefinition(tool, session),
  );

  if (sdk?.tool && sdk.createSdkMcpServer) {
    return sdk.createSdkMcpServer({
      name: serverName,
      tools: definitions.map((definition) =>
        sdk.tool!(
          definition.name,
          definition.description,
          definition.inputSchema,
          definition.execute,
        ),
      ),
    });
  }

  return {
    name: serverName,
    tools: definitions,
  };
}

export function buildClaudeAgentQueryParams(
  prompt: string,
  session: Session<any, any>,
  options: Omit<
    ClaudeTurnOptions,
    'client' | 'input' | 'onEvent' | 'squashWith'
  >,
  sdk?: ClaudeAgentSdkLike,
): ClaudeAgentQueryParams {
  const tools = getClaudePromptTrailTools(options.capabilities);
  const mcpServers =
    tools.length > 0
      ? {
          prompttrail: createClaudePromptTrailMcpServer(
            tools,
            session,
            sdk,
            'prompttrail',
          ),
        }
      : undefined;

  return {
    prompt,
    options: {
      cwd: options.cwd,
      model: options.model,
      allowedTools:
        tools.length > 0
          ? [
              ...(options.allowedTools ?? []),
              ...getClaudeAllowedToolNames(tools, 'prompttrail'),
            ]
          : options.allowedTools,
      disallowedTools: options.disallowedTools,
      permissionMode: options.permissionMode,
      settingSources: options.settingSources,
      skills: options.skills,
      mcpServers,
      ...(options.sdkOptions ?? {}),
    },
  };
}

export async function collectClaudeAgentTurnResult(
  events: AsyncIterable<unknown>,
  onEvent?: (event: unknown) => void | Promise<void>,
): Promise<RuntimeTurnResult> {
  const retainedEvents: unknown[] = [];
  let finalAnswer = '';
  let status: RuntimeTurnResult['status'] = 'completed';
  let sessionId: string | undefined;

  for await (const event of events) {
    retainedEvents.push(event);
    await onEvent?.(event);
    finalAnswer = extractClaudeAgentFinalAnswer(event) ?? finalAnswer;
    sessionId = extractClaudeAgentSessionId(event) ?? sessionId;
    status = extractClaudeAgentStatus(event) ?? status;
  }

  return {
    provider: 'claude-agent',
    status,
    finalAnswer: finalAnswer || ' ',
    events: retainedEvents as never,
    raw: retainedEvents,
    sessionId,
  };
}

export function claudeAgentResultToMessage<TAttrs extends Attrs = Attrs>(
  result: RuntimeTurnResult,
  attrsKey = 'claudeAgent',
) {
  return {
    type: 'assistant' as const,
    content: result.finalAnswer || ' ',
    attrs: {
      [attrsKey]: result,
    } as TAttrs,
  };
}

export async function createDefaultClaudeAgentClient(): Promise<ClaudeAgentClient> {
  const packageName = '@anthropic-ai/claude-agent-sdk';
  const sdk = (await import(packageName)) as ClaudeAgentSdkLike;
  if (typeof sdk.query !== 'function') {
    throw new Error(
      '@anthropic-ai/claude-agent-sdk does not expose a query function.',
    );
  }
  return {
    query: (params) => sdk.query!(params),
  };
}

function extractClaudeAgentFinalAnswer(event: unknown): string | undefined {
  const record = asRecord(event);
  if (!record) {
    return undefined;
  }
  if (typeof record.result === 'string') {
    return record.result;
  }
  if (typeof record.finalAnswer === 'string') {
    return record.finalAnswer;
  }
  if (typeof record.text === 'string') {
    return record.text;
  }

  const message = asRecord(record.message);
  const content = Array.isArray(record.content)
    ? record.content
    : Array.isArray(message?.content)
      ? message.content
      : undefined;
  const text = content
    ?.map((block) => asRecord(block))
    .filter(Boolean)
    .filter((block) => block?.type === 'text')
    .map((block) => block?.text)
    .filter((value): value is string => typeof value === 'string')
    .join('');

  return text || undefined;
}

function extractClaudeAgentSessionId(event: unknown): string | undefined {
  const record = asRecord(event);
  return stringValue(record?.session_id ?? record?.sessionId);
}

function extractClaudeAgentStatus(
  event: unknown,
): RuntimeTurnResult['status'] | undefined {
  const record = asRecord(event);
  const value = stringValue(record?.status);
  return value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'interrupted'
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
