import type { SchemaType } from '../tool';
import { z } from 'zod';

/**
 * Create a schema definition with TypeScript type inference
 */
export function createSchema<T extends SchemaType>(schema: T): T {
  return schema;
}

/**
 * Create a string property schema with proper typing
 */
export function createStringProperty(description: string) {
  return { type: 'string' as const, description };
}

/**
 * Create a number property schema with proper typing
 */
export function createNumberProperty(description: string) {
  return { type: 'number' as const, description };
}

/**
 * Create a boolean property schema with proper typing
 */
export function createBooleanProperty(description: string) {
  return { type: 'boolean' as const, description };
}

/**
 * Type-safe helper to create a schema with properties and required fields
 */
export function defineSchema<
  T extends Record<
    string,
    { type: 'string' | 'number' | 'boolean'; description: string }
  >,
>(options: { properties: T; required?: Array<keyof T> }): SchemaType {
  return {
    properties: options.properties,
    required: options.required as string[] | undefined,
  };
}

/**
 * Convert a Zod schema to JSON Schema format
 * This is a simplified implementation that works for our basic schema types
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];

    // Process each property in the schema
    Object.entries(schema.shape).forEach(([key, value]) => {
      const zodValue = value as z.ZodTypeAny;
      
      if (zodValue instanceof z.ZodString) {
        properties[key] = { type: 'string' };
        if ('description' in zodValue && typeof zodValue.description === 'string') {
          properties[key].description = zodValue.description;
        }
      } else if (zodValue instanceof z.ZodNumber) {
        properties[key] = { type: 'number' };
        if ('description' in zodValue && typeof zodValue.description === 'string') {
          properties[key].description = zodValue.description;
        }
      } else if (zodValue instanceof z.ZodBoolean) {
        properties[key] = { type: 'boolean' };
        if ('description' in zodValue && typeof zodValue.description === 'string') {
          properties[key].description = zodValue.description;
        }
      } else if (zodValue instanceof z.ZodArray) {
        properties[key] = {
          type: 'array',
          items: zodToJsonSchema(zodValue.element),
        };
        if ('description' in zodValue && typeof zodValue.description === 'string') {
          properties[key].description = zodValue.description;
        }
      } else if (zodValue instanceof z.ZodObject) {
        properties[key] = zodToJsonSchema(zodValue);
        if ('description' in zodValue && typeof zodValue.description === 'string') {
          properties[key].description = zodValue.description;
        }
      }

      // Check if the property is required
      if ('isOptional' in zodValue && typeof zodValue.isOptional === 'function' && !zodValue.isOptional()) {
        required.push(key);
      }
    });

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  // Default fallback
  return { type: 'object', properties: {} };
}
