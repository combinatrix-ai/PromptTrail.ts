// content_source.ts
import * as readline from 'node:readline/promises';
import { z } from 'zod';
import { ValidationError } from './errors';
import {
  generateText,
  generateWithSchema,
  SchemaGenerationOptions,
} from './generate';
import type { Session } from './session';
import type { Vars } from './tagged_record';
import { interpolateTemplate } from './utils/template_interpolation';
import type {
  IValidator,
  TValidationResult as ValidationResult,
} from './validators/base';

// --- Provider Types ---

/**
 * OpenAI provider configuration
 */
export interface OpenAIProviderConfig {
  type: 'openai';
  apiKey: string;
  modelName: string;
  baseURL?: string;
  organization?: string;
  dangerouslyAllowBrowser?: boolean;
}

/**
 * Anthropic provider configuration
 */
export interface AnthropicProviderConfig {
  type: 'anthropic';
  apiKey: string;
  modelName: string;
  baseURL?: string;
}

/**
 * Google provider configuration
 */
export interface GoogleProviderConfig {
  type: 'google';
  apiKey?: string;
  modelName: string;
  baseURL?: string;
}

/**
 * Provider configuration union type
 */
export type ProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | GoogleProviderConfig;

/**
 * LLM Generation Options
 */
export interface LLMOptions {
  provider: ProviderConfig;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  tools?: Record<string, unknown>;
  toolChoice?: 'auto' | 'required' | 'none';
  dangerouslyAllowBrowser?: boolean;
  sdkOptions?: Record<string, unknown>;
}

// --- Temporary Definitions (Move to appropriate files later) ---

/**
 * Interface for AI model outputs with metadata and structured data
 * (Equivalent to ModelContentOutput in the original file)
 */
export interface ModelOutput {
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
  structuredOutput?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Options for validation behavior
 */
export interface ValidationOptions {
  validator?: IValidator;
  maxAttempts?: number;
  raiseError?: boolean;
}

/**
 * Base class for all content sources (Renamed from ContentSource)
 */
export abstract class Source<T = unknown> {
  protected validator?: IValidator;
  protected maxAttempts: number;
  protected raiseError: boolean;

  constructor(options?: ValidationOptions) {
    this.validator = options?.validator;
    this.maxAttempts = options?.maxAttempts ?? 1;
    this.raiseError = options?.raiseError ?? true;
  }

  /**
   * Get content with session context
   * @param session Session context for content generation
   * @returns Promise resolving to content of type T
   */
  abstract getContent(session: Session<any, any>): Promise<T>;

  /**
   * Validates the given content once using the assigned validator.
   * Does NOT handle retries internally. Retries should be handled by the calling method (e.g., getContent).
   */
  protected async validateContent(
    content: string,
    session: Session<any, any>,
  ): Promise<ValidationResult> {
    if (!this.validator) {
      return { isValid: true }; // No validator means content is considered valid
    }
    // Perform a single validation attempt
    return this.validator.validate(content, session);
  }

  /**
   * Check if this content source has a validator
   * @returns True if a validator is available
   */
  hasValidator(): boolean {
    return !!this.validator;
  }

  /**
   * Get the validator associated with this content source
   * @returns The validator or undefined if no validator is set
   */
  getValidator(): IValidator | undefined {
    return this.validator;
  }
}

/**
 * Base class for sources returning simple string content (Renamed from StringContentSource)
 */
export abstract class TextSource extends Source<string> {
  // Returns plain string content
}

/**
 * Base class for sources returning AI model outputs (Renamed from ModelContentSource)
 */
export abstract class ModelSource extends Source<ModelOutput> {
  // Returns structured content with content, toolCalls, structuredOutput and metadata
}

/**
 * Static content source that returns the same content every time
 * Supports template interpolation with session context (Renamed from StaticContentSource)
 */
export class StaticSource extends TextSource {
  constructor(
    private content: string,
    options?: ValidationOptions,
  ) {
    super(options);
  }

  async getContent(session: Session<any, any>): Promise<string> {
    const interpolatedContent = interpolateTemplate(this.content, session);
    // Use shared validation logic (single attempt)
    const validationResult = await this.validateContent(
      interpolatedContent,
      session,
    );
    if (!validationResult.isValid && this.raiseError) {
      const errorMessage = `Validation failed: ${validationResult.instruction || ''}`;
      throw new ValidationError(errorMessage);
    }
    // If valid or raiseError is false, return content
    return interpolatedContent;
  }
}

/**
 * Content source that returns a random element from a predefined list
 */
export class RandomSource extends TextSource {
  constructor(
    private contentList: string[],
    options?: ValidationOptions,
  ) {
    super(options);
  }

