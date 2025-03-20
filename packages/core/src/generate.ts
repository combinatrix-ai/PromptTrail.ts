import { 
  generateText as aiSdkGenerateText, 
  streamText as aiSdkStreamText, 
  tool as createAISDKTool,
  experimental_createMCPClient
} from 'ai';
// Define ToolSet type since it's not exported from 'ai'
type ToolSet = Record<string, unknown>;
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { Message, Session, Tool, SchemaType } from './types';
import { createMetadata } from './metadata';
import type { AssistantMetadata, ToolResultMetadata } from './types';
import type { InferSchemaType } from './tool';

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
 * Generate options interface
 * This is our stable public API that won't change even if AI SDK changes
 */
export interface GenerateOptions {
  // Core provider configuration
  provider: ProviderConfig;
  
  // Common generation parameters
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  
  // Tool support
  tools?: Tool<SchemaType>[];
  toolChoice?: 'auto' | 'required' | 'none';
  
  // MCP support
  mcpServers?: GenerateMCPServerConfig[];
  
  // Extension point for future options without breaking changes
  sdkOptions?: Record<string, unknown>;
}

/**
 * Convert Session to AI SDK compatible format
 */
function convertSessionToMessages(session: Session): Array<{ role: string; content: string; tool_call_id?: string }> {
  const messages: Array<{ role: string; content: string; tool_call_id?: string }> = [];
  
  // Filter out tool_result messages for now, as AI SDK doesn't support them directly
  // We'll handle them separately
  const toolResults: Array<{ content: string; toolCallId: string }> = [];
  
  for (const msg of session.messages) {
    if (msg.type === 'system') {
      messages.push({ role: 'system', content: msg.content });
    } else if (msg.type === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.type === 'assistant') {
      messages.push({ role: 'assistant', content: msg.content });
    } else if (msg.type === 'tool_result') {
      // Store tool results to process later
      toolResults.push({ 
        content: msg.content,
        toolCallId: msg.metadata?.get('toolCallId') as string || crypto.randomUUID()
      });
    }
  }
  
  // For now, we'll skip tool results as AI SDK doesn't support them directly
  // In a real implementation, we would need to handle them differently
  
  return messages;
}

/**
 * Format a tool for AI SDK
 */
