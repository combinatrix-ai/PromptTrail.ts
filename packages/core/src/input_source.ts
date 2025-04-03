import * as readline from 'node:readline/promises';
import type { Metadata } from './metadata';

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
}

/**
 * Input source that allows programmatic input via a callback function
 */

// TODO: Remove description, defaultValue from the callback?
export class CallbackInputSource implements InputSource {
  constructor(
    private callback: (context: { metadata?: Metadata }) => Promise<string>,
  ) {}

  async getInput(context?: { metadata?: Metadata }): Promise<string> {
    return this.callback(context || {});
  }
}

/**
 * Input source that reads from command line interface
 */
export class CLIInputSource implements InputSource {
  private rl!: readline.Interface;
  private description: string;
  private defaultValue?: string;

  constructor(
    customReadline?: readline.Interface,
    description?: string,
    defaultValue?: string,
  ) {
    this.description = description || 'Input>';
    this.defaultValue = defaultValue;
    this.rl =
      customReadline ||
      readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
  }

  async getInput(context?: { metadata?: Metadata }): Promise<string> {
    if (this.defaultValue) {
      return this.defaultValue;
    }

    const prompt = this.description
      ? `${this.description} (default: ${this.defaultValue}): `
      : `Input: `;
    const input = await this.rl.question(prompt);

    if (input.trim() === '' && this.defaultValue) {
      return this.defaultValue;
    }
    if (input.trim() === '' && !this.defaultValue) {
      console.log(
        'Input cannot be empty without a default value. Asking again...',
      );
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
