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

// --- Debug Mode Configuration ---

/**
 * Get debug mode configuration for LLM sources
 */
function isDebugMode(): boolean {
  return process.env.PROMPTTRAIL_DEBUG === 'true';
}

function getMaxLLMCalls(): number {
  return process.env.PROMPTTRAIL_MAX_LLM_CALLS
    ? parseInt(process.env.PROMPTTRAIL_MAX_LLM_CALLS, 10)
    : 100;
}

/**
 * Global call counter for LLM sources in debug mode
 */
const llmCallCounter = new Map<string, number>();

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
  maxCallLimit?: number;
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
  toolResults?: Array<{
    toolCallId: string;
    result: unknown;
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
export abstract class StringSource extends Source<string> {
  // Returns plain string content
}

/**
 * Base class for sources returning AI model outputs (Renamed from ModelContentSource)
 */
export abstract class ModelSource extends Source<ModelOutput> {
  // Returns structured content with content, toolCalls, structuredOutput and metadata
}

/**
 * Content source that returns a random element from a predefined list
 */
export class RandomSource extends StringSource {
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
export class ListSource extends StringSource {
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
 * CLI input source with fluent API that reads from command line
 */
export class CLISource extends StringSource {
  private promptText: string;
  private defaultVal?: string;

  constructor(
    prompt: string = '',
    defaultValue?: string,
    options?: ValidationOptions,
  ) {
    super(options);
    this.promptText = prompt;
    this.defaultVal = defaultValue;
  }

  // Helper method to create new instance with merged options
  private clone(
    newPrompt?: string,
    newDefaultValue?: string,
    newValidationOptions?: ValidationOptions,
  ): CLISource {
    const mergedValidationOptions = newValidationOptions || {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };

    return new CLISource(
      newPrompt ?? this.promptText,
      newDefaultValue ?? this.defaultVal,
      mergedValidationOptions,
    );
  }

  // Fluent API methods - all return new instances
  prompt(text: string): CLISource {
    return this.clone(text, this.defaultVal);
  }

  defaultValue(value: string): CLISource {
    return this.clone(this.promptText, value);
  }

  validate(validator: IValidator): CLISource {
    return this.clone(this.promptText, this.defaultVal, {
      validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    });
  }

  withMaxAttempts(attempts: number): CLISource {
    return this.clone(this.promptText, this.defaultVal, {
      validator: this.validator,
      maxAttempts: attempts,
      raiseError: this.raiseError,
    });
  }

  withRaiseError(raise: boolean): CLISource {
    return this.clone(this.promptText, this.defaultVal, {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: raise,
    });
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
        const rawInput = await rl.question(this.promptText);
        currentInput = rawInput || this.defaultVal || '';

        lastResult = await this.validateContent(currentInput, session);

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
            return currentInput;
          }
        } else {
          console.log(
            `Validation attempt ${attempts} failed: ${
              lastResult?.instruction || 'Invalid input'
            }. Please try again.`,
          );
        }
      }
      return this.defaultVal || '';
    } finally {
      rl.close();
    }
  }
}

/**
 * Callback-based content source with fluent API
 */
export class CallbackSource extends StringSource {
  private callback: (context: { context?: Vars }) => Promise<string>;

  constructor(
    callback: (context: { context?: Vars }) => Promise<string>,
    options?: ValidationOptions,
  ) {
    super(options);
    this.callback = callback;
  }

  // Helper method to create new instance with merged options
  private clone(
    newCallback?: (context: { context?: Vars }) => Promise<string>,
    newValidationOptions?: ValidationOptions,
  ): CallbackSource {
    const mergedValidationOptions = newValidationOptions || {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };

    return new CallbackSource(
      newCallback ?? this.callback,
      mergedValidationOptions,
    );
  }

  // Fluent API methods - all return new instances
  withCallback(
    callback: (context: { context?: Vars }) => Promise<string>,
  ): CallbackSource {
    return this.clone(callback);
  }

  validate(validator: IValidator): CallbackSource {
    return this.clone(this.callback, {
      validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    });
  }

  withMaxAttempts(attempts: number): CallbackSource {
    return this.clone(this.callback, {
      validator: this.validator,
      maxAttempts: attempts,
      raiseError: this.raiseError,
    });
  }

  withRaiseError(raise: boolean): CallbackSource {
    return this.clone(this.callback, {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: raise,
    });
  }

