import type { z } from 'zod';
import type { CacheHint } from './cache';
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
  session: Session<any, any>,
) => Promise<ApprovalDecision>;

export type ApprovalPolicy = 'never' | 'always' | 'on-risk' | ApprovalHandler;

export interface ToolExecutionContext {
  session?: Session<any, any>;
  provider?: ApprovalRequest['provider'] | 'ai-sdk';
  capability?: string;
  raw?: unknown;
  approvalHandler?: ApprovalHandler;
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
