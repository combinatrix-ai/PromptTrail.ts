/**
 * Schema validators for structured data validation
 */
import { type ISession, type ISchemaType } from '../types';
import { BaseValidator, type TValidationResult } from './base';

/**
 * Validator that checks if content is valid JSON
 */
export class JsonValidator extends BaseValidator {
  private schema?: Record<string, unknown>;

  constructor(options?: {
    schema?: Record<string, unknown>;
    description?: string;
  }) {
    super({
      description: options?.description || 'Content must be valid JSON',
    });
    this.schema = options?.schema;
  }

  async validate(content: string, /* unused */): Promise<TValidationResult> {
    try {
      const json = JSON.parse(content);

      if (this.schema) {
        for (const [key, value] of Object.entries(this.schema)) {
          if (
            value === true &&
            (json[key] === undefined || json[key] === null)
          ) {
            return {
              isValid: false,
              instruction: `Required field "${key}" is missing`
            };
          }
        }
      }

      return { isValid: true };
    } catch (error) {
      return {
        isValid: false,
        instruction: `Invalid JSON: ${(error as Error).message}`
      };
    }
  }

  getDescription(): string {
    return this.description || 'Content must be valid JSON';
  }

  getErrorMessage(): string {
    return `Validation failed: ${this.getDescription()}`;
  }
}

/**
 * Validator that checks if content matches a specified schema
 */
export class SchemaValidator<T extends ISchemaType> extends BaseValidator {
  private schema: T;

  constructor(options: { schema: T; description?: string }) {
    super({
      description: options.description || 'Content must match the specified schema',
    });
    this.schema = options.schema;
  }

  async validate(content: string, /* unused */): Promise<TValidationResult> {
    try {
      const json = JSON.parse(content);

      const validationErrors = this.validateSchema(this.schema, json);

      if (validationErrors.length > 0) {
        return {
          isValid: false,
          instruction: `Schema validation failed: ${validationErrors.join(', ')}`
        };
      }

      return { isValid: true };
    } catch (error) {
      return {
        isValid: false,
        instruction: `Invalid JSON: ${(error as Error).message}`
      };
    }
  }

  private validateSchema(
    schema: ISchemaType,
    value: Record<string, unknown>,
  ): string[] {
    const errors: string[] = [];

    if (schema.required) {
      for (const required of schema.required) {
        if (value[required] === undefined) {
          errors.push(`Missing required property: ${required}`);
        }
      }
    }

    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const propValue = value[key];
      if (propValue !== undefined) {
        const typedPropSchema = propSchema as { type: string };
        if (typedPropSchema.type === 'string' && typeof propValue !== 'string') {
          errors.push(`Property ${key} must be a string`);
        } else if (
          typedPropSchema.type === 'number' &&
          typeof propValue !== 'number'
        ) {
          errors.push(`Property ${key} must be a number`);
        } else if (
          typedPropSchema.type === 'boolean' &&
          typeof propValue !== 'boolean'
        ) {
          errors.push(`Property ${key} must be a boolean`);
        }
      }
    }

    return errors;
  }

  getDescription(): string {
    return this.description || 'Content must match the specified schema';
  }

  getErrorMessage(): string {
    return `Validation failed: ${this.getDescription()}`;
  }
}
