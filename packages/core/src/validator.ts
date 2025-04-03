// src/validator/base.ts
import { type Session } from './types';

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