function formatTool(tool: Tool<SchemaType>): Record<string, unknown> {
  // Convert our tool schema to zod schema
  const properties = tool.schema.properties;
  
  // Create an object shape for Zod
  const shape: Record<string, z.ZodTypeAny> = {};
  
  for (const [key, prop] of Object.entries(properties)) {
    const propObj = prop as { type: string; description?: string; properties?: Record<string, unknown>; required?: string[] };
    
    if (propObj.type === 'string') {
      shape[key] = z.string().describe(propObj.description || '');
    } else if (propObj.type === 'number') {
      shape[key] = z.number().describe(propObj.description || '');
    } else if (propObj.type === 'boolean') {
      shape[key] = z.boolean().describe(propObj.description || '');
    } else if (propObj.type === 'object' && propObj.properties) {
      // Handle nested objects (simplified implementation)
      shape[key] = z.object({}).describe(propObj.description || '');
    } else if (propObj.type === 'array') {
      // Handle arrays (simplified implementation)
      shape[key] = z.array(z.unknown()).describe(propObj.description || '');
    }
  }
  
  // Create Zod schema with required fields
  const zodSchema = z.object(shape);
  if (tool.schema.required && tool.schema.required.length > 0) {
    // Mark required fields
    for (const key of tool.schema.required) {
      if (shape[key]) {
        shape[key] = shape[key].optional().unwrap();
      }
    }
  }
  
  // Create the AI SDK tool definition
  const aiTool = createAISDKTool({
    description: tool.description,
    parameters: zodSchema,
    execute: async (params: Record<string, unknown>) => {
      try {
        const result = await tool.execute(params as InferSchemaType<SchemaType>);
        return result.result;
      } catch (error) {
        console.error(`Error executing tool ${tool.name}:`, error);
        throw error;
      }
    }
  });
  
  // Return tool in AI SDK format
  return {
    [tool.name]: aiTool
  };
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
async function initializeMCPClient(config: GenerateMCPServerConfig): Promise<unknown> {
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
 * Format tools for AI SDK
 */
function formatTools(tools?: Tool<SchemaType>[]): ToolSet | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  
  const toolsMap: Record<string, unknown> = {};
  
  for (const tool of tools) {
    Object.assign(toolsMap, formatTool(tool));
  }
  
  return toolsMap as unknown as ToolSet;
}

/**
 * Generate text using AI SDK
 * This is our main adapter function that maps our stable interface to the current AI SDK
 */
export async function generateText(
  session: Session,
  options: GenerateOptions
): Promise<Message> {
  // Convert session to AI SDK message format
  const messages = convertSessionToMessages(session);
  
  // Create the provider
  const provider = createProvider(options.provider);
  
  // Format tools if provided
  const formattedTools = formatTools(options.tools);
  
  // Handle MCP tools if configured
  // This is a simplified implementation
  let mcpTools: Record<string, unknown> = {};
  if (options.mcpServers && options.mcpServers.length > 0) {
    // In a real implementation, we would initialize MCP clients and get tools
    // For now, we'll just log a message
    console.log(`MCP servers configured: ${options.mcpServers.map(s => s.name).join(', ')}`);
  }
  
  // Combine regular tools and MCP tools
  const tools = formattedTools;
  
  // Generate text using AI SDK
  // Use any to bypass type checking for AI SDK
  const result = await aiSdkGenerateText({
    model: provider as any,
    messages: messages as [], // Type assertion for AI SDK compatibility
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    tools: tools as any,
    toolChoice: options.toolChoice,
    ...options.sdkOptions,
  });
  
  // Create metadata for the response
  const metadata = createMetadata<AssistantMetadata>();
  
  // If there are tool calls, add them to metadata
  if (result.toolCalls && result.toolCalls.length > 0) {
    metadata.set('toolCalls', result.toolCalls.map((tc: { toolName?: string; name?: string; args?: Record<string, unknown>; arguments?: Record<string, unknown>; toolCallId?: string; id?: string }) => ({
      name: tc.toolName || tc.name || '',
      arguments: tc.args || tc.arguments || {},
      id: tc.toolCallId || tc.id || crypto.randomUUID(),
    })));
  }
  
  return {
    type: 'assistant',
    content: result.text,
    metadata,
  };
}

/**
 * Generate text stream using AI SDK
 */
export async function* generateTextStream(
  session: Session,
  options: GenerateOptions
): AsyncGenerator<Message, void, unknown> {
  // Convert session to AI SDK message format
  const messages = convertSessionToMessages(session);
  
  // Create the provider
  const provider = createProvider(options.provider);
  
  // Format tools if provided
  const formattedTools = formatTools(options.tools);
  
  // Generate streaming text using AI SDK
  // Use any to bypass type checking for AI SDK
  const stream = await aiSdkStreamText({
    model: provider as any,
    messages: messages as [], // Type assertion for AI SDK compatibility
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    tools: formattedTools as any,
    ...options.sdkOptions,
  });
  
  // Yield message chunks as they arrive
  for await (const chunk of stream.fullStream) {
    if (chunk.type === 'text-delta') {
      yield {
        type: 'assistant',
        content: chunk.textDelta,
        metadata: createMetadata(),
      };
    } else if (chunk.type === 'tool-call') {
      // Create a metadata object for tool calls
      const metadata = createMetadata<AssistantMetadata>();
      metadata.set('toolCalls', [{
        name: chunk.toolName,
        arguments: chunk.args || {},
        id: chunk.toolCallId || crypto.randomUUID(),
      }]);
      
      yield {
        type: 'assistant',
        content: '',
        metadata,
      };
    }
  }
}
