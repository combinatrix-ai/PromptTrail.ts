
import { type ISession } from '../types';

/**
 * Represents a successful validation result
 */
export interface ISuccessValidationResult {
  isValid: true;
}

/**
 * Represents a failed validation result with instruction for correction
 */
export interface IFailureValidationResult {
  isValid: false;
  instruction: string;
}

/**
 * Union type for validation results
 */
export type TValidationResult =
  | ISuccessValidationResult
  | IFailureValidationResult;

/**
 * Function type for handling validation failures
 */
export type TValidationFailHandler = (
  session: ISession,
  result: TValidationResult,
  attempt: number,
  maxAttempts: number,
) => Promise<ISession>;

/**
 * Interface for validator implementations
 */
export interface IValidator {
  validate(content: string, context: ISession): Promise<TValidationResult>;
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
    context: ISession,
  ): Promise<TValidationResult>;
}
