/**
 * Custom validator implementation
 */
import { type Session } from '../session';
import { BaseValidator, type TValidationResult } from './base';

/**
 * Validator that uses a custom function to validate content
 */
export class CustomValidator extends BaseValidator {
  private validateFn: (
    content: string,
    context?: Session,
  ) => Promise<TValidationResult> | TValidationResult;

  constructor(
    validateFn: (
      content: string,
      context?: Session,
    ) => Promise<TValidationResult> | TValidationResult,
    options?: {
      description?: string;
      maxAttempts?: number;
      raiseErrorAfterMaxAttempts?: boolean;
    },
  ) {
    super({
      description: options?.description || 'Custom validation',
      maxAttempts: options?.maxAttempts,
      raiseErrorAfterMaxAttempts: options?.raiseErrorAfterMaxAttempts,
    });
    this.validateFn = validateFn;
  }

  async validate(
    content: string,
    context: Session,
  ): Promise<TValidationResult> {
    return this.validateFn(content, context);
  }

  getDescription(): string {
    return this.description || 'Custom validation';
  }

  getErrorMessage(): string {
    return `Validation failed: ${this.getDescription()}`;
  }
}
