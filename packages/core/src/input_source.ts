import * as readline from 'node:readline/promises';

/**
 * Static input source that returns the same input every time
 */
export class StaticInputSource implements InputSource {
  constructor(private input: string) {}

  async getInput(_context: {
    description: string;
    defaultValue?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    return this.input;
  }
}

/**
 * Interface for input sources that can provide user input
 */
export interface InputSource {
  /**
   * Get input with optional context
   * @param context Input context including description and optional default value
   * @returns Promise resolving to the input string
   */
  getInput(context: {
    description: string;
    defaultValue?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string>;
}

/**
 * Default input source that returns the default value or empty string
 */
export class DefaultInputSource implements InputSource {
  async getInput(context: { defaultValue?: string }): Promise<string> {
    return context.defaultValue ?? '';
  }
}

/**
 * Input source that allows programmatic input via a callback function
 */
export class CallbackInputSource implements InputSource {
  constructor(
    private callback: (context: {
      description: string;
      defaultValue?: string;
      metadata?: Record<string, unknown>;
    }) => Promise<string>,
  ) {}

  async getInput(context: {
    description: string;
    defaultValue?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    return this.callback(context);
  }
}

/**
 * Input source that reads from command line interface
 */
export class CLIInputSource implements InputSource {
  private rl: readline.Interface;

  constructor(
    customReadline?: readline.Interface
  ) {
    this.rl = customReadline || readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async getInput(context: {
    description: string;
    defaultValue?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const defaultPrompt = context.defaultValue
      ? ` (default: ${context.defaultValue})`
      : '';
    const prompt = `${context.description}${defaultPrompt}: `;

    const input = await this.rl.question(prompt);

    // If input is empty and default value exists, return default
    if (!input && context.defaultValue !== undefined) {
      return context.defaultValue;
    }

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
