import { z } from 'zod';
import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import type { Session } from '../session';
import type { Model } from '../model/base';
import type { SchemaType } from '../tool';
import { createMetadata } from '../metadata';
import { Template } from '../templates';
import { AISDKModel, AIProvider } from '../model/ai-sdk/model';

/**
 * Template that enforces structured output using AI SDK
 */
export class AISDKSchemaTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput & {
    structured_output: Record<string, unknown>;
  },
> extends Template<TInput, TOutput> {
  private schema: z.ZodType;
  private schemaDescription: string;
  
  constructor(options: {
    model: Model;
    schema: SchemaType | z.ZodType;
    schemaDescription?: string;
  }) {
    super({ model: options.model });
    
    // Convert schema to Zod schema if it's not already
    if ('properties' in options.schema) {
      // Convert SchemaType to Zod schema
      const shape: Record<string, z.ZodTypeAny> = {};
      
      for (const [key, prop] of Object.entries(options.schema.properties)) {
        if (prop.type === 'string') {
          shape[key] = z.string().describe(prop.description);
        } else if (prop.type === 'number') {
          shape[key] = z.number().describe(prop.description);
        } else if (prop.type === 'boolean') {
          shape[key] = z.boolean().describe(prop.description);
        }
      }
      
      this.schema = z.object(shape);
    } else {
      // It's already a Zod schema
      this.schema = options.schema;
    }
    
    this.schemaDescription = options.schemaDescription || 'Generate structured data according to the schema';
  }
  
  async execute(session: Session<TInput>): Promise<Session<TOutput>> {
    if (!this.model) {
      throw new Error('No model provided for AISDKSchemaTemplate');
    }
    
    // Ensure we're using an AISDKModel
    if (!(this.model instanceof AISDKModel)) {
      throw new Error('AISDKSchemaTemplate requires an AISDKModel');
    }
    
    // Convert session messages to AI SDK format
    const messages = session.messages.map(msg => {
      if (msg.type === 'system') {
        return { role: 'system', content: msg.content };
      } else if (msg.type === 'user') {
        return { role: 'user', content: msg.content };
      } else if (msg.type === 'assistant') {
        return { role: 'assistant', content: msg.content };
      }
      return null;
    }).filter(Boolean);
    
    // Since we can't access private methods directly, we'll use a simpler approach
    // Create a new instance of the model for structured output
    const modelConfig = (this.model as any).config;
    
    // Create provider based on the model's configuration
    let provider;
    
    if (modelConfig.provider === AIProvider.OPENAI) {
      provider = openai(modelConfig.modelName, {
        apiKey: modelConfig.apiKey,
        baseURL: modelConfig.apiBase,
        organization: modelConfig.organizationId,
      } as any);
    } else if (modelConfig.provider === AIProvider.ANTHROPIC) {
      provider = anthropic(modelConfig.modelName, {
        apiKey: modelConfig.apiKey,
        baseURL: modelConfig.apiBase,
      } as any);
    } else {
      throw new Error(`Unsupported provider: ${modelConfig.provider}`);
    }
    
    // Generate structured output using AI SDK
    const { object } = await generateObject({
      model: provider as any,
      schema: this.schema,
      schemaDescription: this.schemaDescription,
      messages: messages as any,
      temperature: 0.1, // Use a fixed temperature for structured output
    });
    
    // Create a new metadata object with the structured output
    const metadataObj = session.metadata.toObject ? session.metadata.toObject() : {};
    const newMetadata = createMetadata<TOutput>({ initial: metadataObj as any });
    newMetadata.set('structured_output' as keyof TOutput, object as any);
    
    // Create a new session with the updated metadata
    return {
      ...session,
      metadata: newMetadata,
    } as unknown as Session<TOutput>;
  }
}