  async getContent(session: Session<any, any>): Promise<string> {
    const randomIndex = Math.floor(Math.random() * this.contentList.length);
    return this.contentList[randomIndex];
  }
}

/**
 * Content source that returns elements from a predefined list sequentially.
 * By default, it throws an error when the list is exhausted.
 * If `loop` is set to true in options, it restarts from the beginning.
 */
export class ListSource extends TextSource {
  private index: number = 0;
  private loop: boolean;

  constructor(
    private contentList: string[],
    options?: ValidationOptions & { loop?: boolean },
  ) {
    super(options);
    this.loop = options?.loop ?? false;
  }

  async getContent(session: Session<any, any>): Promise<string> {
    if (this.index < this.contentList.length) {
      const content = this.contentList[this.index++];
      // Apply validation if a validator exists
      const validationResult = await this.validateContent(content, session);
      if (!validationResult.isValid && this.raiseError) {
        const errorMessage = `Validation failed for item at index ${this.index - 1}: ${validationResult.instruction || ''}`;
        throw new ValidationError(errorMessage);
      }
      // Return content if valid or if raiseError is false
      return content;
    } else if (this.loop) {
      this.index = 0; // Reset index to loop
      if (this.index < this.contentList.length) {
        // Check if list is not empty
        const content = this.contentList[this.index++];
        // Apply validation if a validator exists
        const validationResult = await this.validateContent(content, session);
        if (!validationResult.isValid && this.raiseError) {
          const errorMessage = `Validation failed for item at index ${this.index - 1} (looping): ${validationResult.instruction || ''}`;
          throw new ValidationError(errorMessage);
        }
        // Return content if valid or if raiseError is false
        return content;
      } else {
        // Handle empty list case during loop reset
        throw new Error('ListSource is empty.');
      }
    } else {
      throw new Error('No more content in the ListSource.');
    }
  }

  /**
   * Gets the current index.
   */
  getIndex(): number {
    return this.index;
  }

  /**
   * Checks if the source is at the end of the list (and not looping).
   */
  atEnd(): boolean {
    return !this.loop && this.index >= this.contentList.length;
  }
}

/**
 * CLI input source that reads from command line (Adapted to new structure)
 */
export class CLISource extends TextSource {
  // Inherits from TextSource
  constructor(
    private prompt: string,
    private defaultValue?: string,
    options?: ValidationOptions,
  ) {
    super(options);
  }

  async getContent(session: Session<any, any>): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      let attempts = 0;
      let lastResult: ValidationResult | undefined;
      let currentInput = '';

      while (attempts < this.maxAttempts) {
        attempts++;
        const rawInput = await rl.question(this.prompt);
        currentInput = rawInput || this.defaultValue || '';

        lastResult = await this.validateContent(currentInput, session); // Single validation attempt

        if (lastResult.isValid) {
          return currentInput;
        }

        const isLastAttempt = attempts >= this.maxAttempts;

        if (isLastAttempt) {
          if (this.raiseError) {
            const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
            throw new ValidationError(errorMessage);
          } else {
            console.warn(
              `CLISource: Validation failed after ${attempts} attempts. Returning last input or default value.`,
            );
            return currentInput; // Return the last invalid input
          }
        } else {
          console.log(
            `Validation attempt ${attempts} failed: ${
              lastResult?.instruction || 'Invalid input'
            }. Please try again.`,
          );
        }
      }
      // Fallback (should not be reached with maxAttempts >= 1)
      return this.defaultValue || '';
    } finally {
      rl.close();
    }
  }
}

/**
 * Callback-based content source (Adapted to new structure)
 */
export class CallbackSource extends TextSource {
  // Inherits from TextSource
  constructor(
    private callback: (context: { context?: Vars }) => Promise<string>,
    options?: ValidationOptions,
  ) {
    super(options);
  }

  async getContent(session: Session<any, any>): Promise<string> {
    let attempts = 0;
    let lastResult: ValidationResult | undefined;
    let currentInput = '';

    while (attempts < this.maxAttempts) {
      attempts++;
      currentInput = await this.callback({ context: session.vars });
      lastResult = await this.validateContent(currentInput, session); // Validate the newly fetched content (single attempt)

      if (lastResult.isValid) {
        return currentInput; // Return the valid input
      }

      // If validation failed
      const isLastAttempt = attempts >= this.maxAttempts;

      if (isLastAttempt) {
        if (this.raiseError) {
          const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
          throw new ValidationError(errorMessage);
        } else {
          console.warn(
            `CallbackSource: Validation failed after ${attempts} attempts. Returning last (invalid) input.`,
          );
          return currentInput; // Return the last invalid input if not raising error
        }
      } else {
        // Log retry message if not the last attempt
        console.log(
          `Validation attempt ${attempts} failed: ${
            lastResult?.instruction || 'Invalid input'
          }. Retrying...`,
        );
        // Optionally add delay here
        // session = session.addMessage({ type: 'system', content: `Validation failed: ${lastResult.instruction}. Please revise.` });
      }
    }

    // Fallback in case loop finishes unexpectedly (e.g., maxAttempts <= 0)
    // This part should ideally not be reached with maxAttempts >= 1
    if (!this.raiseError) {
      return currentInput; // Return the last input fetched
    } else {
      // If raiseError was true, an error should have been thrown already.
      throw new Error(
        `Callback input validation failed unexpectedly after ${this.maxAttempts} attempts.`,
      );
    }
  }
}

