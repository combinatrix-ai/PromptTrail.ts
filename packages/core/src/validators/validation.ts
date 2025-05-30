/**
 * Validation namespace providing factory methods for creating validators
 */

import type { IValidator, TValidationResult } from './base';
import { RegexMatchValidator, RegexNoMatchValidator, KeywordValidator, LengthValidator } from './text';
import { JsonValidator, SchemaValidator } from './schema';
import { CustomValidator } from './custom';
import { AllValidator, AnyValidator } from './composite';
import type { SchemaType } from '../templates/primitives/structured';
import type { Session } from '../session';

export interface RegexOptions {
  flags?: string;
  noMatch?: boolean;
  description?: string;
}

export interface LengthOptions {
  min?: number;
  max?: number;
  description?: string;
}

export interface KeywordOptions {
  mode?: 'include' | 'exclude';
  caseSensitive?: boolean;
  description?: string;
}

/**
 * Validation namespace providing factory methods for creating validators
 */
export namespace Validation {
  /**
   * Create a regex validator
   * @param pattern - The regex pattern to match
   * @param options - Optional configuration
   */
  export function regex(pattern: string | RegExp, options?: RegexOptions): IValidator {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, options?.flags);
    return options?.noMatch
      ? new RegexNoMatchValidator({ regex, description: options?.description })
      : new RegexMatchValidator({ regex, description: options?.description });
  }

  /**
   * Create a keyword validator
   * @param keywords - Keywords to check for
   * @param options - Optional configuration
   */
  export function keyword(
    keywords: string | string[],
    options?: KeywordOptions
  ): IValidator {
    const keywordArray = Array.isArray(keywords) ? keywords : [keywords];
    return new KeywordValidator({
      keywords: keywordArray,
      mode: options?.mode || 'include',
      caseSensitive: options?.caseSensitive,
      description: options?.description
    });
  }

  /**
   * Create a length validator
   * @param options - Length constraints
   */
  export function length(options: LengthOptions): IValidator {
    return new LengthValidator({
      min: options.min,
      max: options.max,
      description: options.description
    });
  }

  /**
   * Create a JSON validator
   * @param options - Optional JSON validation options
   */
  export function json(options?: { schema?: Record<string, unknown>; description?: string }): IValidator {
    return new JsonValidator(options);
  }

  /**
   * Create a schema validator
   * @param schema - Schema to validate against
   * @param description - Optional description
   */
  export function schema<T extends SchemaType>(schema: T, description?: string): IValidator {
    return new SchemaValidator({ schema, description });
  }

  /**
   * Create a custom validator
   * @param validateFn - Custom validation function
   * @param options - Optional configuration
   */
  export function custom(
    validateFn: (content: string, context?: Session) => TValidationResult | Promise<TValidationResult> | boolean | Promise<boolean>,
    options?: { description?: string; maxAttempts?: number; raiseErrorAfterMaxAttempts?: boolean }
  ): IValidator {
    // Wrap simple boolean validators to return TValidationResult
    const wrappedFn = async (content: string, context?: Session): Promise<TValidationResult> => {
      const result = await validateFn(content, context);
      if (typeof result === 'boolean') {
        return result 
          ? { isValid: true } 
          : { isValid: false, instruction: options?.description || 'Validation failed' };
      }
      return result;
    };
    
    return new CustomValidator(wrappedFn, options);
  }

  /**
   * Combine multiple validators with AND logic (all must pass)
   * @param validators - Validators to combine
   * @param description - Optional description
   */
  export function all(validators: IValidator[], description?: string): IValidator {
    return new AllValidator(validators, {
      description: description || 'All validators must pass'
    });
  }

  /**
   * Combine multiple validators with OR logic (at least one must pass)
   * @param validators - Validators to combine
   * @param description - Optional description
   */
  export function any(validators: IValidator[], description?: string): IValidator {
    return new AnyValidator(validators, {
      description: description || 'At least one validator must pass'
    });
  }
}