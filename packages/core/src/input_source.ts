import * as readline from 'node:readline/promises';
import type { Metadata } from './metadata';
import { type IValidator } from './validators/base';
import type { ISession } from './types';

/**
 * Interface for input sources that can provide user input
 */
export interface InputSource {
  /**
   * Get input with optional context
   * @param context Input context including metadata
   * @returns Promise resolving to the input string
   */
  getInput(context: { metadata: Metadata }): Promise<string>;

  /**
   * Get the validator associated with this input source
   * @returns The validator or undefined if no validator is set
   */
  getValidator(): IValidator | undefined;
}

/**
 * Static input source that returns the same input every time
 */
export class StaticInputSource implements InputSource {
  constructor(private input: string) {
    this.input = input;
  }

  async getInput(_context?: { metadata?: Metadata }): Promise<string> {
    return this.input;
  }

  getValidator(): IValidator | undefined {
    return undefined;
  }
}

/**
 * Input source that allows programmatic input via a callback function
 *
 * TODO: Remove description, defaultValue from the callback?
 */
export class CallbackInputSource implements InputSource {
  private validator?: IValidator;
  private maxAttempts: number;
  private raiseError: boolean;

  constructor(
    private callback: (context: { metadata?: Metadata }) => Promise<string>,
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    if (
      validatorOrOptions &&
      typeof validatorOrOptions === 'object' &&
      !('validate' in validatorOrOptions)
    ) {
      this.validator = validatorOrOptions.validator;
      this.maxAttempts = validatorOrOptions.maxAttempts ?? 1;
      this.raiseError = validatorOrOptions.raiseError ?? true;
    } else {
      this.validator = validatorOrOptions as IValidator | undefined;
      this.maxAttempts = 1;
      this.raiseError = true;
    }
  }

  async getInput(context?: { metadata?: Metadata }): Promise<string> {
    if (!this.validator) {
      return this.callback(context || {});
    }

    let attempts = 0;
    let lastValidationError: string | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;

      const input = await this.callback(context || {});
      const result = await this.validator.validate(input, {
        metadata: context?.metadata || {},
      } as ISession);

      if (result.isValid) {
        return input;
      }

      lastValidationError = result.instruction || 'Invalid input';

      if (attempts >= this.maxAttempts && this.raiseError) {
        throw new Error(
          `Input validation failed after ${attempts} attempts: ${lastValidationError}`,
        );
      }
    }

    return this.callback(context || {});
  }

  getValidator(): IValidator | undefined {
    return this.validator;
  }
}

/**
 * Input source that reads from command line interface
 */
export class CLIInputSource implements InputSource {
  private rl!: readline.Interface;
  private description: string;
  private defaultValue?: string;
  private validator?: IValidator;
  private maxAttempts: number;
  private raiseError: boolean;

  constructor(
    customReadline?: readline.Interface,
    description?: string,
    defaultValue?: string,
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    this.description = description || 'Input>';
    this.defaultValue = defaultValue;

    if (
      validatorOrOptions &&
      typeof validatorOrOptions === 'object' &&
      !('validate' in validatorOrOptions)
    ) {
      this.validator = validatorOrOptions.validator;
      this.maxAttempts = validatorOrOptions.maxAttempts ?? 1;
      this.raiseError = validatorOrOptions.raiseError ?? true;
    } else {
      this.validator = validatorOrOptions as IValidator | undefined;
      this.maxAttempts = 1;
      this.raiseError = true;
    }

    this.rl =
      customReadline ||
      readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
  }

  async getInput(context?: { metadata?: Metadata }): Promise<string> {
    if (this.defaultValue) {
      const defaultInput = this.defaultValue;

      if (this.validator) {
        const result = await this.validator.validate(defaultInput, {
          metadata: context?.metadata || {},
        } as ISession);
        if (!result.isValid) {
          if (this.raiseError) {
            throw new Error(
              `Default input validation failed: ${result.instruction || 'Invalid input'}`,
            );
          }
        } else {
          return defaultInput;
        }
      } else {
        return defaultInput;
      }
    }

    const prompt = this.description
      ? `${this.description} (default: ${this.defaultValue}): `
      : `Input: `;

    let attempts = 0;
    let lastValidationError: string | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;

      let input = await this.rl.question(prompt);

      if (input.trim() === '' && this.defaultValue) {
        input = this.defaultValue;
      }

      if (input.trim() === '' && !this.defaultValue) {
        console.log(
          'Input cannot be empty without a default value. Asking again...',
        );
        continue;
      }

      if (this.validator) {
        const result = await this.validator.validate(input, {
          metadata: context?.metadata || {},
        } as ISession);
        if (result.isValid) {
          return input;
        }

        lastValidationError = result.instruction || 'Invalid input';
        console.log(
          `Input validation failed: ${lastValidationError}. Please try again.`,
        );

        if (attempts >= this.maxAttempts && this.raiseError) {
          throw new Error(
            `Input validation failed after ${attempts} attempts: ${lastValidationError}`,
          );
        }
      } else {
        return input;
      }
    }

    let finalInput = await this.rl.question(prompt);

    if (finalInput.trim() === '' && this.defaultValue) {
      finalInput = this.defaultValue;
    }

    return finalInput;
  }

  getValidator(): IValidator | undefined {
    return this.validator;
  }

  /**
   * Close the readline interface
   * Should be called when the CLI input source is no longer needed
   */
  close(): void {
    this.rl.close();
  }
}
