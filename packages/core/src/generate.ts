import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  generateText as aiSdkGenerateText,
  streamText as aiSdkStreamText,
  LanguageModelV1,
  Output,
  ToolSet,
  tool as aiTool,
} from 'ai';
import { z } from 'zod';
import type { Message } from './message';
import type { Session, Attrs, Vars } from './session';
import type { LLMOptions } from './source';

export interface SchemaGenerationOptions {
  schema: z.ZodType;
  mode?: 'tool' | 'structured_output';
  functionName?: string;
}

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

  const toolResultsMap = new Map<string, string>();
  for (const msg of session.messages) {
    if (msg.type === 'tool_result') {
      const toolCallId = msg.attrs?.toolCallId as string;
      if (toolCallId) {
        toolResultsMap.set(toolCallId, msg.content);
      }
    }
  }

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
        content: msg.content || ' ',
      };

      if (msg.toolCalls?.length) {
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

      if (msg.toolCalls?.length) {
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
  }

  return messages;
}

export function createProvider(options: LLMOptions): LanguageModelV1 {
  const providerConfig = options.provider;
  const sdkProviderOptions: Record<string, unknown> = {};

  if (providerConfig.type === 'openai') {
    Object.assign(sdkProviderOptions, {
      apiKey: providerConfig.apiKey,
      ...(providerConfig.baseURL && { baseURL: providerConfig.baseURL }),
      ...(providerConfig.organization && {
        organization: providerConfig.organization,
      }),
      ...(options.dangerouslyAllowBrowser && { dangerouslyAllowBrowser: true }),
    });

    const openai = createOpenAI(sdkProviderOptions);
    return openai(providerConfig.modelName);
  } else if (providerConfig.type === 'anthropic') {
    Object.assign(sdkProviderOptions, {
      apiKey: providerConfig.apiKey,
      ...(providerConfig.baseURL && { baseURL: providerConfig.baseURL }),
      ...(options.dangerouslyAllowBrowser && { dangerouslyAllowBrowser: true }),
    });

    const anthropic = createAnthropic(sdkProviderOptions);
    return anthropic(providerConfig.modelName);
  } else if (providerConfig.type === 'google') {
    const googleSdkOptions: Record<string, unknown> = {
      ...(providerConfig.apiKey && { apiKey: providerConfig.apiKey }),
      ...(providerConfig.baseURL && { baseURL: providerConfig.baseURL }),
    };

    const googleProvider = createGoogleGenerativeAI(googleSdkOptions);
    return googleProvider(providerConfig.modelName);
  }

  throw new Error(
    `Unsupported provider type: ${(providerConfig as { type: string }).type}`,
  );
}

export async function generateText<TVars extends Vars, TAttrs extends Attrs>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions,
): Promise<Message<TAttrs>> {
  const messages = convertSessionToAiSdkMessages(session);
  const provider = createProvider(options);

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

  if (result.toolCalls?.length) {
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

    return {
      type: 'assistant',
      content: result.text || ' ',
      toolCalls: formattedToolCalls,
      toolResults: result.toolResults,
    } as any;
  }

  return {
    type: 'assistant',
    content: result.text || ' ',
  };
}

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
    const functionName =
      schemaOptions.functionName || 'generateStructuredOutput';
    const schemaToolDefinition = aiTool({
      description: 'Generate structured output according to schema',
      parameters: schemaOptions.schema,
    });
    const toolOptions: LLMOptions = {
      ...options,
      tools: {
        ...options.tools,
        [functionName]: schemaToolDefinition,
      },
      toolChoice: 'required',
    };

    const response = await generateText(session, toolOptions);

    const toolCall = response.toolCalls?.find((tc) => tc.name === functionName);

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

    throw new Error('No valid schema tool call found in response');
  }
}

export async function* generateTextStream<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions,
): AsyncGenerator<Message<TAttrs>, void, unknown> {
  const messages = convertSessionToAiSdkMessages(session);
  const provider = createProvider(options);

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

  for await (const chunk of stream.fullStream) {
    if (chunk.type === 'text-delta') {
      yield {
        type: 'assistant',
        content: chunk.textDelta || ' ',
      };
    } else if (chunk.type === 'tool-call') {
      const toolCall = {
        name: chunk.toolName,
        arguments: chunk.args || {},
        id: chunk.toolCallId || crypto.randomUUID(),
      };

      yield {
        type: 'assistant',
        content: ' ',
        toolCalls: [toolCall],
      };
    }
  }
}
