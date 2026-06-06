import { tool as aiTool, type Tool as AiTool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { PromptTrailTool, ToolExecutionContext } from './capabilities';
import type { Session } from './session';
import { isPromptTrailTool } from './tool';

type AiSdkTool<TParams = any, TResult = any> = AiTool<
  z.ZodType<TParams>,
  TResult
>;

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

export function toAiSdkToolSet(
  tools: Record<string, PromptTrailTool<any, any>> | undefined,
  session?: Session<any, any>,
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
      session,
      provider: 'ai-sdk',
    });
  }

  return toolSet;
}
