import type { z } from 'zod';
import type { CacheHint } from './cache';
import type {
  ExecutionDurableBoundary,
  ExecutionEffectDeclaration,
} from './interceptors';
import type { Session } from './session';

export type ExecutionMode = 'prompttrail' | 'provider' | 'runtime';

export type ApprovalDecision =
  | { type: 'approve'; reason?: string }
  | { type: 'deny'; reason?: string }
  | { type: 'ask-user'; question: string };

export interface ApprovalRequest {
  provider: 'openai' | 'anthropic' | 'google' | 'codex' | 'claude-agent';
  action: string;
  capability?: string;
  input?: unknown;
  risk?: 'read' | 'write' | 'network' | 'execute' | 'external';
  raw?: unknown;
}

export type ApprovalHandler = (
  request: ApprovalRequest,
  session: Session<any>,
) => Promise<ApprovalDecision>;

export type ApprovalPolicy = 'never' | 'always' | 'on-risk' | ApprovalHandler;

export interface ToolExecutionContext {
  session?: Session<any>;
  services?: Record<string, unknown>;
  provider?: ApprovalRequest['provider'] | 'ai-sdk';
  capability?: string;
  raw?: unknown;
  approvalHandler?: ApprovalHandler;
  effect?: ExecutionEffectDeclaration;
  idempotencyKey?: string;
  durable?: ExecutionDurableBoundary;
}

export type CallToolContent =
  | { type: 'text'; text: string }
  | { type: 'json'; json: unknown };

export interface CallToolResult {
  content: CallToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface PromptTrailTool<TInput = unknown, TResult = unknown> {
  kind: 'tool';
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (
    input: TInput,
    context: ToolExecutionContext,
  ) => Promise<TResult> | TResult;
  approval?: ApprovalPolicy;
  cache?: CacheHint;
  effect?: ExecutionEffectDeclaration;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSkill {
  kind: 'skill';
  name: string;
  description?: string;
  instructions?: string;
  path?: string;
  skillId?: string;
  materialize?: 'never' | 'workspace' | 'temporary';
  cache?: CacheHint;
  metadata?: Record<string, unknown>;
}

export type McpTransport =
  | {
      kind: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { kind: 'http'; url: string; headers?: Record<string, string> }
  | { kind: 'sdk-in-process'; server: unknown };

export interface McpServer {
  kind: 'mcp';
  name: string;
  transport: McpTransport;
  tools?: 'all' | string[];
  effects?: {
    defaults?: ExecutionEffectDeclaration;
    perTool?: Record<string, ExecutionEffectDeclaration>;
  };
  approval?: ApprovalPolicy;
  cache?: CacheHint;
}

export interface BuiltinTool {
  kind: 'builtin';
  name: string;
  provider?: ApprovalRequest['provider'];
  executionMode: Exclude<ExecutionMode, 'prompttrail'>;
  config?: Record<string, unknown>;
  approval?: ApprovalPolicy;
  cache?: CacheHint;
  metadata?: Record<string, unknown>;
}

export type Capability =
  | PromptTrailTool
  | RuntimeSkill
  | BuiltinTool
  | McpServer;

export type CapabilitySet = readonly Capability[];

export interface ConfiguredCapabilityApprovalContext {
  provider: ApprovalRequest['provider'];
  session: Session<any>;
  approvalHandler?: ApprovalHandler;
  action?: string;
  input?: unknown;
  risk?: ApprovalRequest['risk'];
  raw?: unknown;
}

export async function resolveConfiguredCapabilityApproval(
  capability: BuiltinTool | McpServer,
  context: ConfiguredCapabilityApprovalContext,
): Promise<ApprovalDecision> {
  if (!capability.approval || capability.approval === 'never') {
    return { type: 'approve' };
  }

  const handler =
    typeof capability.approval === 'function'
      ? capability.approval
      : context.approvalHandler;

  if (!handler) {
    return {
      type: 'deny',
      reason: `Capability "${capability.name}" requires approval but no approval handler was provided.`,
    };
  }

  return handler(
    {
      provider: context.provider,
      action: context.action ?? getConfiguredCapabilityAction(capability),
      capability: capability.name,
      input: context.input ?? getConfiguredCapabilityApprovalInput(capability),
      risk: context.risk ?? getConfiguredCapabilityRisk(capability),
      raw: context.raw,
    },
    context.session,
  );
}

export async function requireConfiguredCapabilityApproval(
  capability: BuiltinTool | McpServer,
  context: ConfiguredCapabilityApprovalContext,
): Promise<void> {
  const decision = await resolveConfiguredCapabilityApproval(
    capability,
    context,
  );
  if (decision.type === 'approve') {
    return;
  }
  if (decision.type === 'ask-user') {
    throw new Error(decision.question);
  }
  throw new Error(
    `Capability "${capability.name}" approval denied${
      decision.reason ? `: ${decision.reason}` : ''
    }`,
  );
}

export async function requireConfiguredCapabilityApprovals(
  capabilities: CapabilitySet | undefined,
  context: ConfiguredCapabilityApprovalContext,
): Promise<void> {
  for (const capability of capabilities ?? []) {
    if (capability.kind === 'builtin' || capability.kind === 'mcp') {
      await requireConfiguredCapabilityApproval(capability, context);
    }
  }
}

export function resolveMcpDiscoveredToolEffectDeclaration(
  server: McpServer,
  toolName: string,
): ExecutionEffectDeclaration | undefined {
  return server.effects?.perTool?.[toolName] ?? server.effects?.defaults;
}

export function assertCheckpointDiscoveredToolEffectDeclaration(
  server: McpServer,
  toolName: string,
): ExecutionEffectDeclaration {
  const effect = resolveMcpDiscoveredToolEffectDeclaration(server, toolName);
  if (effect) {
    return effect;
  }
  throw new Error(
    `Checkpoint MCP tool "${toolName}" discovered from server "${server.name}" is missing an ExecutionEffectDeclaration. Fix the MCP server registration with effects: { defaults: { repeatable: true } } or effects: { perTool: { ${JSON.stringify(toolName)}: { idempotencyKey: 'stable-key' } } }.`,
  );
}

export function getCapabilityExecutionMode(
  capability: Capability,
): ExecutionMode {
  if (capability.kind === 'tool') {
    return 'prompttrail';
  }
  if (capability.kind === 'builtin') {
    return capability.executionMode;
  }
  if (capability.kind === 'mcp' || capability.kind === 'skill') {
    return 'runtime';
  }

  const _exhaustive: never = capability;
  return _exhaustive;
}

function getConfiguredCapabilityAction(
  capability: BuiltinTool | McpServer,
): string {
  return capability.kind === 'mcp' ? 'mcp.configure' : 'builtin.enable';
}

function getConfiguredCapabilityApprovalInput(
  capability: BuiltinTool | McpServer,
): unknown {
  if (capability.kind === 'mcp') {
    return {
      transport: capability.transport,
      tools: capability.tools,
    };
  }
  return {
    executionMode: capability.executionMode,
    config: capability.config,
  };
}

function getConfiguredCapabilityRisk(
  capability: BuiltinTool | McpServer,
): ApprovalRequest['risk'] {
  if (capability.kind === 'mcp') {
    return 'external';
  }
  const name = capability.name.toLowerCase();
  if (
    name.includes('shell') ||
    name.includes('bash') ||
    name.includes('code') ||
    name.includes('computer')
  ) {
    return 'execute';
  }
  if (name.includes('search') || name.includes('url') || name.includes('web')) {
    return 'network';
  }
  return 'external';
}
