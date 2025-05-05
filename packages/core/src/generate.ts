import {
  generateText as aiSdkGenerateText,
  streamText as aiSdkStreamText,
  experimental_createMCPClient,
  LanguageModelV1,
  ToolSet,
} from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { Session } from './session';
import type { Message } from './message';
import { Context, Metadata } from './tagged_record';
import type {
  GenerateOptions,
  MCPServerConfig,
  ProviderConfig,
} from './generate_options';

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
        toolCallId: (msg.metadata?.toolCallId as string) || crypto.randomUUID(),
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
 * Create a provider based on the full GenerateOptions
 */
export function createProvider(options: GenerateOptions): LanguageModelV1 {
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
  }

  throw new Error(
    `Unsupported provider type: ${(providerConfig as { type: string }).type}`, // Fix typo: use providerConfig
  );
}

/**
 * Initialize MCP client
 */
async function initializeMCPClient(config: MCPServerConfig): Promise<unknown> {
  try {
    // Add 'type: 'mcp'' based on MCPServerConfig definition
    const transport = {
      type: 'mcp' as const, // Use 'mcp' literal type
      url: config.url,
      name: config.name || 'prompttrail-mcp-client',
      version: config.version || '1.0.0',
      headers: config.headers || {},
    };

    // Cast transport to 'any' to bypass potential type definition issues in ai-sdk
    const mcpClient = await experimental_createMCPClient({
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
export async function generateText<
  TContext extends Context,
  TMetadata extends Metadata,
>(
  session: Session<TContext, TMetadata>,
  options: GenerateOptions,
): Promise<Message<TMetadata>> {
  // Convert session to AI SDK message format
  const messages = convertSessionToAiSdkMessages(session);

  // Create the provider
  const provider = createProvider(options); // Pass the full options object

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
    model: provider as LanguageModelV1,
    messages: messages as [],
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    tools: options.tools as ToolSet,
    toolChoice: options.toolChoice,
    // Pass the initialized MCP clients to the AI SDK
    ...(mcpClients.length > 0 && { mcpClients }),
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
      metadata: undefined,
      toolCalls: formattedToolCalls,
    };
  }

  return {
    type: 'assistant',
    content: result.text || ' ', // Ensure content is never empty for Anthropic compatibility
    metadata: undefined,
  };
}

/**
 * Generate text stream using AI SDK
 */
export async function* generateTextStream<
  TContext extends Context,
  TMetadata extends Metadata,
>(
  session: Session<TContext, TMetadata>,
  options: GenerateOptions, // Fixed type to match generateText
): AsyncGenerator<Message<TMetadata>, void, unknown> {
  // Convert session to AI SDK message format
  const messages = convertSessionToAiSdkMessages(session);

  // Create the provider
  const provider = createProvider(options); // Pass the full options object

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
        metadata: undefined,
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
        metadata: undefined,
        toolCalls: [toolCall],
      };
    }
  }
}
