// src/validator/base.ts
import { type Session, type SchemaType } from './types';

export interface SuccessValidationResult {
  isValid: true;
}
export interface FailureValidationResult {
  isValid: false;
  instruction: string;
}
export type ValidationResult =
  | SuccessValidationResult
  | FailureValidationResult;

export type ValidationFailHandler = (
  session: Session,
  result: ValidationResult,
  attempt: number,
  maxAttempts: number,
) => Promise<Session>;

/**
 * Interface for Validator
 */
export interface IValidator {
  validate(content: string, context: Session): Promise<ValidationResult>;
  getDescription(): string;
  getErrorMessage(): string;
}

/**
 * Base validator class for validating content.
 *
 * This abstract class provides core functionality for content validation with options
 * for retrying validation and handling validation failures.
 */
export abstract class BaseValidator {
  /**
   * Description to provide users or LLMs about the input text restrictions
   */
  protected description?: string;

  /**
   * Maximum number of validation attempts before giving up
   * If raiseErrorAfterMaxAttempts is true, an error will be raised after reaching this limit
   */
  protected maxAttempts?: number;

  /**
   * Whether to raise an error after maxAttempts is reached
   * If false, execution will continue despite validation failures
   * @default true
   */
  protected raiseErrorAfterMaxAttempts: boolean = true;

  /**
   * Creates a new validator
   * @param options - Configuration options for the validator
   * @param options.description - Text describing the validation constraints
   * @param options.maxAttempts - Maximum number of validation attempts (default: Infinity)
   * @param options.raiseErrorAfterMaxAttempts - Whether to throw an error after max attempts (default: true)
   */
  constructor(options: {
    description: string;
    maxAttempts?: number;
    raiseErrorAfterMaxAttempts?: boolean;
  }) {
    this.description = options.description;
    this.maxAttempts = options.maxAttempts;
    this.raiseErrorAfterMaxAttempts =
      options.raiseErrorAfterMaxAttempts ?? true;
  }
  /**
   * Validates the given content within the provided session context
   * @param content - The text content to validate
   * @param context - The session context for validation
   * @returns A promise resolving to the validation result
   */
  abstract validate(
    content: string,
    context: Session,
  ): Promise<ValidationResult>;
}

/**
 * 複数のバリデータを論理演算子で結合するための基底クラス
 */
export abstract class CompositeValidator extends BaseValidator {
  protected validators: IValidator[];

  constructor(
    validators: IValidator[],
    options: {
      description: string;
      maxAttempts?: number;
      raiseErrorAfterMaxAttempts?: boolean;
    },
  ) {
    super(options);
    this.validators = validators;
  }
}

/**
 * AND条件でバリデータを結合（すべてのバリデータがパスする必要がある）
 */
export class AllValidator extends CompositeValidator {
  async validate(content: string, context: Session): Promise<ValidationResult> {
    const instructions: string[] = [];
    for (const validator of this.validators) {
      const result = await validator.validate(content, context);
      if (!result.isValid) {
        instructions.push(result.instruction);
      }
    }
    if (instructions.length > 0) {
      return {
        isValid: false,
        instruction: `${instructions.join('\n')}`,
      };
    } else {
      return { isValid: true };
    }
  }
}

/**
 * OR条件でバリデータを結合（少なくとも1つのバリデータがパスする必要がある）
 */
export class AnyValidator extends CompositeValidator {
  async validate(content: string, context: Session): Promise<ValidationResult> {
    const instructions: string[] = [];
    for (const validator of this.validators) {
      const result = await validator.validate(content, context);
      if (result.isValid) {
        return { isValid: true };
      } else {
        instructions.push(result.instruction);
      }
    }
    return {
      isValid: false,
      instruction: `None of the following validators passed. Any of the following instructions should be followed:\n${instructions.join('\n')}`,
    };
  }
}

/**
 * Validator that checks if content matches a regular expression
 */
export class RegexMatchValidator extends BaseValidator {
  private regex: RegExp;

  constructor(options: { regex: RegExp | string; description?: string }) {
    super({
      description: options.description || `Result must match ${options.regex}`,
    });
    this.regex =
      options.regex instanceof RegExp
        ? options.regex
        : new RegExp(options.regex);
  }

  async validate(content: string, context: Session): Promise<ValidationResult> {
    const passed = this.regex.test(content);
    return passed 
      ? { isValid: true } 
      : { 
          isValid: false, 
          instruction: this.getDescription()
        };
  }

  getDescription(): string {
    return this.description || `Result must match ${this.regex}`;
  }

  getErrorMessage(): string {
    return `Validation failed: ${this.getDescription()}`;
  }
}

/**
 * Validator that checks if content does NOT match a regular expression
 */
export class RegexNoMatchValidator extends BaseValidator {
  private regex: RegExp;

  constructor(options: { regex: RegExp | string; description?: string }) {
    super({
      description: options.description || `Result must not match ${options.regex}`,
    });
    this.regex =
      options.regex instanceof RegExp
        ? options.regex
        : new RegExp(options.regex);
  }

