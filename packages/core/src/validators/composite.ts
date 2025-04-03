/**
 * Composite validators that combine multiple validators
 */
import { type ISession } from '../types';
import { BaseValidator, type IValidator, type TValidationResult } from './base';

/**
 * Base class for combining multiple validators using logical operators
 */
export abstract class CompositeValidator extends BaseValidator implements IValidator {
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
  
  abstract validate(content: string, context: ISession): Promise<TValidationResult>;
  
  getDescription(): string {
    return this.description || 'Composite validation';
  }
  
  getErrorMessage(): string {
    return `Validation failed: ${this.getDescription()}`;
  }
}

/**
 * Combines validators with AND condition (all validators must pass)
 */
export class AllValidator extends CompositeValidator {
  async validate(content: string, context: ISession): Promise<TValidationResult> {
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
 * Combines validators with OR condition (at least one validator must pass)
 */
export class AnyValidator extends CompositeValidator {
  async validate(content: string, context: ISession): Promise<TValidationResult> {
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
