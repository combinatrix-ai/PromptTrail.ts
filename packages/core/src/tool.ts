import { z } from 'zod';
import type { CacheHint } from './cache';
import type {
  ApprovalDecision,
  ApprovalPolicy,
  CallToolResult,
  PromptTrailTool,
  ToolExecutionContext,
} from './capabilities';
import type { ExecutionEffectDeclaration } from './interceptors';
import { digest } from './recording';

export type { CallToolResult, PromptTrailTool, ToolExecutionContext };

export type Tool<TParams = any, TResult = any> = PromptTrailTool<
  TParams,
  TResult
>;

export namespace Tool {
  export function create<TParams, TResult>(config: {
    name?: string;
    description: string;
    inputSchema: z.ZodType<TParams>;
    execute: (
      input: TParams,
      context: ToolExecutionContext,
    ) => Promise<TResult> | TResult;
    approval?: ApprovalPolicy;
    cache?: CacheHint;
    effect?: ExecutionEffectDeclaration;
    metadata?: Record<string, unknown>;
  }): PromptTrailTool<TParams, TResult>;
  export function create<TParams, TResult>(config: {
    name?: string;
    description: string;
    inputSchema?: z.ZodType<TParams>;
    execute:
      | ((
          input: TParams,
          context: ToolExecutionContext,
        ) => Promise<TResult> | TResult)
      | ((input: TParams) => Promise<TResult> | TResult);
    approval?: ApprovalPolicy;
    cache?: CacheHint;
    effect?: ExecutionEffectDeclaration;
    metadata?: Record<string, unknown>;
  }): PromptTrailTool<TParams, TResult> {
    const inputSchema = config.inputSchema;
    if (!inputSchema) {
      throw new Error('Tool.create requires inputSchema.');
    }

    const metadata = config.effect
      ? { ...config.metadata, effect: config.effect }
      : config.metadata;

    return {
      kind: 'tool',
      name: config.name ?? 'tool',
      description: config.description,
      inputSchema,
      execute: async (input, context) => config.execute(input, context),
      approval: config.approval,
      cache: config.cache,
      effect: config.effect,
      metadata,
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
    const executionName = context.capability ?? tool.name;
    // B1 replay: serve the recorded tool result from the cassette instead of
    // executing the tool — side effects never run during a replay. Approval,
    // idempotency, and execution are all skipped; the recorder below still
    // captures the substituted result into the replay's fresh recording.
    if (context.replay) {
      const replayNodePath =
        context.recordNodePath ??
        context.recorder?.currentNodePath ??
        executionName;
      const callResult = context.replay.tool({
        nodePath: replayNodePath,
        toolName: executionName,
        argsDigest: digest(parsedInput),
      });
      context.recorder?.tool({
        nodePath: replayNodePath,
        toolName: executionName,
        input: parsedInput,
        result: callResult,
        effect: tool.effect ?? context.effect,
      });
      return callResult;
    }
    const approval = await resolveToolApproval(tool, parsedInput, {
      ...context,
      capability: executionName,
    });
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

    const executionContext = {
      ...context,
      capability: executionName,
      effect: tool.effect ?? context.effect,
    };
    const idempotencyKey = resolveIdempotencyKey(
      executionContext.effect,
      parsedInput,
    );
    const toolContext = {
      ...executionContext,
      idempotencyKey,
    };
    const result =
      executionContext.durable && idempotencyKey !== undefined
        ? await executionContext.durable.once(
            executionName,
            idempotencyKey,
            () => tool.execute(parsedInput, toolContext),
          )
        : await tool.execute(parsedInput, toolContext);
    const callResult = toolResultToCallToolResult(result);
    // B0 tool capture at the single execution funnel (Appendix B0 work item 1).
    // Recorded only when a recorder + nodePath were threaded in — i.e. the graph
    // tools node (and graph ai-sdk-wrapped tools). Builtin/MCP/vendor-loop tool
    // calls execute provider-side outside this funnel and are reconstructed from
    // the model response, so they carry no recorder and are not double-recorded.
    context.recorder?.tool({
      nodePath:
        context.recordNodePath ??
        context.recorder.currentNodePath ??
        executionName,
      toolName: executionName,
      input: parsedInput,
      result: callResult,
      effect: executionContext.effect,
    });
    return callResult;
  } catch (error) {
    return {
      content: [{ type: 'text', text: formatToolError(error) }],
      isError: true,
    };
  }
}

function resolveIdempotencyKey(
  effect: ExecutionEffectDeclaration | undefined,
  input: unknown,
): string | undefined {
  if (!effect || !('idempotencyKey' in effect)) {
    return undefined;
  }
  return typeof effect.idempotencyKey === 'function'
    ? effect.idempotencyKey(input)
    : effect.idempotencyKey;
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
      capability: context.capability ?? tool.name,
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