  async validate(content: string, context: Session): Promise<ValidationResult> {
    const passed = !this.regex.test(content);
    return passed 
      ? { isValid: true } 
      : { 
          isValid: false, 
          instruction: this.getDescription()
        };
  }

  getDescription(): string {
    return this.description || `Result must not match ${this.regex}`;
  }

  getErrorMessage(): string {
    return `Validation failed: ${this.getDescription()}`;
  }
}

/**
 * Validator that checks if content contains specific keywords
 */
export class KeywordValidator extends BaseValidator {
  private keywords: string[];
  private mode: 'include' | 'exclude';
  private caseSensitive: boolean;

  constructor(options: {
    keywords: string[];
    mode: 'include' | 'exclude';
    description?: string;
    caseSensitive?: boolean;
  }) {
    const action =
      options.mode === 'include' ? 'must include' : 'must not include';
    
    super({
      description: options.description ||
        `Result ${action} one of these keywords: ${options.keywords.join(', ')}`,
    });
    
    this.keywords = options.caseSensitive
      ? options.keywords
      : options.keywords.map((k) => k.toLowerCase());
    this.mode = options.mode;
    this.caseSensitive = options.caseSensitive || false;
  }

  async validate(content: string, context: Session): Promise<ValidationResult> {
    const normalizedContent = !this.caseSensitive
      ? content.toLowerCase()
      : content;

    const hasKeyword = this.keywords.some((keyword) =>
      normalizedContent.includes(keyword),
    );

    const passed = this.mode === 'include' ? hasKeyword : !hasKeyword;

    return passed 
      ? { isValid: true } 
      : { 
          isValid: false, 
          instruction: this.getDescription()
        };
  }

  getDescription(): string {
    const action = this.mode === 'include' ? 'must include' : 'must not include';
    return this.description || `Result ${action} one of these keywords: ${this.keywords.join(', ')}`;
  }

  getErrorMessage(): string {
    return `Validation failed: ${this.getDescription()}`;
  }
}

/**
 * Validator that checks if content length is within specified limits
 */
export class LengthValidator extends BaseValidator {
  private min?: number;
  private max?: number;

  constructor(options: { min?: number; max?: number; description?: string }) {
    let constraint = '';
    if (options.min !== undefined && options.max !== undefined) {
      constraint = `between ${options.min} and ${options.max}`;
    } else if (options.min !== undefined) {
      constraint = `at least ${options.min}`;
    } else if (options.max !== undefined) {
      constraint = `at most ${options.max}`;
    }

    super({
      description: options.description || `Content length must be ${constraint} characters`,
    });
    
    this.min = options.min;
    this.max = options.max;
  }

  async validate(content: string, context: Session): Promise<ValidationResult> {
    const length = content.length;

    let passed = true;
    if (this.min !== undefined && length < this.min) {
      passed = false;
    }
    if (this.max !== undefined && length > this.max) {
      passed = false;
    }

    return passed 
      ? { isValid: true } 
      : { 
          isValid: false, 
          instruction: `${this.getDescription()} (current: ${length})`
        };
  }

  getDescription(): string {
    let constraint = '';
    if (this.min !== undefined && this.max !== undefined) {
      constraint = `between ${this.min} and ${this.max}`;
    } else if (this.min !== undefined) {
      constraint = `at least ${this.min}`;
    } else if (this.max !== undefined) {
      constraint = `at most ${this.max}`;
    }
    return this.description || `Content length must be ${constraint} characters`;
  }

  getErrorMessage(): string {
    return `Validation failed: ${this.getDescription()}`;
  }
}

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

  async validate(content: string, context: Session): Promise<ValidationResult> {
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
 * Validator that uses a custom function to validate content
 */
export class CustomValidator extends BaseValidator {
  private validateFn: (
    content: string,
    context?: Session
  ) => Promise<ValidationResult> | ValidationResult;

  constructor(
    validateFn: (
      content: string,
      context?: Session
    ) => Promise<ValidationResult> | ValidationResult,
    options?: {
      description?: string;
    }
  ) {
    super({
      description: options?.description || 'Custom validation',
    });
    this.validateFn = validateFn;
  }

  async validate(content: string, context: Session): Promise<ValidationResult> {
    return this.validateFn(content, context);
  }

  getDescription(): string {
    return this.description || 'Custom validation';
  }

  getErrorMessage(): string {
    return `Validation failed: ${this.getDescription()}`;
  }
}

/**
 * Validator that checks if content matches a specified schema
 */
export class SchemaValidator<T extends SchemaType> extends BaseValidator {
  private schema: T;

  constructor(options: { schema: T; description?: string }) {
    super({
      description: options.description || 'Content must match the specified schema',
    });
    this.schema = options.schema;
  }

  async validate(content: string, context: Session): Promise<ValidationResult> {
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
    schema: SchemaType,
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
