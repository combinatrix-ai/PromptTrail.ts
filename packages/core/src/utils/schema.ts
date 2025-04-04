import { z } from 'zod';

/**
 * Type-safe helper to create a string property for Zod schema
 */
export function createStringProperty(description: string): z.ZodString {
  return z.string().describe(description);
}

/**
 * Type-safe helper to create a number property for Zod schema
 */
export function createNumberProperty(description: string): z.ZodNumber {
  return z.number().describe(description);
}

/**
 * Type-safe helper to create a boolean property for Zod schema
 */
export function createBooleanProperty(description: string): z.ZodBoolean {
  return z.boolean().describe(description);
}

/**
 * Type-safe helper to create a schema with properties and required fields
 * Returns a Zod schema
 */
export function defineSchema<
  T extends Record<string, z.ZodTypeAny>,
>(properties: T): z.ZodObject<T> {
  return z.object(properties);
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
