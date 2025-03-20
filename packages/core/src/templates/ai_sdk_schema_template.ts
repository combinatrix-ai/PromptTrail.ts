import { z } from 'zod';
import { generateObject, streamObject } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import type { Session } from '../session';
import type { Model } from '../model/base';
import type { SchemaType } from '../tool';
import { createMetadata } from '../metadata';
import { Template } from '../templates';
import { AIProvider } from '../model/ai_sdk_model';

// Define PropertySchema locally since it's not exported from tool.ts
type PropertySchema =
  | { type: 'string'; description: string }
  | { type: 'number'; description: string }
  | { type: 'boolean'; description: string };

// Helper to check if a schema is a Zod schema
function isZodSchema(schema: SchemaType | z.ZodType): schema is z.ZodType {
  return typeof (schema as z.ZodType)._def !== 'undefined';
}

// Helper to convert SchemaType to Zod schema
function schemaTypeToZod(schema: SchemaType): z.ZodType {
  const shape: Record<string, z.ZodTypeAny> = {};
  
  for (const [key, prop] of Object.entries(schema.properties)) {
    const propObj = prop as { type: string; description?: string; properties?: Record<string, unknown>; required?: string[] };
    
    if (propObj.type === 'string') {
      shape[key] = z.string().describe(propObj.description || '');
    } else if (propObj.type === 'number') {
      shape[key] = z.number().describe(propObj.description || '');
    } else if (propObj.type === 'object' && propObj.properties) {
      // Handle nested objects
      const nestedSchema: SchemaType = {
        properties: propObj.properties as unknown as Record<string, PropertySchema>,
        required: propObj.required || [],
      };
      shape[key] = schemaTypeToZod(nestedSchema).describe(propObj.description || '');
    } else if (propObj.type === 'array') {
      // Handle arrays with type assertion for items
      const itemsObj = (propObj as unknown as { items?: { type: string } }).items;
      if (itemsObj && itemsObj.type === 'string') {
        shape[key] = z.array(z.string()).describe(propObj.description || '');
      } else if (itemsObj && itemsObj.type === 'number') {
        shape[key] = z.array(z.number()).describe(propObj.description || '');
      } else if (itemsObj && itemsObj.type === 'boolean') {
        shape[key] = z.array(z.boolean()).describe(propObj.description || '');
      }
    } else if (propObj.type === 'boolean') {
      shape[key] = z.boolean().describe(propObj.description || '');
    }
  }
  
  // Create Zod schema with required fields
  let zodSchema = z.object(shape);
  
  // Mark required fields
  if (schema.required && schema.required.length > 0) {
    const requiredShape: Record<string, z.ZodTypeAny> = {};
    const optionalShape: Record<string, z.ZodTypeAny> = {};
    
    for (const [key, value] of Object.entries(shape)) {
      if (schema.required.includes(key)) {
        requiredShape[key] = value;
      } else {
        optionalShape[key] = value.optional();
      }
    }
    
    zodSchema = z.object({
      ...requiredShape,
      ...optionalShape,
    });
  }
  
  return zodSchema;
}

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
  private streaming: boolean;
  
  constructor(options: {
    model: Model;
    schema: SchemaType | z.ZodType;
    schemaDescription?: string;
    streaming?: boolean;
  }) {
    super({ model: options.model });
    
    // Convert schema to Zod schema if it's not already
    if (isZodSchema(options.schema)) {
      this.schema = options.schema;
    } else {
      this.schema = schemaTypeToZod(options.schema);
    }
    
    this.schemaDescription = options.schemaDescription || 'Generate structured data according to the schema';
    this.streaming = options.streaming || false;
  }
  
  /**
   * Convert Session to AI SDK compatible format
   */
  private convertSessionToMessages(session: Session<TInput>) {
    // Convert our session messages to AI SDK format
    const messages: Array<{ role: string; content: string }> = [];
    
    for (const msg of session.messages) {
      if (msg.type === 'system') {
        messages.push({ role: 'system', content: msg.content });
      } else if (msg.type === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.type === 'assistant') {
        messages.push({ role: 'assistant', content: msg.content });
      }
    }
    
    return messages;
  }
  
  async execute(session: Session<TInput>): Promise<Session<TOutput>> {
    if (!this.model) {
      throw new Error('No model provided for AISDKSchemaTemplate');
    }
    
    // Get model configuration from the model
    const modelConfig = (this.model as unknown as { config: Record<string, unknown> }).config;
    if (!modelConfig) {
      throw new Error('Model configuration is required for AISDKSchemaTemplate');
    }
    
    // Create provider based on the model's configuration
    let provider;
    
    if (modelConfig.provider === AIProvider.OPENAI) {
      // For OpenAI
      const options: Record<string, unknown> = {
        structuredOutputs: true,
      };
      
      if (modelConfig.apiBase) {
        options.baseURL = modelConfig.apiBase;
      }
      
      if (modelConfig.organizationId) {
        options.organization = modelConfig.organizationId;
      }
      
      provider = openai(modelConfig.modelName as string, options);
    } else if (modelConfig.provider === AIProvider.ANTHROPIC) {
      // For Anthropic
      const options: Record<string, unknown> = {
        structuredOutputs: true,
      };
      
      if (modelConfig.apiBase) {
        options.baseURL = modelConfig.apiBase;
      }
      
      provider = anthropic(modelConfig.modelName as string, options);
    } else {
      throw new Error(`Unsupported provider: ${modelConfig.provider}`);
    }
    
    // Convert session messages to AI SDK format
    const messages = this.convertSessionToMessages(session);
    
    if (this.streaming) {
      // Use streaming object generation
      return this.executeStreaming(session, messages as unknown, provider);
    } else {
      // Use non-streaming object generation
      return this.executeNonStreaming(session, messages as unknown, provider);
    }
  }
  
  /**
   * Execute with non-streaming object generation
   */
  private async executeNonStreaming(
    session: Session<TInput>,
    messages: unknown,
    provider: unknown
  ): Promise<Session<TOutput>> {
    try {
      // Generate structured output using AI SDK
      // Using type assertion to work around AI SDK type issues
      // Using unknown type to work around AI SDK type issues
      const { object } = await (generateObject as unknown as (options: {
        model: unknown;
        schema: z.ZodType;
        schemaDescription?: string;
        messages: unknown;
        temperature?: number;
      }) => Promise<{ object: unknown }>)({
        model: provider,
        schema: this.schema,
        schemaDescription: this.schemaDescription,
        messages,
        temperature: ((this.model as unknown) as { config: { temperature?: number } }).config.temperature || 0.1,
      });
      
      // Create a new metadata object with the structured output
      const newMetadata = createMetadata<TOutput>({ initial: {} as TOutput });
      newMetadata.set('structured_output' as keyof TOutput, object as unknown as TOutput[keyof TOutput]);
      
      // Create a new session with the updated metadata
      return {
        ...session,
        metadata: newMetadata,
      } as unknown as Session<TOutput>;
    } catch (error) {
      console.error('Error generating structured output:', error);
      throw new Error(`Failed to generate structured output: ${(error as Error).message}`);
    }
  }
  
  /**
   * Execute with streaming object generation
   */
  private async executeStreaming(
    session: Session<TInput>,
    messages: unknown,
    provider: unknown
  ): Promise<Session<TOutput>> {
    try {
      // Stream structured output using AI SDK
      // Using type assertion to work around AI SDK type issues
      // Using unknown type to work around AI SDK type issues
      const { object } = await (streamObject as unknown as (options: {
        model: unknown;
        schema: z.ZodType;
        schemaDescription?: string;
        messages: unknown;
        temperature?: number;
      }) => Promise<{ object: unknown }>)({
        model: provider,
        schema: this.schema,
        schemaDescription: this.schemaDescription,
        messages,
        temperature: ((this.model as unknown) as { config: { temperature?: number } }).config.temperature || 0.1,
      });
      
      // Create a new metadata object with the structured output
      const newMetadata = createMetadata<TOutput>({ initial: {} as TOutput });
      newMetadata.set('structured_output' as keyof TOutput, object as unknown as TOutput[keyof TOutput]);
      
      // Create a new session with the updated metadata
      return {
        ...session,
        metadata: newMetadata,
      } as unknown as Session<TOutput>;
    } catch (error) {
      console.error('Error streaming structured output:', error);
      throw new Error(`Failed to stream structured output: ${(error as Error).message}`);
    }
  }
}
