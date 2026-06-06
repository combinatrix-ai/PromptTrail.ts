import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

export interface JsonSchemaOptions {
  openAiStrict?: boolean;
  additionalProperties?: boolean;
  unsupported?: 'strip' | 'error';
}

export function zodToJsonSchema(
  schema: z.ZodType,
  options: JsonSchemaOptions = {},
): JsonSchema {
  return convertZodSchema(schema, {
    openAiStrict: options.openAiStrict ?? false,
    additionalProperties: options.additionalProperties ?? false,
    unsupported: options.unsupported ?? 'error',
  });
}

function convertZodSchema(
  schema: z.ZodType,
  options: Required<JsonSchemaOptions>,
): JsonSchema {
  if (schema instanceof z.ZodOptional) {
    return convertZodSchema(schema.unwrap(), options);
  }

  if (schema instanceof z.ZodDefault) {
    return convertZodSchema(schema.removeDefault(), options);
  }

  if (schema instanceof z.ZodNullable) {
    return makeNullable(convertZodSchema(schema.unwrap(), options));
  }

  if (schema instanceof z.ZodString) {
    return withDescription(schema, { type: 'string' });
  }

  if (schema instanceof z.ZodNumber) {
    return withDescription(schema, { type: 'number' });
  }

  if (schema instanceof z.ZodBoolean) {
    return withDescription(schema, { type: 'boolean' });
  }

  if (schema instanceof z.ZodArray) {
    return withDescription(schema, {
      type: 'array',
      items: convertZodSchema(schema.element, options),
    });
  }

  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const shape = schema.shape;

    for (const [key, value] of Object.entries(shape)) {
      const propertySchema = value as z.ZodType;
      const isOptional = propertySchema instanceof z.ZodOptional;
      const converted = convertZodSchema(propertySchema, options);
      properties[key] =
        options.openAiStrict && isOptional
          ? makeNullable(converted)
          : converted;
      if (options.openAiStrict || !isOptional) {
        required.push(key);
      }
    }

    return withDescription(schema, {
      type: 'object',
      properties,
      required,
      additionalProperties: options.additionalProperties,
    });
  }

  if (schema instanceof z.ZodEnum) {
    return withDescription(schema, {
      type: 'string',
      enum: schema.options,
    });
  }

  if (schema instanceof z.ZodLiteral) {
    const value = schema.value;
    return withDescription(schema, {
      type: jsonPrimitiveType(value),
      const: value,
    });
  }

  if (schema instanceof z.ZodRecord) {
    return withDescription(schema, {
      type: 'object',
      additionalProperties: convertZodSchema(schema.valueSchema, options),
    });
  }

  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
    return withDescription(schema, {});
  }

  if (options.unsupported === 'strip') {
    return withDescription(schema, {});
  }

  const typeName = (schema._def as { typeName?: string }).typeName ?? 'unknown';
  throw new Error(`Unsupported Zod schema type: ${typeName}`);
}

function makeNullable(schema: JsonSchema): JsonSchema {
  const type = schema.type;
  if (typeof type === 'string') {
    return { ...schema, type: [type, 'null'] };
  }
  if (Array.isArray(type)) {
    return { ...schema, type: [...new Set([...type, 'null'])] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

function withDescription(
  schema: z.ZodType,
  jsonSchema: JsonSchema,
): JsonSchema {
  const description = schema.description;
  if (!description) {
    return jsonSchema;
  }
  return {
    ...jsonSchema,
    description,
  };
}

function jsonPrimitiveType(value: unknown): string {
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (value === null) {
    return 'null';
  }
  throw new Error(
    `Unsupported literal value for JSON Schema: ${String(value)}`,
  );
}
