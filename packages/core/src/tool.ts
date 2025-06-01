// tool.ts
import { tool as aiTool, type Tool as AiTool } from 'ai';
import { z } from 'zod';

/**
 * Type for AI SDK tools
 */
export type Tool<TParams = any, TResult = any> = AiTool<TParams, TResult>;

/**
 * Tool namespace for creating tools in PromptTrail style
 */
export namespace Tool {
  /**
   * Create a new tool using ai-sdk's tool function
   * This provides a consistent API with other PromptTrail components
   *
   * @example
   * ```typescript
   * const weatherTool = Tool.create({
   *   description: 'Get weather information',
   *   parameters: z.object({
   *     location: z.string().describe('City name'),
   *   }),
   *   execute: async ({ location }) => {
   *     return { temperature: 72, condition: 'sunny' };
   *   }
   * });
   * ```
   */
  export function create<TParams, TResult>(config: {
    description: string;
    parameters: z.ZodType<TParams>;
    execute: (input: TParams) => Promise<TResult>;
  }): Tool<TParams, TResult> {
    return aiTool(config);
  }
}
