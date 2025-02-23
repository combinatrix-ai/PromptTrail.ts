import { Metadata } from './metadata';

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
