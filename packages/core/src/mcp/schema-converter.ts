import { z } from 'zod';

/**
 * JSON Schema types as defined by the JSON Schema specification
 */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  
  // String validations
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  
  // Number validations
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  multipleOf?: number;
  
  // Array validations
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  
  // Object validations
  minProperties?: number;
  maxProperties?: number;
  additionalProperties?: boolean | JsonSchema;
  
  // Common
  default?: unknown;
  description?: string;
  title?: string;
  examples?: unknown[];
  
  // Custom extensions
  [key: string]: unknown;
}

/**
 * Options for schema conversion
 */
export interface ConversionOptions {
  strictMode?: boolean;
  allowUnknownFormats?: boolean;
  defaultToOptional?: boolean;
  preserveDescriptions?: boolean;
}

/**
 * Converts JSON Schema to Zod schema
 */
export class JsonSchemaToZod {
  private options: Required<ConversionOptions>;

  constructor(options: ConversionOptions = {}) {
    this.options = {
      strictMode: false,
      allowUnknownFormats: true,
      defaultToOptional: true,
      preserveDescriptions: true,
      ...options,
    };
  }

  /**
   * Convert a JSON Schema to a Zod schema
   */
  convert(schema: JsonSchema): z.ZodTypeAny {
    return this.convertSchema(schema);
  }

