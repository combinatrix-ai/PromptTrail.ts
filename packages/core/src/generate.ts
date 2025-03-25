import {
  generateText as aiSdkGenerateText,
  streamText as aiSdkStreamText,
  experimental_createMCPClient,
} from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import type { Message, Session } from './types';
import { createMetadata } from './metadata';
import type { AssistantMetadata } from './types';

/**
 * Provider types
 */
export type OpenAIProviderConfig = {
  type: 'openai';
  apiKey: string;
  modelName: string;
  baseURL?: string;
  organization?: string;
  dangerouslyAllowBrowser?: boolean;
};

export type AnthropicProviderConfig = {
  type: 'anthropic';
  apiKey: string;
  modelName: string;
  baseURL?: string;
};

export type ProviderConfig = OpenAIProviderConfig | AnthropicProviderConfig;

/**
 * MCP Server configuration for generate
 */
export interface GenerateMCPServerConfig {
  url: string;
  name: string;
  version: string;
}

/**
 * MCP Transport interface for generate
 */
export interface GenerateMCPTransport {
  send(message: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Convert Session to AI SDK compatible format
 */
function convertSessionToMessages(
  session: Session,
): Array<{
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<any>;
}> {
  const messages: Array<{
    role: string;
    content: string;
    tool_call_id?: string;
    tool_calls?: Array<any>;
  }> = [];

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
        tool_calls?: Array<any>;
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
function createProvider(config: ProviderConfig): unknown {
  if (config.type === 'openai') {
    const options: Record<string, unknown> = {};

    if (config.baseURL) {
      options.baseURL = config.baseURL;
    }

    if (config.organization) {
      options.organization = config.organization;
    }

    return openai(config.modelName, options);
  } else if (config.type === 'anthropic') {
    const options: Record<string, unknown> = {};

    if (config.baseURL) {
      options.baseURL = config.baseURL;
    }

    return anthropic(config.modelName, options);
  }

  throw new Error(`Unsupported provider type: ${(config as any).type}`);
}

/**
 * Initialize MCP client
 */
async function initializeMCPClient(
  config: GenerateMCPServerConfig,
): Promise<unknown> {
  try {
    // This is a simplified implementation
    // In a real implementation, we would need to create the appropriate transport
    const transport = {} as GenerateMCPTransport;

    // Initialize MCP client
    // Use any to bypass type checking for MCP client
    const mcpClient = await (experimental_createMCPClient as any)({
      transport: transport as any,
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
  session: Session,
  options: any, // Using any temporarily to avoid circular dependency
): Promise<Message> {
  // Convert session to AI SDK message format
  const messages = convertSessionToMessages(session);

  // Create the provider
  const provider = createProvider(options.provider);

  // Handle MCP tools if configured
  if (options.mcpServers && options.mcpServers.length > 0) {
    // In a real implementation, we would initialize MCP clients and get tools
    // For now, we'll just log a message
    console.log(
      `MCP servers configured: ${options.mcpServers.map((s: any) => s.name).join(', ')}`,
    );
  }

  // Generate text using AI SDK
  const result = await aiSdkGenerateText({
    model: provider as any,
    messages: messages as [], // Type assertion for AI SDK compatibility
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    tools: options.tools, // Use tools directly from options
    toolChoice: options.toolChoice,
    ...options.sdkOptions,
  });

  // Create metadata for the response
  const metadata = createMetadata<AssistantMetadata>();

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
  session: Session,
  options: any, // Using any temporarily to avoid circular dependency
): AsyncGenerator<Message, void, unknown> {
  // Convert session to AI SDK message format
  const messages = convertSessionToMessages(session);

  // Create the provider
  const provider = createProvider(options.provider);

  // Generate streaming text using AI SDK
  const stream = await aiSdkStreamText({
    model: provider as any,
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