/**
 * Source for LLM content generation, with immutable and fluent configuration
 */
export class LlmSource extends ModelSource {
  private readonly options: LLMOptions;
  private schemaConfig?: SchemaGenerationOptions;

  constructor(
    options?: Partial<LLMOptions>,
    validationOptions?: ValidationOptions,
  ) {
    super(validationOptions);

    // Set sensible defaults
    this.options = {
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || '',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
      ...options,
    };
  }

  // Helper method to create new instance with merged options
  private clone(
    newOptions: Partial<LLMOptions>,
    newValidationOptions?: ValidationOptions,
  ): LlmSource {
    const mergedOptions: LLMOptions = {
      ...this.options,
      ...newOptions,
      // Deep merge provider config
      provider: {
        ...this.options.provider,
        ...(newOptions.provider || {}),
      },
      // Deep merge tools
      tools: {
        ...this.options.tools,
        ...newOptions.tools,
      },
    };

    const mergedValidationOptions = newValidationOptions || {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };

    const newSource = new LlmSource(mergedOptions, mergedValidationOptions);
    // Copy schema configuration
    if (this.schemaConfig) {
      newSource.schemaConfig = { ...this.schemaConfig };
    }
    return newSource;
  }

  // Provider configuration - all return new instances
  openai(config?: Partial<Omit<OpenAIProviderConfig, 'type'>>): LlmSource {
    return this.clone({
      provider: {
        type: 'openai',
        apiKey: config?.apiKey || process.env.OPENAI_API_KEY || '',
        modelName: config?.modelName || 'gpt-4o-mini',
        baseURL: config?.baseURL,
        organization: config?.organization,
        dangerouslyAllowBrowser: config?.dangerouslyAllowBrowser,
      },
    });
  }

  anthropic(
    config?: Partial<Omit<AnthropicProviderConfig, 'type'>>,
  ): LlmSource {
    return this.clone({
      provider: {
        type: 'anthropic',
        apiKey: config?.apiKey || process.env.ANTHROPIC_API_KEY || '',
        modelName: config?.modelName || 'claude-3-5-haiku-latest',
        baseURL: config?.baseURL,
      },
    });
  }

  google(config?: Partial<Omit<GoogleProviderConfig, 'type'>>): LlmSource {
    return this.clone({
      provider: {
        type: 'google',
        apiKey: config?.apiKey || process.env.GOOGLE_API_KEY,
        modelName: config?.modelName || 'gemini-pro',
        baseURL: config?.baseURL,
      },
    });
  }

  // Model configuration - all return new instances
  model(modelName: string): LlmSource {
    return this.clone({
      provider: {
        ...this.options.provider,
        modelName,
      },
    });
  }

  apiKey(apiKey: string): LlmSource {
    return this.clone({
      provider: {
        ...this.options.provider,
        apiKey,
      },
    });
  }

  // Generation parameters - all return new instances
  temperature(value: number): LlmSource {
    return this.clone({ temperature: value });
  }

  maxTokens(value: number): LlmSource {
    return this.clone({ maxTokens: value });
  }

  topP(value: number): LlmSource {
    return this.clone({ topP: value });
  }

  topK(value: number): LlmSource {
    return this.clone({ topK: value });
  }

  // Tool configuration - all return new instances
  addTool(name: string, tool: unknown): LlmSource {
    return this.clone({
      tools: {
        ...this.options.tools,
        [name]: tool,
      },
    });
  }

  toolChoice(choice: 'auto' | 'required' | 'none'): LlmSource {
    return this.clone({ toolChoice: choice });
  }

  // Browser compatibility - returns new instance
  dangerouslyAllowBrowser(allow: boolean = true): LlmSource {
    const newOptions: Partial<LLMOptions> = {
      dangerouslyAllowBrowser: allow,
    };

    // Also update provider-specific setting for OpenAI
    if (this.options.provider.type === 'openai') {
      newOptions.provider = {
        ...this.options.provider,
        dangerouslyAllowBrowser: allow,
      };
    }

    return this.clone(newOptions);
  }