  async getContent(session: Session<any, any>): Promise<string> {
    let attempts = 0;
    let lastResult: ValidationResult | undefined;
    let currentInput = '';

    while (attempts < this.maxAttempts) {
      attempts++;
      currentInput = await this.callback({ context: session.vars });
      lastResult = await this.validateContent(currentInput, session);

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
            `CallbackSource: Validation failed after ${attempts} attempts. Returning last (invalid) input.`,
          );
          return currentInput;
        }
      } else {
        console.log(
          `Validation attempt ${attempts} failed: ${
            lastResult?.instruction || 'Invalid input'
          }. Retrying...`,
        );
      }
    }

    if (!this.raiseError) {
      return currentInput;
    } else {
      throw new Error(
        `Callback input validation failed unexpectedly after ${this.maxAttempts} attempts.`,
      );
    }
  }
}

/**
 * Static text content source with fluent API
 */
export class LiteralSource extends StringSource {
  private content: string;

  constructor(content: string, options?: ValidationOptions) {
    super(options);
    this.content = content;
  }

  // Helper method to create new instance with merged options
  private clone(
    newContent?: string,
    newValidationOptions?: ValidationOptions,
  ): LiteralSource {
    const mergedValidationOptions = newValidationOptions || {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };

    return new LiteralSource(
      newContent ?? this.content,
      mergedValidationOptions,
    );
  }

  // Fluent API methods - all return new instances
  withContent(content: string): LiteralSource {
    return this.clone(content);
  }

  validate(validator: IValidator): LiteralSource {
    return this.clone(this.content, {
      validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    });
  }

  withMaxAttempts(attempts: number): LiteralSource {
    return this.clone(this.content, {
      validator: this.validator,
      maxAttempts: attempts,
      raiseError: this.raiseError,
    });
  }

  withRaiseError(raise: boolean): LiteralSource {
    return this.clone(this.content, {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: raise,
    });
  }

  async getContent(session: Session<any, any>): Promise<string> {
    const interpolatedContent = interpolateTemplate(this.content, session);
    const validationResult = await this.validateContent(
      interpolatedContent,
      session,
    );
    if (!validationResult.isValid && this.raiseError) {
      const errorMessage = `Validation failed: ${validationResult.instruction || ''}`;
      throw new ValidationError(errorMessage);
    }
    return interpolatedContent;
  }
}

/**
 * Source for LLM content generation, with immutable and fluent configuration
 */
export class LlmSource extends ModelSource {
  protected readonly options: LLMOptions;
  protected schemaConfig?: SchemaGenerationOptions;
  protected instanceId: string;
  protected readonly maxCallLimit: number;

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

