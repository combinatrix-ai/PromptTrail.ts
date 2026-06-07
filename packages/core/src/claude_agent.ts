import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ApprovalHandler,
  BuiltinTool,
  CapabilitySet,
  McpServer,
  PromptTrailTool,
  RuntimeSkill,
} from './capabilities';
import { zodToJsonSchema } from './json_schema';
import type { RetainLevel, RuntimeTurnResult } from './runtime';
import type { Attrs, Session, Vars } from './session';
import { executePromptTrailTool, isPromptTrailTool } from './tool';

export type ClaudeAgentInput<TVars extends Vars, TAttrs extends Attrs> =
  | string
  | ((
      session: Session<TVars, TAttrs>,
      context: Record<string, unknown> | undefined,
    ) => string | Promise<string>);

export type ClaudeAgentSessionId<TVars extends Vars, TAttrs extends Attrs> =
  | string
  | 'new'
  | 'auto'
  | ((
      session: Session<TVars, TAttrs>,
      context: Record<string, unknown> | undefined,
    ) => string | undefined | Promise<string | undefined>);

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
  sessionId?: ClaudeAgentSessionId<TVars, TAttrs>;
  cwd?: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  settingSources?: string[];
  skills?: string[];
  capabilities?: CapabilitySet;
  approvalHandler?: ApprovalHandler;
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

export interface ClaudeSkillMaterialization {
  skill: RuntimeSkill;
  name: string;
  directory: string;
  skillFile: string;
}

export function getClaudePromptTrailTools(
  capabilities: CapabilitySet | undefined,
): PromptTrailTool[] {
  return (capabilities ?? []).filter(isPromptTrailTool);
}

export function getClaudeRuntimeSkills(
  capabilities: CapabilitySet | undefined,
): RuntimeSkill[] {
  return (capabilities ?? []).filter(
    (capability): capability is RuntimeSkill => capability.kind === 'skill',
  );
}

export function getClaudeBuiltinTools(
  capabilities: CapabilitySet | undefined,
): BuiltinTool[] {
  return (capabilities ?? []).filter(
    (capability): capability is BuiltinTool => capability.kind === 'builtin',
  );
}

export function getClaudeMcpServers(
  capabilities: CapabilitySet | undefined,
): McpServer[] {
  return (capabilities ?? []).filter(
    (capability): capability is McpServer => capability.kind === 'mcp',
  );
}

export function getClaudeSkillNames(
  capabilities: CapabilitySet | undefined,
  explicitSkills: readonly string[] = [],
): string[] {
  return [
    ...new Set([
      ...explicitSkills,
      ...getClaudeRuntimeSkills(capabilities).map((skill) => skill.name),
    ]),
  ];
}

export function getClaudeAllowedToolNames(
  tools: readonly PromptTrailTool[],
  serverName = 'prompttrail',
): string[] {
  return tools.map((tool) => `mcp__${serverName}__${tool.name}`);
}

export function getClaudeAllowedMcpToolNames(
  servers: readonly McpServer[],
): string[] {
  return servers.flatMap((server) =>
    Array.isArray(server.tools)
      ? server.tools.map((tool) => `mcp__${server.name}__${tool}`)
      : [],
  );
}

export function promptTrailToolToClaudeAgentToolDefinition(
  tool: PromptTrailTool,
  session: Session<any, any>,
  approvalHandler?: ApprovalHandler,
  context?: Record<string, unknown>,
): ClaudeAgentToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
    execute: (input) =>
      executePromptTrailTool(tool, input, {
        session,
        context,
        provider: 'claude-agent',
        capability: tool.name,
        approvalHandler,
      }),
  };
}

