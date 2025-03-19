/**
 * Tool implementation with type-safe schema validation
 */

import { ValidationError } from './types';

/**
 * JSON Schema primitive types
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
 */
export type InferSchemaType<T extends SchemaType> = {
  [K in keyof T['properties']]: T['properties'][K] extends { type: 'string' }
    ? string
    : T['properties'][K] extends { type: 'number' }
      ? number
      : T['properties'][K] extends { type: 'boolean' }
        ? boolean
        : never;
};

/**
 * Tool result type
 */
export type ToolResult<T> = {
  result: T;
};

/**
 * Enhanced Tool interface with type-safe schema
 */
export interface Tool<TSchema extends SchemaType, TOutput = unknown> {
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
    const propValue = (value as Record<string, unknown>)[key];
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
 * Create a new tool with type inference and runtime validation
 */
export function createTool<TSchema extends SchemaType, TOutput>(config: {
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
      // Validate input at runtime
      if (!validateSchema(config.schema, input)) {
        throw new ValidationError(
          `Invalid input for tool "${config.name}". Input must match schema: ${JSON.stringify(config.schema, null, 2)}`,
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
