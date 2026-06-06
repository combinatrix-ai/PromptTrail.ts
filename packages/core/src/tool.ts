import { z } from 'zod';
import type { CacheHint } from './cache';
import type {
  ApprovalDecision,
  ApprovalPolicy,
  CallToolResult,
  PromptTrailTool,
  ToolExecutionContext,
} from './capabilities';

export type { CallToolResult, PromptTrailTool, ToolExecutionContext };

export type Tool<TParams = any, TResult = any> = PromptTrailTool<
  TParams,
  TResult
>;

export namespace Tool {
  export function create<TParams, TResult>(config: {
    name: string;
    description: string;
    inputSchema: z.ZodType<TParams>;
    execute: (
      input: TParams,
      context: ToolExecutionContext,
    ) => Promise<TResult> | TResult;
    approval?: ApprovalPolicy;
    cache?: CacheHint;
    metadata?: Record<string, unknown>;
  }): PromptTrailTool<TParams, TResult>;
  export function create<TParams, TResult>(config: {
    name?: string;
    description: string;
    parameters: z.ZodType<TParams>;
    execute: (input: TParams) => Promise<TResult> | TResult;
    approval?: ApprovalPolicy;
    cache?: CacheHint;
    metadata?: Record<string, unknown>;
  }): PromptTrailTool<TParams, TResult>;
  export function create<TParams, TResult>(config: {
    name?: string;
    description: string;
    inputSchema?: z.ZodType<TParams>;
    parameters?: z.ZodType<TParams>;
    execute:
      | ((
          input: TParams,
          context: ToolExecutionContext,
        ) => Promise<TResult> | TResult)
      | ((input: TParams) => Promise<TResult> | TResult);
    approval?: ApprovalPolicy;
    cache?: CacheHint;
    metadata?: Record<string, unknown>;
  }): PromptTrailTool<TParams, TResult> {
    const inputSchema = config.inputSchema ?? config.parameters;
    if (!inputSchema) {
      throw new Error('Tool.create requires inputSchema.');
    }

    return {
      kind: 'tool',
      name: config.name ?? 'tool',
      description: config.description,
      inputSchema,
      execute: async (input, context) => config.execute(input, context),
      approval: config.approval,
      cache: config.cache,
      metadata: config.metadata,
    };
  }
}

export function isPromptTrailTool(
  value: unknown,
): value is PromptTrailTool<unknown, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.kind === 'tool' &&
    typeof record.name === 'string' &&
    typeof record.description === 'string' &&
    'inputSchema' in record &&
    typeof record.execute === 'function'
  );
}

export async function executePromptTrailTool<TInput, TResult>(
  tool: PromptTrailTool<TInput, TResult>,
  input: TInput,
  context: ToolExecutionContext = {},
): Promise<CallToolResult> {
  try {
    const parsedInput = tool.inputSchema.parse(input);
    const approval = await resolveToolApproval(tool, parsedInput, context);
    if (approval.type !== 'approve') {
      return {
        content: [
          {
            type: 'text',
            text:
              approval.type === 'deny'
                ? `Tool execution denied${approval.reason ? `: ${approval.reason}` : ''}`
                : approval.question,
          },
        ],
        isError: true,
      };
    }

    const result = await tool.execute(parsedInput, {
      ...context,
      capability: tool.name,
    });
    return toolResultToCallToolResult(result);
  } catch (error) {
    return {
      content: [{ type: 'text', text: formatToolError(error) }],
      isError: true,
    };
  }
}

export async function resolveToolApproval<TInput>(
  tool: PromptTrailTool<TInput, unknown>,
  input: TInput,
  context: ToolExecutionContext,
): Promise<ApprovalDecision> {
  if (!tool.approval || tool.approval === 'never') {
    return { type: 'approve' };
  }

  const handler =
    typeof tool.approval === 'function'
      ? tool.approval
      : context.approvalHandler;

  if (!handler) {
    return {
      type: 'deny',
      reason: `Tool "${tool.name}" requires approval but no approval handler was provided.`,
    };
  }

  return handler(
    {
      provider: normalizeApprovalProvider(context.provider),
      action: 'tool.execute',
      capability: tool.name,
      input,
      risk: 'external',
      raw: context.raw,
    },
    context.session as any,
  );
}

export function toolResultToCallToolResult(result: unknown): CallToolResult {
  if (isCallToolResult(result)) {
    return result;
  }

  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }

  if (isPlainRecord(result)) {
    return {
      content: [{ type: 'json', json: result }],
      structuredContent: result,
    };
  }

  return {
    content: [{ type: 'json', json: result }],
  };
}

function isCallToolResult(value: unknown): value is CallToolResult {
  if (!isPlainRecord(value) || !Array.isArray(value.content)) {
    return false;
  }

  return value.content.every(
    (item) =>
      isPlainRecord(item) &&
      ((item.type === 'text' && typeof item.text === 'string') ||
        (item.type === 'json' && 'json' in item)),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatToolError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return JSON.stringify(error);
}

function normalizeApprovalProvider(
  provider: ToolExecutionContext['provider'],
): 'openai' | 'anthropic' | 'google' | 'codex' | 'claude-agent' {
  if (
    provider === 'openai' ||
    provider === 'anthropic' ||
    provider === 'google' ||
    provider === 'codex' ||
    provider === 'claude-agent'
  ) {
    return provider;
  }
  return 'openai';
}
