// generate.ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  generateText as aiSdkGenerateText,
  streamText as aiSdkStreamText,
  LanguageModelV1,
  Output,
  ToolSet,
} from 'ai';
import { z } from 'zod';
import type { LLMOptions } from './content_source';
import type { Message } from './message';
import type { Session } from './session';
import { Attrs, Vars } from './tagged_record';

/**
 * Schema generation options
 */
export interface SchemaGenerationOptions {
  schema: z.ZodType;
  mode?: 'tool' | 'structured_output';
  functionName?: string;
}

/**
 * Convert Session to AI SDK compatible format
 */
export function convertSessionToAiSdkMessages(
  session: Session<any, any>,
): Array<{
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<unknown>;
}> {
  const messages: Array<{
    role: string;
    content: string;
    tool_call_id?: string;
    tool_calls?: Array<unknown>;
  }> = [];

  // Build a map of tool results by their tool call ID for easy lookup
  const toolResultsMap = new Map<string, string>();
  for (const msg of session.messages) {
    if (msg.type === 'tool_result') {
      const toolCallId = msg.attrs?.toolCallId as string;
      if (toolCallId) {
        toolResultsMap.set(toolCallId, msg.content);
      }
    }
  }

  // Process messages in order, but handle tool results immediately after their assistant message
  for (const msg of session.messages) {
    if (msg.type === 'system') {
      messages.push({ role: 'system', content: msg.content });
    } else if (msg.type === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.type === 'assistant') {
      const assistantMsg: {
        role: string;
        content: string;
        tool_calls?: Array<unknown>;
      } = {
        role: 'assistant',
        content: msg.content || ' ', // Ensure content is never empty for Anthropic compatibility
      };

      // Add tool calls if present
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }

      messages.push(assistantMsg);

      // Immediately add tool results for this assistant message
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const toolCall of msg.toolCalls) {
          const toolResult = toolResultsMap.get(toolCall.id);
          if (toolResult) {
            messages.push({
              role: 'tool',
              content: toolResult,
              tool_call_id: toolCall.id,
            });
          }
        }
      }
    }
    // Skip tool_result messages as they're handled above
  }

  return messages;
}

/**
 * Create a provider based on the LLMOptions
 */
export function createProvider(options: LLMOptions): LanguageModelV1 {
  const providerConfig = options.provider;
  const sdkProviderOptions: Record<string, unknown> = {}; // Options specifically for createOpenAI/createAnthropic

  if (providerConfig.type === 'openai') {
    if (providerConfig.baseURL) {
      sdkProviderOptions.baseURL = providerConfig.baseURL;
    }
    if (providerConfig.organization) {
      sdkProviderOptions.organization = providerConfig.organization;
    }
    sdkProviderOptions.apiKey = providerConfig.apiKey;
    // Pass browser flag if set
    if (options.dangerouslyAllowBrowser) {
      sdkProviderOptions.dangerouslyAllowBrowser = true;
    }

    const openai = createOpenAI(sdkProviderOptions);
    return openai(providerConfig.modelName);
  } else if (providerConfig.type === 'anthropic') {
    if (providerConfig.baseURL) {
      sdkProviderOptions.baseURL = providerConfig.baseURL;
    }
    sdkProviderOptions.apiKey = providerConfig.apiKey;
    // Pass browser flag if set (Anthropic might support this too)
    if (options.dangerouslyAllowBrowser) {
      sdkProviderOptions.dangerouslyAllowBrowser = true;
    }

    const anthropic = createAnthropic(sdkProviderOptions);
    return anthropic(providerConfig.modelName);
  } else if (providerConfig.type === 'google') {
    const googleSdkOptions: {
      apiKey?: string;
      baseURL?: string;
      dangerouslyAllowBrowser?: boolean;
    } = {};
    if (providerConfig.apiKey) {
      googleSdkOptions.apiKey = providerConfig.apiKey;
    }
    if (providerConfig.baseURL) {
      googleSdkOptions.baseURL = providerConfig.baseURL;
    }
    // Note: Check if @ai-sdk/google's createGoogleGenerativeAI supports dangerouslyAllowBrowser.
    // The documentation for @ai-sdk/google didn't explicitly list it for createGoogleGenerativeAI.
    // For now, assuming it might be a common option or handled by the core AI SDK.
    // If it causes issues, it should be removed for the Google provider.
    if (options.dangerouslyAllowBrowser) {
      // googleSdkOptions.dangerouslyAllowBrowser = true; // Temporarily commenting out until confirmed
    }

    const googleProvider = createGoogleGenerativeAI(googleSdkOptions);
    return googleProvider(providerConfig.modelName);
  }

  throw new Error(
    `Unsupported provider type: ${(providerConfig as { type: string }).type}`,
  );
}

/**
 * Generate text using AI SDK
 * This is our main adapter function that maps our stable interface to the current AI SDK
 */
