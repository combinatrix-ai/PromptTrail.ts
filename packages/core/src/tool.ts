import { tool as aiTool, type Tool as AiTool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Session } from './session';
import type {
  CallToolResult,
  PromptTrailTool,
  ToolExecutionContext,
} from './capabilities';

export type { CallToolResult, PromptTrailTool, ToolExecutionContext };

export type AiSdkTool<TParams = any, TResult = any> = AiTool<
  z.ZodType<TParams>,
  TResult
>;

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
    metadata?: Record<string, unknown>;
  }): PromptTrailTool<TParams, TResult>;
  export function create<TParams, TResult>(config: {
    name?: string;
    description: string;
    parameters: z.ZodType<TParams>;
    execute: (input: TParams) => Promise<TResult> | TResult;
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

export function promptTrailToolToAiSdkTool<TInput, TResult>(
  promptTrailTool: PromptTrailTool<TInput, TResult>,
  context?: Omit<ToolExecutionContext, 'capability'>,
): AiSdkTool<TInput, TResult> {
  return aiTool<z.ZodType<TInput>, TResult>({
    description: promptTrailTool.description,
    parameters: promptTrailTool.inputSchema,
    execute: async (input, raw) =>
      promptTrailTool.execute(input, {
        ...context,
        capability: promptTrailTool.name,
        raw,
      }),
  });
}

export function aiSdkToolToPromptTrailTool<TInput, TResult>(
  name: string,
  tool: AiSdkTool<TInput, TResult>,
): PromptTrailTool<TInput, TResult> {
  const record = tool as Record<string, unknown>;
  const parameters = record.parameters;
  if (!isZodSchema(parameters)) {
    throw new Error(
      `AI SDK tool "${name}" does not expose a Zod parameters schema.`,
    );
  }

  return {
    kind: 'tool',
    name,
    description:
      typeof record.description === 'string' ? record.description : '',
    inputSchema: parameters as z.ZodType<TInput>,
    execute: async (input, context) => {
      const execute = record.execute;
      if (typeof execute !== 'function') {
        throw new Error(
          `AI SDK tool "${name}" does not expose an execute handler.`,
        );
      }
      return execute(input, context.raw);
    },
  };
}

export function toAiSdkToolSet(
  tools: Record<string, unknown> | undefined,
  session?: Session<any, any>,
): ToolSet | undefined {
  if (!tools) {
    return undefined;
  }

  const toolSet: ToolSet = {};
  for (const [name, value] of Object.entries(tools)) {
    if (isPromptTrailTool(value)) {
      toolSet[name] = promptTrailToolToAiSdkTool(value, {
        session,
        provider: 'ai-sdk',
      });
      continue;
    }

    toolSet[name] = value as ToolSet[string];
  }

  return toolSet;
}

export async function executePromptTrailTool<TInput, TResult>(
  tool: PromptTrailTool<TInput, TResult>,
  input: TInput,
  context: ToolExecutionContext = {},
): Promise<CallToolResult> {
  try {
    const parsedInput = tool.inputSchema.parse(input);
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

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    'safeParse' in value &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
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
