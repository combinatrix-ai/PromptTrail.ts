import type { ISchemaType } from '../types';
import { z } from 'zod';

/**
 * Create a schema definition with TypeScript type inference
 */
export function createSchema<T extends ISchemaType>(schema: T): T {
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
>(options: { properties: T; required?: Array<keyof T> }): ISchemaType {
  return {
    properties: options.properties,
    required: options.required as string[] | undefined,
  };
}

/**
 * Convert a Zod schema to JSON Schema format
 * This is a simplified implementation that works for our basic schema types
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function zodToJsonSchema(schema: z.ZodType): any {
  if (schema instanceof z.ZodObject) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const properties: Record<string, any> = {};
    const required: string[] = [];

    // Process each property in the schema
    Object.entries(schema.shape).forEach(([key, value]) => {
      if (value instanceof z.ZodString) {
        properties[key] = { type: 'string' };
        if (value.description) {
          properties[key].description = value.description;
        }
      } else if (value instanceof z.ZodNumber) {
        properties[key] = { type: 'number' };
        if (value.description) {
          properties[key].description = value.description;
        }
      } else if (value instanceof z.ZodBoolean) {
        properties[key] = { type: 'boolean' };
        if (value.description) {
          properties[key].description = value.description;
        }
      } else if (value instanceof z.ZodArray) {
        properties[key] = {
          type: 'array',
          items: zodToJsonSchema(value.element),
        };
        if (value.description) {
          properties[key].description = value.description;
        }
      } else if (value instanceof z.ZodObject) {
        properties[key] = zodToJsonSchema(value);
        if (value.description) {
          properties[key].description = value.description;
        }
      }

      // Check if the property is required
      // Use type assertion for zod schema methods
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(value as any).isOptional()) {
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