  private convertSchema(schema: JsonSchema): z.ZodTypeAny {
    // Handle const values
    if (schema.const !== undefined) {
      return z.literal(schema.const);
    }

    // Handle enums
    if (schema.enum) {
      if (schema.enum.length === 0) {
        throw new Error('Empty enum is not supported');
      }
      return z.enum(schema.enum as [string, ...string[]]);
    }

    // Handle composite schemas
    if (schema.anyOf) {
      return z.union(schema.anyOf.map(s => this.convertSchema(s)) as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
    }

    if (schema.oneOf) {
      return z.union(schema.oneOf.map(s => this.convertSchema(s)) as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
    }

    if (schema.allOf) {
      // For allOf, we need to merge all constraints
      // This is complex because we need to combine constraints properly
      const schemas = schema.allOf;
      let mergedSchema: JsonSchema = {};
      
      // Merge all schemas into one
      for (const subSchema of schemas) {
        mergedSchema = this.mergeSchemas(mergedSchema, subSchema);
      }
      
      return this.convertSchema(mergedSchema);
    }

    // Handle typed schemas
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    
    if (types.length === 0 || !schema.type) {
      // No type specified - try to infer from properties
      if (schema.properties) {
        return this.convertObject(schema);
      }
      if (schema.items) {
        return this.convertArray(schema);
      }
      return z.unknown();
    }

    if (types.length > 1) {
      // Union of types
      return z.union(types.map(type => 
        this.convertSchema({ ...schema, type })
      ) as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
    }

    const type = types[0];
    let zodSchema: z.ZodTypeAny;

    switch (type) {
      case 'string':
        zodSchema = this.convertString(schema);
        break;
      case 'number':
        zodSchema = this.convertNumber(schema);
        break;
      case 'integer':
        zodSchema = this.convertInteger(schema);
        break;
      case 'boolean':
        zodSchema = z.boolean();
        break;
      case 'array':
        zodSchema = this.convertArray(schema);
        break;
      case 'object':
        zodSchema = this.convertObject(schema);
        break;
      case 'null':
        zodSchema = z.null();
        break;
      default:
        if (this.options.strictMode) {
          throw new Error(`Unsupported type: ${type}`);
        }
        zodSchema = z.unknown();
    }

    // Add default value if present
    if (schema.default !== undefined) {
      zodSchema = zodSchema.default(schema.default);
    }

    // Add description if present and enabled
    if (this.options.preserveDescriptions && schema.description) {
      zodSchema = zodSchema.describe(schema.description);
    }

    return zodSchema;
  }

  private convertString(schema: JsonSchema): z.ZodString {
    let zodSchema = z.string();

    // Length constraints
    if (schema.minLength !== undefined) {
      zodSchema = zodSchema.min(schema.minLength);
    }
    if (schema.maxLength !== undefined) {
      zodSchema = zodSchema.max(schema.maxLength);
    }

    // Pattern constraint
    if (schema.pattern) {
      zodSchema = zodSchema.regex(new RegExp(schema.pattern));
    }

    // Format constraints
    if (schema.format) {
      switch (schema.format) {
        case 'email':
          zodSchema = zodSchema.email();
          break;
        case 'url':
        case 'uri':
          zodSchema = zodSchema.url();
          break;
        case 'uuid':
          zodSchema = zodSchema.uuid();
          break;
        case 'date-time':
          zodSchema = zodSchema.datetime();
          break;
        case 'date':
          zodSchema = zodSchema.date();
          break;
        case 'time':
          zodSchema = zodSchema.time();
          break;
        case 'ipv4':
          zodSchema = zodSchema.ip({ version: 'v4' });
          break;
        case 'ipv6':
          zodSchema = zodSchema.ip({ version: 'v6' });
          break;
        default:
          if (!this.options.allowUnknownFormats && this.options.strictMode) {
            throw new Error(`Unsupported string format: ${schema.format}`);
          }
      }
    }

    return zodSchema;
  }

  private convertNumber(schema: JsonSchema): z.ZodNumber {
    let zodSchema = z.number();

    // Range constraints
    if (schema.minimum !== undefined) {
      zodSchema = zodSchema.gte(schema.minimum);
    }
    if (schema.maximum !== undefined) {
      zodSchema = zodSchema.lte(schema.maximum);
    }
    
    // Handle exclusive constraints
    if (schema.exclusiveMinimum !== undefined) {
      if (typeof schema.exclusiveMinimum === 'boolean') {
        // Draft 4 style
        if (schema.exclusiveMinimum && schema.minimum !== undefined) {
          zodSchema = zodSchema.gt(schema.minimum);
        }
      } else {
        // Draft 6+ style
        zodSchema = zodSchema.gt(schema.exclusiveMinimum);
      }
    }
    
    if (schema.exclusiveMaximum !== undefined) {
      if (typeof schema.exclusiveMaximum === 'boolean') {
        // Draft 4 style
        if (schema.exclusiveMaximum && schema.maximum !== undefined) {
          zodSchema = zodSchema.lt(schema.maximum);
        }
      } else {
        // Draft 6+ style
        zodSchema = zodSchema.lt(schema.exclusiveMaximum);
      }
    }

    // Multiple constraint
    if (schema.multipleOf !== undefined) {
      zodSchema = zodSchema.multipleOf(schema.multipleOf);
    }

    return zodSchema;
  }

  private convertInteger(schema: JsonSchema): z.ZodNumber {
    let zodSchema = z.number().int();

    // Apply number constraints
    const numberSchema = this.convertNumber({ ...schema, type: 'number' });
    return numberSchema.int();
  }

  private convertArray(schema: JsonSchema): z.ZodArray<z.ZodTypeAny> {
    let itemSchema: z.ZodTypeAny = z.unknown();

    if (schema.items) {
      if (Array.isArray(schema.items)) {
        // Tuple schema - not fully supported in Zod, use first item
        itemSchema = this.convertSchema(schema.items[0] || {});
      } else {
        itemSchema = this.convertSchema(schema.items);
      }
    }

    let zodSchema = z.array(itemSchema);

    // Length constraints
    if (schema.minItems !== undefined) {
      zodSchema = zodSchema.min(schema.minItems);
    }
    if (schema.maxItems !== undefined) {
      zodSchema = zodSchema.max(schema.maxItems);
    }

    return zodSchema;
  }

  private convertObject(schema: JsonSchema): z.ZodObject<z.ZodRawShape> {
    const shape: z.ZodRawShape = {};
    const required = new Set(schema.required || []);

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        let propZodSchema = this.convertSchema(propSchema);
        
        // Make optional if not required
        if (!required.has(key)) {
          propZodSchema = propZodSchema.optional();
        }

        shape[key] = propZodSchema;
      }
    }

    let zodSchema = z.object(shape);

    // Handle additional properties
    if (schema.additionalProperties === false) {
      zodSchema = zodSchema.strict();
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      // Zod doesn't support this directly, but we can use passthrough
      zodSchema = zodSchema.passthrough();
    } else if (schema.additionalProperties !== false) {
      // Default to passthrough for unknown additional properties
      zodSchema = zodSchema.passthrough();
    }

    return zodSchema;
  }

  /**
   * Merge two JSON schemas (for allOf support)
   */
  private mergeSchemas(schema1: JsonSchema, schema2: JsonSchema): JsonSchema {
    const merged: JsonSchema = { ...schema1 };

    // Merge type
    if (schema2.type) {
      merged.type = schema2.type;
    }

    // Merge properties
    if (schema2.properties) {
      merged.properties = { ...merged.properties, ...schema2.properties };
    }

    // Merge required arrays
    if (schema2.required) {
      merged.required = [...(merged.required || []), ...schema2.required];
    }

    // Merge string constraints (take most restrictive)
    if (schema2.minLength !== undefined) {
      merged.minLength = Math.max(merged.minLength || 0, schema2.minLength);
    }
    if (schema2.maxLength !== undefined) {
      merged.maxLength = merged.maxLength !== undefined 
        ? Math.min(merged.maxLength, schema2.maxLength)
        : schema2.maxLength;
    }
    if (schema2.pattern) {
      merged.pattern = schema2.pattern; // Later pattern overwrites
    }

    // Merge number constraints
    if (schema2.minimum !== undefined) {
      merged.minimum = Math.max(merged.minimum || -Infinity, schema2.minimum);
    }
    if (schema2.maximum !== undefined) {
      merged.maximum = merged.maximum !== undefined
        ? Math.min(merged.maximum, schema2.maximum)
        : schema2.maximum;
    }

    // Other properties
    if (schema2.format) merged.format = schema2.format;
    if (schema2.description) merged.description = schema2.description;
    if (schema2.default !== undefined) merged.default = schema2.default;

    return merged;
  }
}

/**
 * Utility function to convert JSON Schema to Zod
 */
export function jsonSchemaToZod(schema: JsonSchema, options?: ConversionOptions): z.ZodTypeAny {
  const converter = new JsonSchemaToZod(options);
  return converter.convert(schema);
}

/**
 * Convert MCP tool input schema to Zod schema
 */
export function mcpToolSchemaToZod(inputSchema: JsonSchema): z.ZodTypeAny {
  return jsonSchemaToZod(inputSchema, {
    strictMode: false,
    allowUnknownFormats: true,
    defaultToOptional: true,
    preserveDescriptions: true,
  });
}