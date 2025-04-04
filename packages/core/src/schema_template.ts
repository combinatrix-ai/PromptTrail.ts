import type { ISession, TMessage } from './types';
import { createMetadata } from './metadata';
import { z } from 'zod';

/**
 * Import Template class from templates
 */
import { Template } from './templates';
import type { ISchemaType } from './types';
import { GenerateOptions } from './generate_options';

/**
 * Import AI SDK components for structured data generation
 */
import { generateText, Output } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';

/**
 * Type to handle both ISchemaType and Zod schemas
 */
type SchemaInput = ISchemaType | z.ZodType;

/**
 * Helper to check if a schema is a Zod schema
 */
function isZodSchema(schema: SchemaInput): schema is z.ZodType {
  return typeof (schema as z.ZodType)._def !== 'undefined';
}


/**
 * Helper to convert ISchemaType to Zod schema
 */
function schemaTypeToZodSchema(schema: ISchemaType): z.ZodTypeAny {
  const schemaShape: Record<string, z.ZodTypeAny> = {};
  
  for (const [key, prop] of Object.entries(schema.properties)) {
    const typedProp = prop as { type: string; description: string };
    let zodType: z.ZodTypeAny;
    
    switch (typedProp.type) {
      case 'string':
        zodType = z.string();
        break;
      case 'number':
        zodType = z.number();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      case 'array':
        zodType = z.array(z.any());
        break;
      case 'object':
        zodType = z.record(z.string(), z.any());
        break;
      default:
        zodType = z.any();
    }
    
    if (typedProp.description) {
      zodType = zodType.describe(typedProp.description);
    }
    
    if (!schema.required?.includes(key)) {
      zodType = zodType.optional();
    }
    
    schemaShape[key] = zodType;
  }
  
  return z.object(schemaShape);
}

/**
 * Template that enforces structured output according to a schema
 *
 * This template uses AI SDK's schema functionality to ensure the LLM output matches
 * the expected structure. It supports both PromptTrail's native schema type and Zod schemas.
 */
export class SchemaTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput & {
    structured_output: Record<string, unknown>;
  },
> extends Template<TInput, TOutput> {
  private generateOptions: GenerateOptions;
  private schema: SchemaInput;
  private zodSchema: z.ZodTypeAny;
  private isZodSchema: boolean;
  private maxAttempts: number;
  private functionName?: string;

  constructor(options: {
    generateOptions: GenerateOptions;
    schema: SchemaInput;
    schemaName?: string;
    schemaDescription?: string;
    maxAttempts?: number;
    functionName?: string;
  }) {
    super();
    this.generateOptions = options.generateOptions;
    this.schema = options.schema;
    this.isZodSchema = isZodSchema(options.schema);
    this.maxAttempts = options.maxAttempts || 3; // Default to 3 attempts if not specified
    this.functionName = options.functionName;

    /**
     * Convert to Zod schema if needed for AI SDK
     */
    if (this.isZodSchema) {
      this.zodSchema = options.schema as z.ZodType;
    } else {
      this.zodSchema = schemaTypeToZodSchema(options.schema as ISchemaType);
    }
  }

  async execute(session: ISession<TInput>): Promise<ISession<TOutput>> {
    if (!this.generateOptions) {
      throw new Error('No generateOptions provided for SchemaTemplate');
    }

    const messages = session.messages;
    
    const aiMessages = messages.length > 0 
      ? messages.map((msg: TMessage) => {
          if (msg.type === 'system') {
            return { role: 'system' as const, content: msg.content };
          } else if (msg.type === 'user') {
            return { role: 'user' as const, content: msg.content };
          } else if (msg.type === 'assistant') {
            return { role: 'assistant' as const, content: msg.content };
          }
          return { role: 'user' as const, content: msg.content };
        })
      : [{ role: 'user' as const, content: 'Generate structured data according to the schema.' }];

    let lastError: Error | null = null;
    let currentAttempt = 0;

    while (currentAttempt < this.maxAttempts) {
      currentAttempt++;
      try {
        const { experimental_output } = await generateText({
          model: this.generateOptions.provider.type === 'openai' 
            ? openai(this.generateOptions.provider.modelName)
            : anthropic(this.generateOptions.provider.modelName),
          messages: aiMessages,
          experimental_output: Output.object({
            schema: this.zodSchema,
          }),
        });

        if (!experimental_output) {
          throw new Error('No structured output generated');
        }

        const resultSession = await session.addMessage({
          type: 'assistant',
          content: JSON.stringify(experimental_output, null, 2),
          metadata: createMetadata(),
        });

        // Add the structured output to the session metadata
        return resultSession.updateMetadata({
          structured_output: experimental_output,
        }) as unknown as ISession<TOutput>;
      } catch (error) {
        lastError = error as Error;
        console.error(`Attempt ${currentAttempt}/${this.maxAttempts} failed to generate structured output:`, error);
        
        if (currentAttempt >= this.maxAttempts) {
          throw new Error(`Failed to generate structured output after ${this.maxAttempts} attempts: ${lastError.message}`);
        }
        
        console.log(`Retrying... (${currentAttempt}/${this.maxAttempts})`);
      }
    }

    throw new Error(`Failed to generate structured output after ${this.maxAttempts} attempts`);
  }
}
