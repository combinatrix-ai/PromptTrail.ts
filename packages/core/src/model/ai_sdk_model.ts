import { 
  generateText, 
  streamText, 
  tool as createAISDKTool, 
  experimental_createMCPClient,
  type ToolSet
} from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { Message, Session, Tool, ModelConfig, SchemaType } from '../types';
import { Model } from './base';
import { createMetadata } from '../metadata';
import type { AssistantMetadata } from '../types';
import type { InferSchemaType } from '../tool';

/**
 * AI SDK provider types
 */
export enum AIProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
}

/**
 * MCP Transport type
 * This is a simplified version of the AI SDK's MCPTransport
 */
export interface MCPTransport {
  send(message: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * MCP Configuration
 */
export interface MCPConfig {
  transport: unknown; // Using unknown to match AI SDK's expected type
}

/**
 * Model configuration for AI SDK
 */
export interface AISDKModelConfig extends ModelConfig {
  provider: AIProvider;
  apiKey: string;
  apiBase?: string;
  organizationId?: string;
  
  // AI SDK specific options that can be passed to generateText
  maxSteps?: number;
  experimental_continueSteps?: boolean;
  toolChoice?: 'auto' | 'required' | 'none';
  
  // MCP configuration
  mcpConfig?: MCPConfig;
}

/**
 * Unified Model implementation using AI SDK
 */
export class AISDKModel extends Model<AISDKModelConfig> {
  private mcpClient: unknown = null;
  private mcpTools: Record<string, unknown> = {};
  
  constructor(config: AISDKModelConfig) {
    super(config);
    
    // Initialize MCP client if configured
    if (config.mcpConfig) {
      this.initMCPClient(config.mcpConfig);
    }
  }
  
  /**
   * Initialize MCP client
   */
  private async initMCPClient(mcpConfig: MCPConfig): Promise<void> {
    try {
      // Cast the entire config object to avoid type issues with AI SDK's transport types
      // Use type assertion to work around AI SDK type issues
      this.mcpClient = await (experimental_createMCPClient as unknown as (config: { transport: unknown }) => Promise<unknown>)({
        transport: mcpConfig.transport,
      });
      
      // Load tools from MCP client
      const tools = await (this.mcpClient as { tools(): Promise<Record<string, unknown>> }).tools();
      this.mcpTools = tools;
    } catch (error) {
      console.error('Failed to initialize MCP client:', error);
    }
  }
  
  protected validateConfig(): void {
    if (!this.config.provider) {
      throw new Error('Provider is required for AISDKModel');
    }
    if (!this.config.apiKey) {
      throw new Error('API key is required for AISDKModel');
    }
    if (!this.config.modelName) {
      throw new Error('Model name is required for AISDKModel');
    }
  }
  
  /**
   * Get the AI SDK provider implementation based on config
   */
  private getProvider() {
    switch (this.config.provider) {
      case AIProvider.OPENAI: {
        // For OpenAI
        const options: Record<string, unknown> = {};
        
        if (this.config.apiBase) {
          options.baseURL = this.config.apiBase;
        }
        
        if (this.config.organizationId) {
          options.organization = this.config.organizationId;
        }
        
        // Create OpenAI provider
        return openai(this.config.modelName, options);
      }
      case AIProvider.ANTHROPIC: {
        // For Anthropic
        const options: Record<string, unknown> = {};
        
        if (this.config.apiBase) {
          options.baseURL = this.config.apiBase;
        }
        
        // Create Anthropic provider
        return anthropic(this.config.modelName, options);
      }
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }
  
  /**
   * Convert Session to AI SDK compatible format
   */
  private convertSessionToMessages(session: Session) {
    // Convert our session messages to AI SDK format
    const messages: Array<{ role: string; content: string; tool_call_id?: string }> = [];
    
    for (const msg of session.messages) {
      if (msg.type === 'system') {
        messages.push({ role: 'system', content: msg.content });
      } else if (msg.type === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.type === 'assistant') {
        messages.push({ role: 'assistant', content: msg.content });
      } else if (msg.type === 'tool_result') {
        // For tool results, we need to use the correct format for AI SDK
        messages.push({ 
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.metadata?.get('toolCallId') as string || crypto.randomUUID()
        });
      }
    }
    
    return messages;
  }
  
  /**
   * Format a tool for AI SDK
   */
  protected formatTool(tool: Tool<SchemaType>): unknown {
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
   * Get all tools including MCP tools
   */
  private getAllTools(): ToolSet | undefined {
    const tools: Record<string, unknown> = {};
    
    // Add configured tools
    if (this.config.tools && this.config.tools.length > 0) {
      for (const t of this.config.tools) {
        Object.assign(tools, this.formatTool(t));
      }
    }
    
    // Add MCP tools if available
    if (this.mcpTools && Object.keys(this.mcpTools).length > 0) {
      Object.assign(tools, this.mcpTools);
    }
    
    return Object.keys(tools).length > 0 ? tools as unknown as ToolSet : undefined;
  }
  
  /**
   * Send a message to the model and get a response
   */
  async send(session: Session): Promise<Message> {
    const messages = this.convertSessionToMessages(session);
    const provider = this.getProvider();
    
    // Get all tools including MCP tools
    const tools = this.getAllTools();
    
    // Generate text using AI SDK
    const result = await generateText({
      model: provider,
      messages: messages as [], // Type assertion to avoid AI SDK type issues
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      topP: this.config.topP,
      topK: this.config.topK,
      tools,
      maxSteps: this.config.maxSteps,
      experimental_continueSteps: this.config.experimental_continueSteps,
      toolChoice: this.config.toolChoice,
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
   * Send a message to the model and get streaming responses
   */
  async *sendAsync(session: Session): AsyncGenerator<Message, void, unknown> {
    const messages = this.convertSessionToMessages(session);
    const provider = this.getProvider();
    
    // Get all tools including MCP tools
    const tools = this.getAllTools();
    
    // Generate streaming text using AI SDK
    const stream = await streamText({
      model: provider,
      messages: messages as [], // Type assertion to avoid AI SDK type issues
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      topP: this.config.topP,
      topK: this.config.topK,
      tools,
      maxSteps: this.config.maxSteps,
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
  
  /**
   * Close MCP client when model is no longer needed
   */
  async close(): Promise<void> {
    if (this.mcpClient) {
      await (this.mcpClient as { close(): Promise<void> }).close();
      this.mcpClient = null;
    }
  }
}
