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
