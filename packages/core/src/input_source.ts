import * as readline from 'node:readline/promises';
import type { Metadata } from './metadata';

/**
 * Interface for input sources that can provide user input
 */
export interface InputSource {
  /**
   * Get input with optional context
   * @param context Input context including description and optional default value
   * @returns Promise resolving to the input string
   */
  getInput(context: { metadata?: Metadata }): Promise<string>;
}

/**
 * Static input source that returns the same input every time
 */
export class StaticInputSource implements InputSource {
  constructor(private input: string) {
    this.input = input;
  }

  async getInput(): Promise<string> {
    return this.input;
  }
}

/**
 * Input source that allows programmatic input via a callback function
 */

// TODO: Remove description, defaultValue from the callback?
export class CallbackInputSource implements InputSource {
  constructor(
    private callback: (context: {
      description: string;
      defaultValue?: string;
      metadata?: Metadata;
    }) => Promise<string>,
  ) {}

  async getInput(context: {
    description: string;
    defaultValue?: string;
    metadata?: Metadata;
  }): Promise<string> {
    return this.callback(context);
  }
}

/**
 * Input source that reads from command line interface
 */
export class CLIInputSource implements InputSource {
  private rl: readline.Interface;
  private description: string;
  private defaultValue?: string;

  constructor(description: string, defaultValue?: string) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.description = description;
    this.defaultValue = defaultValue;
  }

  async getInput(context?: { metadata?: Metadata }): Promise<string> {
    // Prompt the user for input
    let prompt = this.description
      ? `${this.description} (default: ${this.defaultValue}): `
      : `Input: `;
    // Read input from the command line
    const input = await this.rl.question(prompt);

    // If input is empty and default value exists, return default
    if (input.trim() === '' && this.defaultValue) {
      return this.defaultValue;
    }
    // If input is empty and no default value, ask again
    if (input.trim() === '' && !this.defaultValue) {
      console.log('Input cannot be empty. Please try again.');
      return this.getInput(context);
    }
    // Return the input
    return input;
  }

  /**
   * Close the readline interface
   * Should be called when the CLI input source is no longer needed
   */
  close(): void {
    this.rl.close();
  }
}
