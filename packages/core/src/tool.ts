/**
 * Tool implementation with type-safe schema validation
 * Updated to use Vercel's ai-sdk
 */

import { ValidationError } from './types';
import type { z } from 'zod';

/**
 * JSON Schema primitive types
 * Maintained for backward compatibility
 */
export type SchemaType = {
  properties: Record<string, PropertySchema>;
  required?: string[];
};

type PropertySchema =
  | { type: 'string'; description: string }
  | { type: 'number'; description: string }
  | { type: 'boolean'; description: string };

/**
 * Infer TypeScript type from JSON Schema
 * Maintained for backward compatibility
 */
export type InferSchemaType<T> = 
  T extends z.ZodType<any, any, any> 
    ? z.infer<T> 
    : T extends SchemaType
      ? {
          [K in keyof T['properties']]: T['properties'][K] extends { type: 'string' }
            ? string
            : T['properties'][K] extends { type: 'number' }
              ? number
              : T['properties'][K] extends { type: 'boolean' }
                ? boolean
                : never;
        }
      : never;

/**
 * Tool result type
 */
export type ToolResult<T> = {
  result: T;
};

/**
 * Enhanced Tool interface with type-safe schema
 * Updated to support both legacy SchemaType and Zod schemas
 */
export interface Tool<TSchema = SchemaType, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: TSchema;
  execute(input: InferSchemaType<TSchema>): Promise<ToolResult<TOutput>>;
}

/**
 * Validate input against schema at runtime
 */
function validateSchema<T extends SchemaType>(
  schema: T,
  value: unknown,
): value is InferSchemaType<T> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  // Check required properties
  if (schema.required) {
    for (const required of schema.required) {
      if (!(required in value)) {
        return false;
      }
    }
  }

  // Validate each property
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const propValue = (value as any)[key];
    if (propValue !== undefined) {
      if (propSchema.type === 'string' && typeof propValue !== 'string') {
        return false;
      }
      if (propSchema.type === 'number' && typeof propValue !== 'number') {
        return false;
      }
      if (propSchema.type === 'boolean' && typeof propValue !== 'boolean') {
        return false;
      }
    }
  }

  return true;
}

/**
 * Validate input using Zod schema
 */
function validateZodSchema<T extends z.ZodType<any, any, any>>(
  schema: T,
  value: unknown,
): value is z.infer<T> {
  try {
    schema.parse(value);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Create a new tool with type inference and runtime validation
 * Updated to support both legacy SchemaType and Zod schemas
 */
export function createTool<TSchema, TOutput>(config: {
  name: string;
  description: string;
  schema: TSchema;
  execute: (input: InferSchemaType<TSchema>) => Promise<TOutput>;
}): Tool<TSchema, TOutput> {
  return {
    name: config.name,
    description: config.description,
    schema: config.schema,
    execute: async (input) => {
      // Validate input at runtime based on schema type
      const isZodSchema = typeof (config.schema as any).parse === 'function';
      
      if (isZodSchema) {
        if (!validateZodSchema(config.schema as z.ZodType<any, any, any>, input)) {
          throw new ValidationError(
            `Invalid input for tool "${config.name}". Input must match Zod schema.`,
          );
        }
      } else if (typeof (config.schema as any).properties === 'object') {
        if (!validateSchema(config.schema as SchemaType, input)) {
          throw new ValidationError(
            `Invalid input for tool "${config.name}". Input must match schema: ${JSON.stringify(config.schema, null, 2)}`,
          );
        }
      } else {
        throw new ValidationError(
          `Invalid schema for tool "${config.name}". Schema must be either a Zod schema or a SchemaType object.`,
        );
      }

      const result = await config.execute(input);
      return { result };
    },
  };
}

/**
 * Example usage:
 *
 * const calculatorSchema = {
 *   type: 'object',
 *   description: 'Calculator input',
 *   properties: {
 *     a: { type: 'number', description: 'First number' },
 *     b: { type: 'number', description: 'Second number' }
 *   },
 *   required: ['a', 'b']
 * } as const;
 *
 * const calculator = createTool({
 *   name: 'calculator',
 *   description: 'Add two numbers',
 *   schema: calculatorSchema,
 *   execute: async (input) => input.a + input.b
 * });
 */

/**
 * Convert a PromptTrail Tool to an ai-sdk tool
 * This is used internally by the model implementations
 */
export function convertToAiSdkTool<TSchema, TOutput>(tool: Tool<TSchema, TOutput>) {
  // Convert PromptTrail.ts tool to a format compatible with ai-sdk
  const aiSdkTools: Record<string, any> = {};
  
  // Ensure schema is not null
  if (!tool.schema) {
    throw new Error(`Tool ${tool.name} has no schema`);
  }
  
  // Create a simple JSON schema for the tool
  const jsonSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  } = {
    type: 'object',
    properties: {},
    required: [],
  };
  
  // Handle SchemaType objects
  if (typeof tool.schema === 'object' && 'properties' in tool.schema) {
    const schemaWithProps = tool.schema as unknown as SchemaType;
    jsonSchema.properties = schemaWithProps.properties as Record<string, unknown>;
    if (schemaWithProps.required) {
      jsonSchema.required = schemaWithProps.required;
    }
  }
  
  aiSdkTools[tool.name] = {
    description: tool.description,
    // Use a simplified schema format that works with ai-sdk
    schema: jsonSchema,
    // Execute function that will be called by ai-sdk
    execute: async (params: any) => {
      const result = await tool.execute(params);
      return result.result;
    },
    // Add parse function to handle tool calls
    parse: (args: Record<string, unknown>) => args
  };
  
  return aiSdkTools;
}