  // Schema configuration - returns new instance
  withSchema<T>(
    schema: z.ZodType<T>,
    options?: {
      mode?: 'tool' | 'structured_output';
      functionName?: string;
    },
  ): LlmSource {
    const newSource = this.clone({});
    newSource.schemaConfig = {
      schema,
      mode: options?.mode || 'structured_output',
      functionName: options?.functionName || 'generateStructuredOutput',
    };
    return newSource;
  }

  // Validation configuration - returns new instance
  validate(validator: IValidator): LlmSource {
    const newSource = this.clone({});
    // Create new instance with updated validation
    return new LlmSource(newSource.options, {
      validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    });
  }

  withMaxAttempts(attempts: number): LlmSource {
    return this.clone(
      {},
      {
        validator: this.validator,
        maxAttempts: attempts,
        raiseError: this.raiseError,
      },
    );
  }

  withRaiseError(raise: boolean): LlmSource {
    return this.clone(
      {},
      {
        validator: this.validator,
        maxAttempts: this.maxAttempts,
        raiseError: raise,
      },
    );
  }

  async getContent(session: Session<any, any>): Promise<ModelOutput> {
    let attempts = 0;
    let lastResult: ValidationResult | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;

      try {
        let response: any;

        if (this.schemaConfig) {
          // Use schema-based generation
          response = await generateWithSchema(
            session,
            this.options,
            this.schemaConfig,
          );
        } else {
          // Use regular generation
          response = await generateText(session, this.options);
        }

        const responseContent = response.content ?? '';

        if (response.type && response.type !== 'assistant') {
          console.warn(
            `LLM generation did not return assistant response. Attempt ${attempts}.`,
          );
          if (attempts >= this.maxAttempts) {
            if (this.raiseError) {
              throw new Error(
                `LLM generation failed after ${attempts} attempts: Did not return assistant response.`,
              );
            } else {
              return { content: '' };
            }
          }
          continue;
        }

        // Validate the string content using shared logic
        lastResult = await this.validateContent(responseContent, session);

        if (lastResult.isValid) {
          return {
            content: responseContent,
            toolCalls: response.toolCalls,
            metadata: response.attrs,
            structuredOutput: response.structuredOutput,
          };
        }

        // Handle validation failure
        const isLastAttempt = attempts >= this.maxAttempts;

        if (isLastAttempt) {
          if (this.raiseError) {
            const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
            throw new ValidationError(errorMessage);
          } else {
            console.warn(
              `LlmSource: Validation failed after ${attempts} attempts. Returning last generated content.`,
            );
            return {
              content: responseContent,
              toolCalls: response.toolCalls,
              metadata: response.attrs,
              structuredOutput: response.structuredOutput,
            };
          }
        } else {
          console.log(
            `Validation attempt ${attempts} failed: ${lastResult?.instruction || 'Invalid input'}. Retrying generation...`,
          );
        }
      } catch (error) {
        if (attempts >= this.maxAttempts) {
          if (this.raiseError) {
            throw error;
          } else {
            return { content: '' };
          }
        }
        console.log(`Generation attempt ${attempts} failed, retrying...`);
      }
    }

    throw new Error(
      `LLM content generation failed unexpectedly after ${this.maxAttempts} attempts.`,
    );
  }
}

/**
 * Builder for {@link CLISource}
 */
export class CliBuilder {
  private promptText = '';
  private defaultVal?: string;
  private validation: ValidationOptions = {};

  /** Set prompt shown to the user */
  prompt(text: string) {
    this.promptText = text;
    return this;
  }

  /** Set default value when user provides empty input */
  defaultValue(val: string) {
    this.defaultVal = val;
    return this;
  }

  /** Configure validator */
  validate(v: IValidator) {
    this.validation.validator = v;
    return this;
  }

  /** Build the CLISource instance */
  build() {
    return new CLISource(this.promptText, this.defaultVal, this.validation);
  }
}

/**
 * Convenience factory methods for creating common sources
 */
export namespace Source {
  /** Create LLM source with sensible defaults */
  export function llm(options?: Partial<LLMOptions>): LlmSource {
    return new LlmSource(options);
  }

  /** Create builder for CLI input source */
  export function cli() {
    return new CliBuilder();
  }

  /** Create schema-based source using enhanced LlmSource */
  export function schema<T extends Record<string, unknown>>(
    schema: z.ZodType<T>,
    options?: {
      mode?: 'tool' | 'structured_output';
      functionName?: string;
      maxAttempts?: number;
      raiseError?: boolean;
      validator?: IValidator;
    } & Partial<LLMOptions>,
  ): LlmSource {
    const {
      mode,
      functionName,
      maxAttempts,
      raiseError,
      validator,
      ...llmOptions
    } = options || {};

    return new LlmSource(llmOptions, {
      validator,
      maxAttempts,
      raiseError,
    }).withSchema(schema, { mode, functionName });
  }
}