    // Generate unique instance ID for tracking
    this.instanceId = `llm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Set max call limit from options or environment
    this.maxCallLimit = options?.maxCallLimit ?? getMaxLLMCalls();

    // Initialize counter for this instance in debug mode
    if (isDebugMode()) {
      llmCallCounter.set(this.instanceId, 0);
    }
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
      // Preserve maxCallLimit unless explicitly overridden
      maxCallLimit: newOptions.maxCallLimit ?? this.maxCallLimit,
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

    // In debug mode, share the same counter for cloned instances
    if (isDebugMode() && llmCallCounter.has(this.instanceId)) {
      const currentCount = llmCallCounter.get(this.instanceId) || 0;
      llmCallCounter.delete(newSource.instanceId);
      newSource.instanceId = this.instanceId;
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

  withTool(name: string, tool: unknown): LlmSource {
    return this.clone({
      tools: {
        ...this.options.tools,
        [name]: tool,
      },
    });
  }

  withTools(tools: Record<string, unknown>): LlmSource {
    return this.clone({
      tools: {
        ...this.options.tools,
        ...tools,
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

  // Debug mode configuration - returns new instance
  maxCalls(limit: number): LlmSource {
    return this.clone({ maxCallLimit: limit });
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

  /** Get the instance ID for this LlmSource (useful for debugging/testing) */
  getInstanceId(): string {
    return this.instanceId;
  }

  async getContent(session: Session<any, any>): Promise<ModelOutput> {
    // Check call limit in debug mode
    if (isDebugMode()) {
      const currentCalls = llmCallCounter.get(this.instanceId) || 0;
      if (currentCalls >= this.maxCallLimit) {
        throw new Error(
          `LlmSource call limit exceeded: ${currentCalls} calls made, limit is ${this.maxCallLimit}. ` +
            `This safety check prevents infinite loops during development. ` +
            `Set PROMPTTRAIL_DEBUG=false or increase PROMPTTRAIL_MAX_LLM_CALLS to disable.`,
        );
      }
      llmCallCounter.set(this.instanceId, currentCalls + 1);
    }

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
            toolResults: response.toolResults,
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
              toolResults: response.toolResults,
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
 * Mock response configuration for MockSource
 */
export interface MockResponse {
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
  toolResults?: Array<{
    toolCallId: string;
    result: unknown;
  }>;
  metadata?: Record<string, unknown>;
  structuredOutput?: Record<string, unknown>;
}

/**
 * Mock callback function type
 */
export type MockCallback = (
  session: Session<any, any>,
  options: LLMOptions,
) => Promise<MockResponse> | MockResponse;

/**
 * MockSource extends LlmSource to provide mocking capabilities
 * while maintaining the same fluent API
 */
export class MockSource extends LlmSource {
  private _mockResponses: MockResponse[] = [];
  private _mockCallback?: MockCallback;
  private _currentResponseIndex = 0;
  private _callHistory: Array<{
    session: Session<any, any>;
    options: LLMOptions;
    response: MockResponse;
  }> = [];

  // Override the clone method to return MockSource
  private cloneMock(
    newOptions: Partial<LLMOptions>,
    newValidationOptions?: ValidationOptions,
  ): MockSource {
    const mergedOptions: LLMOptions = {
      ...this.options,
      ...newOptions,
      provider: {
        ...this.options.provider,
        ...(newOptions.provider || {}),
      },
      tools: {
        ...this.options.tools,
        ...newOptions.tools,
      },
      maxCallLimit: newOptions.maxCallLimit ?? this.maxCallLimit,
    };

    const mergedValidationOptions = newValidationOptions || {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };

    const newSource = new MockSource(mergedOptions, mergedValidationOptions);
    
    // Copy mock state
    newSource._mockResponses = [...this._mockResponses];
    newSource._mockCallback = this._mockCallback;
    newSource._currentResponseIndex = this._currentResponseIndex;
    newSource._callHistory = [...this._callHistory];
    
    // Copy schema configuration
    if (this.schemaConfig) {
      newSource.schemaConfig = { ...this.schemaConfig };
    }

    // Share instance ID for call counting
    if (isDebugMode() && llmCallCounter.has(this.instanceId)) {
      const currentCount = llmCallCounter.get(this.instanceId) || 0;
      llmCallCounter.delete(newSource.instanceId);
      newSource.instanceId = this.instanceId;
    }

    return newSource;
  }

  // Mock-specific methods
  
  /** Set a single mock response */
  mockResponse(response: MockResponse): MockSource {
    const newSource = this.cloneMock({});
    newSource._mockResponses = [response];
    newSource._currentResponseIndex = 0;
    return newSource;
  }

  /** Set multiple mock responses (will be returned in sequence) */
  mockResponses(...responses: MockResponse[]): MockSource {
    const newSource = this.cloneMock({});
    newSource._mockResponses = responses;
    newSource._currentResponseIndex = 0;
    return newSource;
  }

  /** Set a callback to generate mock responses dynamically */
  mockCallback(callback: MockCallback): MockSource {
    const newSource = this.cloneMock({});
    newSource._mockCallback = callback;
    return newSource;
  }

  /** Get the call history for assertions */
  getCallHistory() {
    return [...this._callHistory];
  }

  /** Get the last call made to this mock */
  getLastCall() {
    return this._callHistory[this._callHistory.length - 1];
  }

  /** Get the number of calls made */
  getCallCount(): number {
    return this._callHistory.length;
  }

  /** Reset the mock state */
  reset(): MockSource {
    const newSource = this.cloneMock({});
    newSource._currentResponseIndex = 0;
    newSource._callHistory = [];
    return newSource;
  }

  // Override all fluent API methods to return MockSource

  openai(config?: Partial<Omit<OpenAIProviderConfig, 'type'>>): MockSource {
    return this.cloneMock({
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
  ): MockSource {
    return this.cloneMock({
      provider: {
        type: 'anthropic',
        apiKey: config?.apiKey || process.env.ANTHROPIC_API_KEY || '',
        modelName: config?.modelName || 'claude-3-5-haiku-latest',
        baseURL: config?.baseURL,
      },
    });
  }

  google(config?: Partial<Omit<GoogleProviderConfig, 'type'>>): MockSource {
    return this.cloneMock({
      provider: {
        type: 'google',
        apiKey: config?.apiKey || process.env.GOOGLE_API_KEY,
        modelName: config?.modelName || 'gemini-pro',
        baseURL: config?.baseURL,
      },
    });
  }

  model(modelName: string): MockSource {
    return this.cloneMock({
      provider: {
        ...this.options.provider,
        modelName,
      },
    });
  }

  apiKey(apiKey: string): MockSource {
    return this.cloneMock({
      provider: {
        ...this.options.provider,
        apiKey,
      },
    });
  }

  temperature(value: number): MockSource {
    return this.cloneMock({ temperature: value });
  }

  maxTokens(value: number): MockSource {
    return this.cloneMock({ maxTokens: value });
  }

  topP(value: number): MockSource {
    return this.cloneMock({ topP: value });
  }

  topK(value: number): MockSource {
    return this.cloneMock({ topK: value });
  }

  addTool(name: string, tool: unknown): MockSource {
    return this.cloneMock({
      tools: {
        ...this.options.tools,
        [name]: tool,
      },
    });
  }

  withTool(name: string, tool: unknown): MockSource {
    return this.cloneMock({
      tools: {
        ...this.options.tools,
        [name]: tool,
      },
    });
  }

  withTools(tools: Record<string, unknown>): MockSource {
    return this.cloneMock({
      tools: {
        ...this.options.tools,
        ...tools,
      },
    });
  }

  toolChoice(choice: 'auto' | 'required' | 'none'): MockSource {
    return this.cloneMock({ toolChoice: choice });
  }

  dangerouslyAllowBrowser(allow: boolean = true): MockSource {
    const newOptions: Partial<LLMOptions> = {
      dangerouslyAllowBrowser: allow,
    };

    if (this.options.provider.type === 'openai') {
      newOptions.provider = {
        ...this.options.provider,
        dangerouslyAllowBrowser: allow,
      };
    }

    return this.cloneMock(newOptions);
  }

  maxCalls(limit: number): MockSource {
    return this.cloneMock({ maxCallLimit: limit });
  }

  withSchema<T>(
    schema: z.ZodType<T>,
    options?: {
      mode?: 'tool' | 'structured_output';
      functionName?: string;
    },
  ): MockSource {
    const newSource = this.cloneMock({});
    newSource.schemaConfig = {
      schema,
      mode: options?.mode || 'structured_output',
      functionName: options?.functionName || 'generateStructuredOutput',
    };
    return newSource;
  }

  validate(validator: IValidator): MockSource {
    return this.cloneMock(
      {},
      {
        validator,
        maxAttempts: this.maxAttempts,
        raiseError: this.raiseError,
      },
    );
  }

  withMaxAttempts(attempts: number): MockSource {
    return this.cloneMock(
      {},
      {
        validator: this.validator,
        maxAttempts: attempts,
        raiseError: this.raiseError,
      },
    );
  }

  withRaiseError(raise: boolean): MockSource {
    return this.cloneMock(
      {},
      {
        validator: this.validator,
        maxAttempts: this.maxAttempts,
        raiseError: raise,
      },
    );
  }

  // Override getContent to return mock responses
  async getContent(session: Session<any, any>): Promise<ModelOutput> {
    // Get mock response
    let mockResponse: MockResponse;

    if (this._mockCallback) {
      // Use callback to generate response
      mockResponse = await this._mockCallback(session, this.options);
    } else if (this._mockResponses.length > 0) {
      // Use pre-set responses
      mockResponse = this._mockResponses[this._currentResponseIndex];
      // Cycle through responses
      this._currentResponseIndex =
        (this._currentResponseIndex + 1) % this._mockResponses.length;
    } else {
      // Default mock response
      mockResponse = {
        content: 'Mock LLM response',
      };
    }

    // Record the call
    this._callHistory.push({
      session,
      options: this.options,
      response: mockResponse,
    });

    // Apply validation if configured
    if (this.validator) {
      const validationResult = await this.validateContent(
        mockResponse.content,
        session,
      );
      
      if (!validationResult.isValid && this.raiseError) {
        const errorMessage = `Validation failed: ${validationResult.instruction || ''}`;
        throw new ValidationError(errorMessage);
      }
    }

    // Return in the expected format
    return {
      content: mockResponse.content,
      toolCalls: mockResponse.toolCalls,
      toolResults: mockResponse.toolResults,
      metadata: mockResponse.metadata,
      structuredOutput: mockResponse.structuredOutput,
    };
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

  /** Create mock source for testing */
  export function mock(options?: Partial<LLMOptions>): MockSource {
    return new MockSource(options);
  }

  /** Reset all LLM call counters (useful for testing) */
  export function resetCallCounters(): void {
    llmCallCounter.clear();
  }

  /** Get current call count for a specific LlmSource instance */
  export function getCallCount(instanceId: string): number {
    return llmCallCounter.get(instanceId) || 0;
  }

  /** Create CLI input source with fluent API */
  export function cli(prompt?: string, defaultValue?: string): CLISource {
    return new CLISource(prompt, defaultValue);
  }

  /** Create static literal content source with fluent API */
  export function literal(content: string): LiteralSource {
    return new LiteralSource(content);
  }

  /** Create callback-based source with fluent API */
  export function callback(
    callback: (context: { context?: Vars }) => Promise<string>,
  ): CallbackSource {
    return new CallbackSource(callback);
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