export function createClaudePromptTrailMcpServer(
  tools: readonly PromptTrailTool[],
  session: Session<any, any>,
  sdk?: ClaudeAgentSdkLike,
  serverName = 'prompttrail',
  approvalHandler?: ApprovalHandler,
  context?: Record<string, unknown>,
): unknown {
  const definitions = tools.map((tool) =>
    promptTrailToolToClaudeAgentToolDefinition(
      tool,
      session,
      approvalHandler,
      context,
    ),
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

export function promptTrailMcpToClaudeAgentMcpServer(
  server: McpServer,
): unknown {
  if (server.transport.kind === 'sdk-in-process') {
    return server.transport.server;
  }
  if (server.transport.kind === 'http') {
    return {
      type: 'http',
      url: server.transport.url,
      headers: server.transport.headers,
      allowedTools: server.tools === 'all' ? undefined : server.tools,
    };
  }
  return {
    type: 'stdio',
    command: server.transport.command,
    args: server.transport.args,
    env: server.transport.env,
    allowedTools: server.tools === 'all' ? undefined : server.tools,
  };
}

export function getClaudeAgentMcpServers(
  capabilities: CapabilitySet | undefined,
  tools: readonly PromptTrailTool[],
  session: Session<any, any>,
  sdk?: ClaudeAgentSdkLike,
  approvalHandler?: ApprovalHandler,
  context?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const servers: Record<string, unknown> = {};
  for (const server of getClaudeMcpServers(capabilities)) {
    servers[server.name] = promptTrailMcpToClaudeAgentMcpServer(server);
  }
  if (tools.length > 0) {
    servers.prompttrail = createClaudePromptTrailMcpServer(
      tools,
      session,
      sdk,
      'prompttrail',
      approvalHandler,
      context,
    );
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

export function buildClaudeAgentQueryParams(
  prompt: string,
  session: Session<any, any>,
  options: Omit<
    ClaudeTurnOptions,
    'client' | 'input' | 'onEvent' | 'squashWith'
  > & { context?: Record<string, unknown> },
  sdk?: ClaudeAgentSdkLike,
): ClaudeAgentQueryParams {
  const tools = getClaudePromptTrailTools(options.capabilities);
  const skillNames = getClaudeSkillNames(options.capabilities, options.skills);
  const mcpServers = getClaudeAgentMcpServers(
    options.capabilities,
    tools,
    session,
    sdk,
    options.approvalHandler,
    options.context,
  );
  const mcpAllowedTools = getClaudeAllowedMcpToolNames(
    getClaudeMcpServers(options.capabilities),
  );
  const builtinTools = getClaudeBuiltinTools(options.capabilities).map(
    (tool) => tool.name,
  );
  const allowedTools = [
    ...(options.allowedTools ?? []),
    ...builtinTools,
    ...(tools.length > 0
      ? getClaudeAllowedToolNames(tools, 'prompttrail')
      : []),
    ...mcpAllowedTools,
  ];

  return {
    prompt,
    options: {
      cwd: options.cwd,
      model: options.model,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      disallowedTools: options.disallowedTools,
      permissionMode: options.permissionMode,
      settingSources: options.settingSources,
      skills: skillNames.length > 0 ? skillNames : undefined,
      resume: getClaudeAgentResumeId(options.sessionId),
      mcpServers,
      ...(options.sdkOptions ?? {}),
    },
  };
}

function getClaudeAgentResumeId(
  sessionId: ClaudeTurnOptions['sessionId'],
): string | undefined {
  return typeof sessionId === 'string' &&
    sessionId !== 'new' &&
    sessionId !== 'auto'
    ? sessionId
    : undefined;
}

export async function materializeClaudeAgentSkills(options: {
  capabilities: CapabilitySet | undefined;
  cwd: string | undefined;
  approvalHandler: ApprovalHandler | undefined;
  session: Session<any, any>;
}): Promise<ClaudeSkillMaterialization[]> {
  const skills = getClaudeRuntimeSkills(options.capabilities).filter(
    (skill) => skill.materialize === 'workspace',
  );
  if (skills.length === 0) {
    return [];
  }
  if (!options.cwd) {
    throw new Error('Claude Agent skill materialization requires cwd.');
  }
  if (!options.approvalHandler) {
    throw new Error(
      'Claude Agent skill materialization requires an approvalHandler.',
    );
  }

  const workspace = resolve(options.cwd);
  const materialized: ClaudeSkillMaterialization[] = [];
  for (const skill of skills) {
    const name = sanitizeClaudeSkillName(skill.name);
    const directory = resolve(workspace, '.claude', 'skills', name);
    if (!directory.startsWith(`${workspace}/`) && directory !== workspace) {
      throw new Error(
        `Refusing to materialize skill outside cwd: ${skill.name}`,
      );
    }
    const skillFile = resolve(directory, 'SKILL.md');
    const decision = await options.approvalHandler(
      {
        provider: 'claude-agent',
        action: 'materializeSkill',
        capability: skill.name,
        risk: 'write',
        input: {
          directory,
          skillFile,
          skill,
        },
      },
      options.session,
    );
    if (decision.type === 'deny') {
      throw new Error(
        `Claude Agent skill materialization denied${decision.reason ? `: ${decision.reason}` : ''}`,
      );
    }
    if (decision.type === 'ask-user') {
      throw new Error(decision.question);
    }

    await mkdir(directory, { recursive: true });
    await writeFile(skillFile, renderClaudeSkillMarkdown(skill), 'utf8');
    materialized.push({ skill, name, directory, skillFile });
  }

  return materialized;
}

export function renderClaudeSkillMarkdown(skill: RuntimeSkill): string {
  const lines = [
    `# ${skill.name}`,
    '',
    skill.description,
    '',
    '## Instructions',
    '',
    skill.instructions || '',
    '',
  ];
  return lines.filter((line) => line !== undefined).join('\n');
}

export function sanitizeClaudeSkillName(name: string): string {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) {
    throw new Error('Claude Agent skill name cannot be empty.');
  }
  return sanitized;
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
