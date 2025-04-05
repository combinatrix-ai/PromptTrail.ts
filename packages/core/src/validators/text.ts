/**
 * Text-based validators for content validation
 */
import { BaseValidator, type TValidationResult } from './base';

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

  async validate(content: string, /* unused */): Promise<TValidationResult> {
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

  async validate(content: string, /* unused */): Promise<TValidationResult> {
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

  async validate(content: string, /* unused */): Promise<TValidationResult> {
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

  async validate(content: string, /* unused */): Promise<TValidationResult> {
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
