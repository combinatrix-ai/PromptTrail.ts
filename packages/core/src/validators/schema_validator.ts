import { BaseValidator } from './base_validators';
import type { ValidationResult } from '../templates/guardrail_template';
import type { SchemaType } from '../tool';

/**
 * Validator that checks if content matches a specified schema
 */
export class SchemaValidator<T extends SchemaType> extends BaseValidator {
  private schema: T;
  private description: string;

  constructor(options: { schema: T; description?: string }) {
    super();
    this.schema = options.schema;
    this.description =
      options.description || 'Content must match the specified schema';
  }

  async validate(content: string): Promise<ValidationResult> {
    try {
      const json = JSON.parse(content);

      // Validate against schema
      const validationErrors = this.validateSchema(this.schema, json);

      if (validationErrors.length > 0) {
        return this.createResult(false, {
          feedback: `Schema validation failed: ${validationErrors.join(', ')}`,
        });
      }

      return this.createResult(true);
    } catch (error) {
      return this.createResult(false, {
        feedback: `Invalid JSON: ${(error as Error).message}`,
      });
    }
  }

  private validateSchema(
    schema: SchemaType,
    value: Record<string, unknown>,
  ): string[] {
    const errors: string[] = [];

    // Check required properties
    if (schema.required) {
      for (const required of schema.required) {
        if (value[required] === undefined) {
          errors.push(`Missing required property: ${required}`);
        }
      }
    }

    // Validate property types
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const propValue = value[key];
      if (propValue !== undefined) {
        if (propSchema.type === 'string' && typeof propValue !== 'string') {
          errors.push(`Property ${key} must be a string`);
        } else if (
          propSchema.type === 'number' &&
          typeof propValue !== 'number'
        ) {
          errors.push(`Property ${key} must be a number`);
        } else if (
          propSchema.type === 'boolean' &&
          typeof propValue !== 'boolean'
        ) {
          errors.push(`Property ${key} must be a boolean`);
        }
      }
    }

    return errors;
  }
}
