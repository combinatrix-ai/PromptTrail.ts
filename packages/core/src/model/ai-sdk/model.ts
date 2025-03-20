import { generateText, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { Message, Session, Tool, ModelConfig, SchemaType } from '../../types';
import { Model } from '../base';
import { createMetadata } from '../../metadata';
import type { AssistantMetadata } from '../../types';
import type { InferSchemaType } from '../../tool';

/**
 * AI SDK provider types
 */
export enum AIProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
}

/**
 * AI SDK model configuration
 */
export interface AISDKConfig extends ModelConfig {
  provider: AIProvider;
  apiKey: string;
  apiBase?: string;
  organizationId?: string;
}

// Type for AI SDK tool format
type AISDKToolFormat = Record<string, unknown>;

/**
 * Model implementation using AI SDK
 */
export class AISDKModel extends Model<AISDKConfig, AISDKToolFormat> {
  constructor(config: AISDKConfig) {
    super(config);
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
    // Create provider-specific options
    const options: Record<string, unknown> = {
      apiKey: this.config.apiKey,
    };
    
    if (this.config.apiBase) {
      options.baseURL = this.config.apiBase;
    }
    
    switch (this.config.provider) {
      case AIProvider.OPENAI:
        if (this.config.organizationId) {
          options.organization = this.config.organizationId;
        }
        return openai(this.config.modelName, options as any);
      case AIProvider.ANTHROPIC:
        return anthropic(this.config.modelName, options as any);
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }
  
  /**
   * Convert Session to AI SDK compatible format
   */
  private convertSessionToMessages(session: Session) {
    // Convert our session messages to AI SDK format
    const messages: any[] = [];
    
    for (const msg of session.messages) {
      if (msg.type === 'system') {
        messages.push({ role: 'system', content: msg.content });
      } else if (msg.type === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.type === 'assistant') {
        messages.push({ role: 'assistant', content: msg.content });
      }
      // Skip other message types
    }
    
    return messages;
  }
  
  /**
   * Format a tool for AI SDK
   */
  protected formatTool(tool: Tool<SchemaType>): AISDKToolFormat {
    // Convert our tool schema to zod schema
    const properties = tool.schema.properties;
    
    // Create an object shape for Zod
    const shape: Record<string, z.ZodTypeAny> = {};
    
    for (const [key, prop] of Object.entries(properties)) {
      if (prop.type === 'string') {
        shape[key] = z.string().describe(prop.description);
      } else if (prop.type === 'number') {
        shape[key] = z.number().describe(prop.description);
      } else if (prop.type === 'boolean') {
        shape[key] = z.boolean().describe(prop.description);
      }
    }
    
    // Create Zod schema with required fields
    const zodSchema = z.object(shape);
    
    // Create the AI SDK tool definition
    const aiTool = {
      description: tool.description,
      parameters: zodSchema,
      execute: async (params: Record<string, unknown>) => {
        const result = await tool.execute(params as any);
        return result.result;
      }
    };
    
    // Return tool in AI SDK format
    return {
      [tool.name]: aiTool
    };
  }
  
  /**
   * Send a message to the model and get a response
   */
  async send(session: Session): Promise<Message> {
    const messages = this.convertSessionToMessages(session);
    const provider = this.getProvider();
    
    // Format tools if provided
    const tools: AISDKToolFormat = {};
    if (this.config.tools && this.config.tools.length > 0) {
      for (const t of this.config.tools) {
        Object.assign(tools, this.formatTool(t));
      }
    }
    
    // Generate text using AI SDK
    const result = await generateText({
      model: provider,
      messages: messages as any,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      tools: Object.keys(tools).length > 0 ? tools as any : undefined,
    });
    
    // Create metadata for the response
    const metadata = createMetadata<AssistantMetadata>();
    
    // If there are tool calls, add them to metadata
    if (result.toolCalls && result.toolCalls.length > 0) {
      metadata.set('toolCalls', result.toolCalls.map((tc: any) => ({
        name: tc.toolName || tc.name,
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
    
    // Generate streaming text using AI SDK
    const stream = await streamText({
      model: provider,
      messages: messages as any,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    });
    
    // Yield message chunks as they arrive
    for await (const chunk of stream.fullStream) {
      if (chunk.type === 'text-delta') {
        yield {
          type: 'assistant',
          content: chunk.textDelta,
          metadata: createMetadata(),
        };
      }
    }
  }
}