export async function generateText<TVars extends Vars, TAttrs extends Attrs>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions,
): Promise<Message<TAttrs>> {
  // Convert session to AI SDK message format
  const messages = convertSessionToAiSdkMessages(session);

  // Create the provider
  const provider = createProvider(options);

  // Generate text using AI SDK
  const result = await aiSdkGenerateText({
    model: provider as LanguageModelV1,
    messages: messages as [],
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    tools: options.tools as ToolSet,
    toolChoice: options.toolChoice,
    ...options.sdkOptions,
  });

  // If there are tool calls, add them directly to the message
  if (result.toolCalls && result.toolCalls.length > 0) {
    const formattedToolCalls = result.toolCalls.map(
      (tc: {
        toolName?: string;
        name?: string;
        args?: Record<string, unknown>;
        arguments?: Record<string, unknown>;
        toolCallId?: string;
        id?: string;
      }) => ({
        name: tc.toolName || tc.name || '',
        arguments: tc.args || tc.arguments || {},
        id: tc.toolCallId || tc.id || crypto.randomUUID(),
      }),
    );

    // Ensure content is never empty for Anthropic compatibility
    const content = result.text || ' ';

    return {
      type: 'assistant',
      content: content,
      toolCalls: formattedToolCalls,
      toolResults: result.toolResults, // Include tool results from ai-sdk
    } as any;
  }

  return {
    type: 'assistant',
    content: result.text || ' ', // Ensure content is never empty for Anthropic compatibility
  };
}

/**
 * Generate structured content using schema
 */
export async function generateWithSchema<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions,
  schemaOptions: SchemaGenerationOptions,
): Promise<Message<TAttrs> & { structuredOutput?: unknown }> {
  const messages = convertSessionToAiSdkMessages(session);
  const provider = createProvider(options);

  if (schemaOptions.mode === 'structured_output') {
    // Use AI SDK's experimental_output for structured generation
    const result = await aiSdkGenerateText({
      model: provider as LanguageModelV1,
      messages: messages as [],
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      topK: options.topK,
      experimental_output: Output.object({
        schema: schemaOptions.schema,
      }),
      ...options.sdkOptions,
    });

    // Validate the structured output
    const parsedOutput = schemaOptions.schema.safeParse(
      result.experimental_output,
    );
    if (!parsedOutput.success) {
      throw new Error(
        `Schema validation failed: ${parsedOutput.error.message}`,
      );
    }

    return {
      type: 'assistant',
      content: JSON.stringify(parsedOutput.data, null, 2),
      structuredOutput: parsedOutput.data,
    };
  } else {
    // Use tool-based generation (existing SchemaSource logic)
    const functionName =
      schemaOptions.functionName || 'generateStructuredOutput';
    const toolOptions: LLMOptions = {
      ...options,
      tools: {
        ...options.tools,
        [functionName]: {
          name: functionName,
          description: 'Generate structured output according to schema',
          parameters: schemaOptions.schema,
        },
      },
      toolChoice: 'required',
    };

    const response = await generateText(session, toolOptions);

    if (response.toolCalls?.some((tc) => tc.name === functionName)) {
      const toolCall = response.toolCalls.find(
        (tc) => tc.name === functionName,
      );

      if (toolCall) {
        const result = schemaOptions.schema.safeParse(toolCall.arguments);
        if (result.success) {
          return {
            type: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
            structuredOutput: result.data,
          };
        } else {
          throw new Error(`Schema validation failed: ${result.error.message}`);
        }
      }
    }

    throw new Error('No valid schema tool call found in response');
  }
}

/**
 * Generate text stream using AI SDK
 */
export async function* generateTextStream<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions,
): AsyncGenerator<Message<TAttrs>, void, unknown> {
  // Convert session to AI SDK message format
  const messages = convertSessionToAiSdkMessages(session);

  // Create the provider
  const provider = createProvider(options);

  // Generate streaming text using AI SDK
  const stream = await aiSdkStreamText({
    model: provider as LanguageModelV1,
    messages: messages as [],
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    tools: options.tools as ToolSet,
    toolChoice: options.toolChoice,
    ...options.sdkOptions,
  });

  // Yield message chunks as they arrive
  for await (const chunk of stream.fullStream) {
    if (chunk.type === 'text-delta') {
      yield {
        type: 'assistant',
        content: chunk.textDelta || ' ', // Ensure content is never empty for Anthropic compatibility
      };
    } else if (chunk.type === 'tool-call') {
      // Add tool calls directly to the message
      const toolCall = {
        name: chunk.toolName,
        arguments: chunk.args || {},
        id: chunk.toolCallId || crypto.randomUUID(),
      };

      yield {
        type: 'assistant',
        content: ' ', // Ensure content is never empty for Anthropic compatibility
        toolCalls: [toolCall],
      };
    }
  }
}
