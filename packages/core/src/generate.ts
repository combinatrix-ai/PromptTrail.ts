import {
  generateText as aiSdkGenerateText,
  streamText as aiSdkStreamText,
  experimental_createMCPClient,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type {
  TMessage,
  ISession,
  TProviderConfig,
  IMCPServerConfig,
} from './types';
import { createMetadata } from './metadata';
import type { GenerateOptions } from './generate_options';

/**
 * Convert Session to AI SDK compatible format
 */
function convertSessionToAiSdkMessages(session: ISession): Array<{
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

  // TODO: Check this implementation is sane?
  // Filter out tool_result messages for now, as AI SDK doesn't support them directly
  // We'll handle them separately
  const toolResults: Array<{ content: string; toolCallId: string }> = [];

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
    } else if (msg.type === 'tool_result') {
      // Store tool results to process later
      toolResults.push({
        content: msg.content,
        toolCallId:
          (msg.metadata?.get('toolCallId') as string) || crypto.randomUUID(),
      });
    }
  }

  // Process tool results
  if (toolResults.length > 0) {
    for (const result of toolResults) {
      messages.push({
        role: 'tool',
        content: result.content,
        tool_call_id: result.toolCallId,
      });
    }
  }

  return messages;
}

/**
 * Create a provider based on configuration
 */
function createProvider(config: TProviderConfig): unknown {
  const options: Record<string, unknown> = {};
  if (config.type === 'openai') {
    if (config.baseURL) {
      options.baseURL = config.baseURL;
    }
    if (config.organization) {
      options.organization = config.organization;
    }

    options.apiKey = config.apiKey;

    const openai = createOpenAI(options);

    return openai(config.modelName);
  } else if (config.type === 'anthropic') {
    if (config.baseURL) {
      options.baseURL = config.baseURL;
    }

    options.apiKey = config.apiKey;

    const anthropic = createAnthropic(options);

    return anthropic(config.modelName, options);
  }

  throw new Error(
    `Unsupported provider type: ${(config as { type: string }).type}`,
  );
}

/**
 * Initialize MCP client
 */
async function initializeMCPClient(config: IMCPServerConfig): Promise<unknown> {
  try {
    const transport = {
      url: config.url,
      name: config.name || 'prompttrail-mcp-client',
      version: config.version || '1.0.0',
      headers: config.headers || {},
    };

    const mcpClient = await experimental_createMCPClient({
      transport,
    });

    return mcpClient;
  } catch (error) {
    console.error(`Failed to initialize MCP client for ${config.name}:`, error);
    throw error;
  }
}

/**
 * Generate text using AI SDK
 * This is our main adapter function that maps our stable interface to the current AI SDK
 */
export async function generateText(
  session: ISession,
  options: GenerateOptions,
): Promise<TMessage> {
  // Convert session to AI SDK message format
  const messages = convertSessionToAiSdkMessages(session);

  // Create the provider
  const provider = createProvider(options.provider);

  // Handle MCP tools if configured
  const mcpClients = [];
  if (options.mcpServers && options.mcpServers.length > 0) {
    for (const server of options.mcpServers) {
      try {
        const mcpClient = await initializeMCPClient(server);
        mcpClients.push(mcpClient);
      } catch (error) {
        console.error(
          `Failed to initialize MCP client for ${server.name}:`,
          error,
        );
      }
    }
  }

  // Generate text using AI SDK
  const result = await aiSdkGenerateText({
    model: provider as unknown,
    messages: messages as [], // Type assertion for AI SDK compatibility
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    tools: options.tools as unknown, // TODO: Fix this assertion
    toolChoice: options.toolChoice,
    ...options.sdkOptions,
  });

  // Create metadata for the response
  const metadata = createMetadata();

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
      metadata,
      toolCalls: formattedToolCalls,
    };
  }

  return {
    type: 'assistant',
    content: result.text || ' ', // Ensure content is never empty for Anthropic compatibility
    metadata,
  };
}

/**
 * Generate text stream using AI SDK
 */
export async function* generateTextStream(
  session: ISession,
  options: GenerateOptions, // Fixed type to match generateText
): AsyncGenerator<TMessage, void, unknown> {
  // Convert session to AI SDK message format
  const messages = convertSessionToAiSdkMessages(session);

  // Create the provider
  const provider = createProvider(options.provider);

  // Generate streaming text using AI SDK
  const stream = await aiSdkStreamText({
    model: provider as unknown,
    messages: messages as [], // Type assertion for AI SDK compatibility
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    tools: options.tools, // Use tools directly from options
    toolChoice: options.toolChoice,
    ...options.sdkOptions,
  });

  // Yield message chunks as they arrive
  for await (const chunk of stream.fullStream) {
    if (chunk.type === 'text-delta') {
      yield {
        type: 'assistant',
        content: chunk.textDelta || ' ', // Ensure content is never empty for Anthropic compatibility
        metadata: createMetadata(),
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
        metadata: createMetadata(),
        toolCalls: [toolCall],
      };
    }
  }
}
