import type {
  Validator,
  ValidationResult,
} from '../templates/guardrail_template';

/**
 * Base class for validators
 */
export abstract class BaseValidator implements Validator {
  /**
   * Validate content against specific criteria
   */
  abstract validate(content: string): Promise<ValidationResult>;

  /**
   * Create a validation result object
   */
  protected createResult(
    passed: boolean,
    options?: {
      score?: number;
      feedback?: string;
      fix?: string;
    },
  ): ValidationResult {
    return {
      passed,
      score: options?.score,
      feedback: options?.feedback,
      fix: options?.fix,
    };
  }
}

/**
 * Validator that checks if content matches a regular expression
 */
export class RegexMatchValidator extends BaseValidator {
  private regex: RegExp;
  private description: string;

  constructor(options: { regex: RegExp | string; description?: string }) {
    super();
    this.regex =
      options.regex instanceof RegExp
        ? options.regex
        : new RegExp(options.regex);
    this.description = options.description || `Result must match ${this.regex}`;
  }

  async validate(content: string): Promise<ValidationResult> {
    const passed = this.regex.test(content);
    return this.createResult(passed, {
      feedback: passed ? undefined : this.description,
    });
  }
}

/**
 * Validator that checks if content does NOT match a regular expression
 */
export class RegexNoMatchValidator extends BaseValidator {
  private regex: RegExp;
  private description: string;

  constructor(options: { regex: RegExp | string; description?: string }) {
    super();
    this.regex =
      options.regex instanceof RegExp
        ? options.regex
        : new RegExp(options.regex);
    this.description =
      options.description || `Result must not match ${this.regex}`;
  }

  async validate(content: string): Promise<ValidationResult> {
    const passed = !this.regex.test(content);
    return this.createResult(passed, {
      feedback: passed ? undefined : this.description,
    });
  }
}

/**
 * Validator that checks if content contains specific keywords
 */
export class KeywordValidator extends BaseValidator {
  private keywords: string[];
  private mode: 'include' | 'exclude';
  private description: string;

  constructor(options: {
    keywords: string[];
    mode: 'include' | 'exclude';
    description?: string;
    caseSensitive?: boolean;
  }) {
    super();
    this.keywords = options.caseSensitive
      ? options.keywords
      : options.keywords.map((k) => k.toLowerCase());
    this.mode = options.mode;

    const action =
      this.mode === 'include' ? 'must include' : 'must not include';
    this.description =
      options.description ||
      `Result ${action} one of these keywords: ${this.keywords.join(', ')}`;
  }

  async validate(content: string): Promise<ValidationResult> {
    const normalizedContent =
      this.keywords[0] === this.keywords[0].toLowerCase()
        ? content.toLowerCase()
        : content;

    const hasKeyword = this.keywords.some((keyword) =>
      normalizedContent.includes(keyword),
    );

    const passed = this.mode === 'include' ? hasKeyword : !hasKeyword;

    return this.createResult(passed, {
      feedback: passed ? undefined : this.description,
    });
  }
}

/**
 * Validator that checks if content length is within specified limits
 */
export class LengthValidator extends BaseValidator {
  private min?: number;
  private max?: number;
  private description: string;

  constructor(options: { min?: number; max?: number; description?: string }) {
    super();
    this.min = options.min;
    this.max = options.max;

    let constraint = '';
    if (this.min !== undefined && this.max !== undefined) {
      constraint = `between ${this.min} and ${this.max}`;
    } else if (this.min !== undefined) {
      constraint = `at least ${this.min}`;
    } else if (this.max !== undefined) {
      constraint = `at most ${this.max}`;
    }

    this.description =
      options.description || `Content length must be ${constraint} characters`;
  }

  async validate(content: string): Promise<ValidationResult> {
    const length = content.length;

    let passed = true;
    if (this.min !== undefined && length < this.min) {
      passed = false;
    }
    if (this.max !== undefined && length > this.max) {
      passed = false;
    }

    return this.createResult(passed, {
      feedback: passed ? undefined : `${this.description} (current: ${length})`,
    });
  }
}

/**
 * Validator that checks if content is valid JSON
 */
export class JsonValidator extends BaseValidator {
  private schema?: Record<string, unknown>;
  private description: string;

  constructor(options?: {
    schema?: Record<string, unknown>;
    description?: string;
  }) {
    super();
    this.schema = options?.schema;
    this.description = options?.description || 'Content must be valid JSON';
  }

  async validate(content: string): Promise<ValidationResult> {
    try {
      const json = JSON.parse(content);

      // If schema is provided, check if all required fields are present
      if (this.schema) {
        for (const [key, value] of Object.entries(this.schema)) {
          if (
            value === true &&
            (json[key] === undefined || json[key] === null)
          ) {
            return this.createResult(false, {
              feedback: `Required field "${key}" is missing`,
            });
          }
        }
      }

      return this.createResult(true);
    } catch (error) {
      return this.createResult(false, {
        feedback: `Invalid JSON: ${(error as Error).message}`,
      });
    }
  }
}

/**
 * Validator that combines multiple validators with AND logic
 */
export class AllValidator extends BaseValidator {
  private validators: Validator[];

  constructor(validators: Validator[]) {
    super();
    this.validators = validators;
  }

  async validate(content: string): Promise<ValidationResult> {
    const results = await Promise.all(
      this.validators.map((validator) => validator.validate(content)),
    );

    const passed = results.every((result) => result.passed);
    const failedResults = results.filter((result) => !result.passed);

    if (passed) {
      return this.createResult(true);
    } else {
      const feedback = failedResults
        .map((result) => result.feedback)
        .filter(Boolean)
        .join('; ');

      return this.createResult(false, { feedback });
    }
  }
}

/**
 * Validator that combines multiple validators with OR logic
 */
export class AnyValidator extends BaseValidator {
  private validators: Validator[];

  constructor(validators: Validator[]) {
    super();
    this.validators = validators;
  }

  async validate(content: string): Promise<ValidationResult> {
    const results = await Promise.all(
      this.validators.map((validator) => validator.validate(content)),
    );

    const passed = results.some((result) => result.passed);

    if (passed) {
      return this.createResult(true);
    } else {
      const feedback =
        'None of the validators passed: ' +
        results
          .map((result) => result.feedback)
          .filter(Boolean)
          .join('; ');

      return this.createResult(false, { feedback });
    }
  }
}

/**
 * Validator that uses a custom function to validate content
 */
export class CustomValidator extends BaseValidator {
  private validateFn: (
    content: string,
  ) => Promise<ValidationResult> | ValidationResult;

  constructor(
    validateFn: (
      content: string,
    ) => Promise<ValidationResult> | ValidationResult,
  ) {
    super();
    this.validateFn = validateFn;
  }

  async validate(content: string): Promise<ValidationResult> {
    return this.validateFn(content);
  }
}
