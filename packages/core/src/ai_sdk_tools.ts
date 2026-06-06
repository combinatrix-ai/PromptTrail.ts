import { tool as aiTool, type Tool as AiTool, type ToolSet } from 'ai';
import { z } from 'zod';
import type {
  CallToolResult,
  PromptTrailTool,
  ToolExecutionContext,
} from './capabilities';
import type { Session } from './session';
import { executePromptTrailTool, isPromptTrailTool } from './tool';

type AiSdkTool<TParams = any, TResult = any> = AiTool<
  z.ZodType<TParams>,
  TResult
>;

export function aiSdkToolToPromptTrailTool<TInput, TResult>(
  name: string,
  aiSdkTool: AiTool<any, TResult>,
): PromptTrailTool<TInput, TResult> {
  const parameters = getAiSdkToolParameters(aiSdkTool as AiTool<any, any>);
  if (!isZodType<TInput>(parameters)) {
    throw new Error(
      `ai-sdk tool "${name}" must use a Zod parameters schema to convert to PromptTrailTool.`,
    );
  }
  if (typeof aiSdkTool.execute !== 'function') {
    throw new Error(
      `ai-sdk tool "${name}" must include execute to convert to PromptTrailTool.`,
    );
  }

  return {
    kind: 'tool',
    name,
    description: aiSdkTool.description ?? name,
    inputSchema: parameters,
    execute: (input, context) =>
      Promise.resolve(
        aiSdkTool.execute!(input, {
          toolCallId: getAiSdkToolCallId(context),
          messages: [],
          abortSignal: getAiSdkAbortSignal(context),
        }),
      ),
  };
}

export function promptTrailToolToAiSdkTool<TInput, TResult>(
  promptTrailTool: PromptTrailTool<TInput, TResult>,
  context?: Omit<ToolExecutionContext, 'capability'>,
): AiSdkTool<TInput, CallToolResult> {
  return aiTool<z.ZodType<TInput>, CallToolResult>({
    description: promptTrailTool.description,
    parameters: promptTrailTool.inputSchema,
    execute: async (input, raw) =>
      executePromptTrailTool(promptTrailTool, input, {
        ...context,
        raw,
      }),
  });
}

export function toAiSdkToolSet(
  tools: Record<string, PromptTrailTool<any, any>> | undefined,
  context?: Omit<ToolExecutionContext, 'provider' | 'capability'> & {
    session?: Session<any, any>;
  },
): ToolSet | undefined {
  if (!tools) {
    return undefined;
  }

  const toolSet: ToolSet = {};
  for (const [name, value] of Object.entries(tools)) {
    if (!isPromptTrailTool(value)) {
      continue;
    }
    toolSet[name] = promptTrailToolToAiSdkTool(value, {
      ...context,
      provider: 'ai-sdk',
    });
  }

  return toolSet;
}

function getAiSdkToolParameters(tool: AiTool<any, any>): unknown {
  return (tool as { parameters?: unknown; inputSchema?: unknown }).parameters;
}

function isZodType<TInput>(value: unknown): value is z.ZodType<TInput> {
  return value instanceof z.ZodType;
}

function getAiSdkToolCallId(context: ToolExecutionContext): string {
  const raw = context.raw as Record<string, unknown> | undefined;
  if (typeof raw?.toolCallId === 'string') {
    return raw.toolCallId;
  }
  if (typeof raw?.id === 'string') {
    return raw.id;
  }
  return context.capability ?? 'prompttrail-tool-call';
}

function getAiSdkAbortSignal(
  context: ToolExecutionContext,
): AbortSignal | undefined {
  const raw = context.raw as Record<string, unknown> | undefined;
  return raw?.abortSignal instanceof AbortSignal ? raw.abortSignal : undefined;
}
