import * as readline from 'node:readline/promises';
import type { Metadata } from './metadata';
import { type IValidator } from './validator';

/**
 * Interface for input sources that can provide user input
 */
export interface InputSource {
  /**
   * Get input with optional context
   * @param context Input context including metadata
   * @returns Promise resolving to the input string
   */
  getInput(context?: { metadata?: Metadata }): Promise<string>;
  
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
  private validator?: IValidator;

  constructor(private input: string, validator?: IValidator) {
    this.input = input;
    this.validator = validator;
  }

  async getInput(context?: { metadata?: Metadata }): Promise<string> {
    if (this.validator) {
      const result = await this.validator.validate(this.input, context?.metadata as any);
      if (!result.isValid) {
        throw new Error(`Input validation failed: ${result.instruction || 'Invalid input'}`);
      }
    }
    return this.input;
  }

  getValidator(): IValidator | undefined {
    return this.validator;
  }
}

/**
 * Input source that allows programmatic input via a callback function
 */

// TODO: Remove description, defaultValue from the callback?
export class CallbackInputSource implements InputSource {
  private validator?: IValidator;

  constructor(
    private callback: (context: { metadata?: Metadata }) => Promise<string>,
    validator?: IValidator
  ) {
    this.validator = validator;
  }

  async getInput(context?: { metadata?: Metadata }): Promise<string> {
    const input = await this.callback(context || {});
    
    if (this.validator) {
      const result = await this.validator.validate(input, context?.metadata as any);
      if (!result.isValid) {
        throw new Error(`Input validation failed: ${result.instruction || 'Invalid input'}`);
      }
    }
    
    return input;
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

  constructor(
    customReadline?: readline.Interface,
    description?: string,
    defaultValue?: string,
    validator?: IValidator,
  ) {
    this.description = description || 'Input>';
    this.defaultValue = defaultValue;
    this.validator = validator;
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
        const result = await this.validator.validate(defaultInput, context?.metadata as any);
        if (!result.isValid) {
          throw new Error(`Default input validation failed: ${result.instruction || 'Invalid input'}`);
        }
      }
      
      return defaultInput;
    }

    const prompt = this.description
      ? `${this.description} (default: ${this.defaultValue}): `
      : `Input: `;
    
    let input = await this.rl.question(prompt);

    if (input.trim() === '' && this.defaultValue) {
      input = this.defaultValue;
    }
    
    if (input.trim() === '' && !this.defaultValue) {
      console.log(
        'Input cannot be empty without a default value. Asking again...',
      );
      return this.getInput(context);
    }
    
    if (this.validator) {
      const result = await this.validator.validate(input, context?.metadata as any);
      if (!result.isValid) {
        console.log(`Input validation failed: ${result.instruction || 'Invalid input'}. Please try again.`);
        return this.getInput(context);
      }
    }
    
    // Return the input
    return input;
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
