import * as readline from 'node:readline/promises';
import { z } from 'zod';
import { ValidationError } from './errors';
import {
  generateText,
  generateWithSchema,
  SchemaGenerationOptions,
} from './generate';
import {
  DEFAULT_RETRY_CONFIG,
  Middleware,
  MiddlewareContext,
  MiddlewarePipeline,
  RequestContext,
  RequestInterceptor,
  ResponseContext,
  ResponseInterceptor,
  RetryConfig,
} from './middleware';
import type { Session, SessionContext } from './session';
import type { Tool } from './tool';
import { interpolateTemplate } from './utils/template_interpolation';
import type {
  IValidator,
  TValidationResult as ValidationResult,
} from './validators/base';

function isDebugMode(): boolean {
  return process.env.PROMPTTRAIL_DEBUG === 'true';
}

function getMaxLLMCalls(): number {
  return process.env.PROMPTTRAIL_MAX_LLM_CALLS
    ? parseInt(process.env.PROMPTTRAIL_MAX_LLM_CALLS, 10)
    : 100;
}

const llmCallCounter = new Map<string, number>();

export interface OpenAIProviderConfig {
  type: 'openai';
  apiKey: string;
  modelName: string;
  baseURL?: string;
  organization?: string;
  dangerouslyAllowBrowser?: boolean;
}

export interface AnthropicProviderConfig {
  type: 'anthropic';
  apiKey: string;
  modelName: string;
  baseURL?: string;
}

export interface GoogleProviderConfig {
  type: 'google';
  apiKey?: string;
  modelName: string;
  baseURL?: string;
}

export type ProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | GoogleProviderConfig;

export interface LLMOptions {
  provider: ProviderConfig;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  tools?: Record<string, Tool>;
  toolChoice?: 'auto' | 'required' | 'none';
  dangerouslyAllowBrowser?: boolean;
  sdkOptions?: Record<string, unknown>;
  maxCallLimit?: number;
}

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

export interface ValidationOptions {
  validator?: IValidator;
  maxAttempts?: number;
  raiseError?: boolean;
}

export abstract class Source<T = unknown> {
  protected validator?: IValidator;
  protected maxAttempts: number;
  protected raiseError: boolean;
  protected pipeline: MiddlewarePipeline<unknown, T>;
  protected retryConfig: RetryConfig;

  constructor(
    options?: ValidationOptions & {
      retryConfig?: Partial<RetryConfig>;
      middleware?: MiddlewarePipeline<unknown, T>;
    },
  ) {
    this.validator = options?.validator;
    this.maxAttempts = options?.maxAttempts ?? 1;
    this.raiseError = options?.raiseError ?? true;
    this.pipeline =
      options?.middleware?.clone() ?? new MiddlewarePipeline<unknown, T>();

    // Sync maxAttempts from ValidationOptions to RetryConfig if not explicitly set
    const retryMaxAttempts =
      options?.retryConfig?.maxAttempts ??
      options?.maxAttempts ??
      DEFAULT_RETRY_CONFIG.maxAttempts;
    this.retryConfig = {
      ...DEFAULT_RETRY_CONFIG,
      ...options?.retryConfig,
      maxAttempts: retryMaxAttempts,
    };
  }

  abstract getContent(session: Session<any, any>): Promise<T>;

  protected async validateContent(
    content: string,
    session: Session<any, any>,
  ): Promise<ValidationResult> {
    if (!this.validator) {
      return { isValid: true };
    }
    return this.validator.validate(content, session);
  }

  hasValidator(): boolean {
    return !!this.validator;
  }

  getValidator(): IValidator | undefined {
    return this.validator;
  }

  useMiddleware(middleware: Middleware<unknown, T>): this {
    this.pipeline.use(middleware);
    return this;
  }

  interceptRequest(interceptor: RequestInterceptor): this {
    this.pipeline.interceptRequest(interceptor);
    return this;
  }

  interceptResponse(interceptor: ResponseInterceptor): this {
    this.pipeline.interceptResponse(interceptor);
    return this;
  }

  withRetry(config: Partial<RetryConfig>): this {
    this.retryConfig = { ...this.retryConfig, ...config };
    return this;
  }

  getMiddlewarePipeline(): MiddlewarePipeline<unknown, T> {
    return this.pipeline;
  }

  protected async executeWithMiddleware(
    session: Session<any, any>,
    generateFn: (context: MiddlewareContext<unknown>) => Promise<T>,
  ): Promise<T> {
    const initialContext: MiddlewareContext<unknown> = {
      session,
      attempt: 1,
      metadata: {},
    };

    try {
      return await this.pipeline.executeWithRetry(
        async (context) => {
          if ((context as any).cachedResponse !== undefined) {
            return (context as any).cachedResponse;
          }
          return generateFn(context);
        },
        initialContext,
        this.retryConfig,
      );
    } catch (error) {
      if (!this.raiseError) {
        console.warn(
          `${this.constructor.name}: Error occurred but raiseError is false. Returning default value.`,
        );
        return this.getDefaultValue();
      }
      throw error;
    }
  }

  protected getDefaultValue(): T {
    return '' as T;
  }
}

export abstract class StringSource extends Source<string> {}

export abstract class ModelSource extends Source<ModelOutput> {
  protected getDefaultValue(): ModelOutput {
    return { content: '' };
  }
}

/**
 * Base class for Sources that need validation fluent API and clone helpers
 * Eliminates code duplication across CLISource, LiteralSource, CallbackSource, etc.
 */
export abstract class BaseValidatedSource<
  T,
  TContent = unknown,
> extends Source<T> {
  protected content: TContent;

  constructor(content: TContent, options?: ValidationOptions) {
    super(options);
    this.content = content;
  }

  /**
   * Generic clone method that subclasses can override for content merging
   * Eliminates duplicate clone() methods across Source classes
   */
  protected clone(
    newContent?: TContent,
    newValidationOptions?: ValidationOptions,
  ): this {
    const mergedValidationOptions = newValidationOptions || {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };

    const Constructor = this.constructor as new (
      content: TContent,
      options?: ValidationOptions,
    ) => this;
    return new Constructor(newContent ?? this.content, mergedValidationOptions);
  }

  /**
   * Helper to get current validation options
   */
  protected getValidationOptions(): ValidationOptions {
    return {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };
  }

  // Shared fluent API methods - eliminates duplication across Source classes
  validate(validator: IValidator): this {
    return this.clone(this.content, {
      ...this.getValidationOptions(),
      validator,
    });
  }

  withMaxAttempts(attempts: number): this {
    return this.clone(this.content, {
      ...this.getValidationOptions(),
      maxAttempts: attempts,
    });
  }

  withRaiseError(raise: boolean): this {
    return this.clone(this.content, {
      ...this.getValidationOptions(),
      raiseError: raise,
    });
  }

  /**
   * Reusable validation execution helper that eliminates duplicate validation loops
   * Handles retries, validation, and error handling consistently across Source classes
   */
  protected async executeWithValidation<TResult>(
    session: Session<any, any>,
    generateFn: () => Promise<TResult>,
    extractContent?: (result: TResult) => string,
  ): Promise<TResult> {
    let attempts = 0;

    while (attempts < this.maxAttempts) {
      attempts++;

      try {
        const result = await generateFn();
        const contentToValidate = extractContent
          ? extractContent(result)
          : typeof result === 'string'
            ? result
            : String(result);

        const validationResult = await this.validateContent(
          contentToValidate,
          session,
        );

        if (validationResult.isValid) {
          return result;
        }

        // Handle validation failure with retries
        const isLastAttempt = attempts >= this.maxAttempts;
        if (isLastAttempt) {
          if (this.raiseError) {
            throw new ValidationError(
              `Validation failed after ${attempts} attempts: ${validationResult.instruction || ''}`,
            );
          } else {
            console.warn(
              `${this.constructor.name}: Validation failed but raiseError is false. Returning content anyway.`,
            );
            return result;
          }
        } else {
          console.log(
            `Validation attempt ${attempts} failed: ${validationResult?.instruction || 'Invalid input'}. Retrying...`,
          );
        }
      } catch (error) {
        const isLastAttempt = attempts >= this.maxAttempts;
        if (isLastAttempt) {
          if (this.raiseError) {
            throw error;
          } else {
            console.warn(
              `${this.constructor.name}: Error occurred but raiseError is false. Returning default value.`,
            );
            return this.getDefaultValue() as unknown as TResult;
          }
        } else {
          console.warn(
            `${this.constructor.name} attempt ${attempts} failed: ${(error as Error).message}. Retrying...`,
          );
        }
      }
    }

    throw new Error(
      `${this.constructor.name} execution failed unexpectedly after ${this.maxAttempts} attempts.`,
    );
  }

  protected getDefaultValue(): T {
    return '' as T;
  }
}

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

  getIndex(): number {
    return this.index;
  }

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

  // Helper to get current validation options
  private getValidationOptions(): ValidationOptions {
    return {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };
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
      ...this.getValidationOptions(),
      validator,
    });
  }

  withMaxAttempts(attempts: number): CLISource {
    return this.clone(this.promptText, this.defaultVal, {
      ...this.getValidationOptions(),
      maxAttempts: attempts,
    });
  }

  withRaiseError(raise: boolean): CLISource {
    return this.clone(this.promptText, this.defaultVal, {
      ...this.getValidationOptions(),
      raiseError: raise,
    });
  }

  async getContent(session: Session<any, any>): Promise<string> {
    // Check if Ink debug interface is active or can be initialized
    try {
      const { InkDebugContext } = await import('./cli/ink-debug-context');

      // If session has print enabled, try to use or initialize Ink interface
      if (session.debug) {
        // Always wait for any ongoing initialization to complete first
        const isInkAvailable = await InkDebugContext.waitForInitialization();

        // If still not available and not started, try to initialize
        if (!isInkAvailable && !InkDebugContext.isInitializationStarted()) {
          try {
            await InkDebugContext.initialize(session);
            const finalIsInkAvailable =
              await InkDebugContext.waitForInitialization();
            if (finalIsInkAvailable) {
              return this.getContentViaInk(session);
            }
          } catch (error) {
            // Initialization failed, fall back to readline
          }
        } else if (isInkAvailable) {
          return this.getContentViaInk(session);
        }
      }
    } catch (error) {
      // Ink not available or import failed, fall back to readline
    }

    // Fallback to original readline implementation
    return this.getContentViaReadline(session);
  }

  private async getContentViaInk(session: Session<any, any>): Promise<string> {
    const { InkDebugContext } = await import('./cli/ink-debug-context');

    let attempts = 0;
    let lastResult: ValidationResult | undefined;
    let currentInput = '';

    while (attempts < this.maxAttempts) {
      attempts++;

      // Get input through Ink interface
      const rawInput = await InkDebugContext.captureCliInput(
        this.promptText,
        this.defaultVal,
        session,
      );
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
        // In Ink mode, validation errors will be shown in the UI
        console.log(
          `Validation attempt ${attempts} failed: ${
            lastResult?.instruction || 'Invalid input'
          }. Please try again.`,
        );
      }
    }
    return this.defaultVal || '';
  }

  private async getContentViaReadline(
    session: Session<any, any>,
  ): Promise<string> {
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
export class CallbackSource extends BaseValidatedSource<
  string,
  (context: { context?: SessionContext }) => Promise<string>
> {
  constructor(
    callback: (context: { context?: SessionContext }) => Promise<string>,
    options?: ValidationOptions,
  ) {
    super(callback, options);
  }

  // Fluent API methods - validate(), withMaxAttempts(), withRaiseError() inherited from BaseValidatedSource
  withCallback(
    callback: (context: { context?: SessionContext }) => Promise<string>,
  ): CallbackSource {
    return this.clone(callback);
  }

  async getContent(session: Session<any, any>): Promise<string> {
    return this.executeWithValidation(session, async () => {
      return await this.content({ context: session.vars });
    });
  }
}

/**
 * Static text content source with fluent API
 */
export class LiteralSource extends BaseValidatedSource<string, string> {
  constructor(content: string, options?: ValidationOptions) {
    super(content, options);
  }

  // Fluent API methods - validate(), withMaxAttempts(), withRaiseError() inherited from BaseValidatedSource
  withContent(content: string): LiteralSource {
    return this.clone(content);
  }

  async getContent(session: Session<any, any>): Promise<string> {
    // Use the enhanced middleware pipeline for content generation
    return this.executeWithMiddleware(session, async (context) => {
      const interpolatedContent = interpolateTemplate(
        this.content,
        context.session,
      );

      // Transform content through middleware
      const transformedContent = await this.pipeline.transformContent(
        interpolatedContent,
        context,
      );

      // Validate the transformed content
      const validationResult = await this.validateContent(
        transformedContent,
        session,
      );

      if (!validationResult.isValid) {
        if (this.raiseError) {
          throw new ValidationError(
            `Validation failed: ${validationResult.instruction || ''}`,
          );
        } else {
          console.warn(
            'LiteralSource: Validation failed but raiseError is false. Returning content anyway.',
          );
        }
      }

      return transformedContent;
    });
  }
}

/**
 * Mock response configuration
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
 * Internal state for mocked LlmSource
 */
interface MockState {
  mockResponses: MockResponse[];
  mockCallback?: MockCallback;
  currentResponseIndex: number;
  callHistory: Array<{
    session: Session<any, any>;
    options: LLMOptions;
    response: MockResponse;
  }>;
  isMocked: true;
}

/**
 * MockedLlmSource type that adds mock-specific methods to LlmSource
 */
export interface MockedLlmSource extends LlmSource {
  mockResponse(response: MockResponse): MockedLlmSource;
  mockResponses(...responses: MockResponse[]): MockedLlmSource;
  mockCallback(callback: MockCallback): MockedLlmSource;
  getCallHistory(): Array<{
    session: Session<any, any>;
    options: LLMOptions;
    response: MockResponse;
  }>;
  getLastCall():
    | {
        session: Session<any, any>;
        options: LLMOptions;
        response: MockResponse;
      }
    | undefined;
  getCallCount(): number;
  reset(): MockedLlmSource;
}

/**
 * Source for LLM content generation, with immutable and fluent configuration
 */
export class LlmSource extends ModelSource {
  protected readonly options: LLMOptions;
  protected schemaConfig?: SchemaGenerationOptions;
  protected instanceId: string;
  protected readonly maxCallLimit: number;
  protected _mockState?: MockState;

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
      retryConfig: this.retryConfig,
      middleware: this.pipeline,
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

  withTool(name: string, tool: Tool): LlmSource {
    return this.clone({
      tools: {
        ...this.options.tools,
        [name]: tool,
      },
    });
  }

  withTools(tools: Record<string, Tool>): LlmSource {
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

  /**
   * Create a mocked version of this LlmSource for testing.
   * The mocked version intercepts generateText calls and returns mock responses.
   */
  mock(): MockedLlmSource {
    // Create a clone with mock state
    const mockSource = Object.create(this) as LlmSource & MockedLlmSource;

    // Initialize mock state
    mockSource._mockState = {
      mockResponses: [],
      mockCallback: undefined,
      currentResponseIndex: 0,
      callHistory: [],
      isMocked: true,
    };

    // Add mock-specific methods
    mockSource.mockResponse = function (
      response: MockResponse,
    ): MockedLlmSource {
      this._mockState!.mockResponses = [response];
      this._mockState!.currentResponseIndex = 0;
      return this;
    };

    mockSource.mockResponses = function (
      ...responses: MockResponse[]
    ): MockedLlmSource {
      this._mockState!.mockResponses = responses;
      this._mockState!.currentResponseIndex = 0;
      return this;
    };

    mockSource.mockCallback = function (
      callback: MockCallback,
    ): MockedLlmSource {
      this._mockState!.mockCallback = callback;
      return this;
    };

    mockSource.getCallHistory = function () {
      return [...this._mockState!.callHistory];
    };

    mockSource.getLastCall = function () {
      const history = this._mockState!.callHistory;
      return history[history.length - 1];
    };

    mockSource.getCallCount = function (): number {
      return this._mockState!.callHistory.length;
    };

    mockSource.reset = function (): MockedLlmSource {
      this._mockState!.currentResponseIndex = 0;
      this._mockState!.callHistory = [];
      return this;
    };

    return mockSource;
  }

  /**
   * Generate mock response and apply validation
   */
  private async _generateMockResponse(
    session: Session<any, any>,
  ): Promise<ModelOutput> {
    if (!this._mockState) {
      throw new Error('_generateMockResponse called on non-mocked source');
    }

    // Use the enhanced middleware pipeline for mock generation too
    return this.executeWithMiddleware(session, async (context) => {
      // Create request context for interceptors
      const requestContext: RequestContext = {
        ...context,
        options: this.options,
        messages: undefined, // Will be filled by interceptors if needed
      };

      // Execute request interceptors
      const processedRequest =
        await this.pipeline.executeRequestInterceptors(requestContext);

      // Generate mock response
      let mockResponse: MockResponse;

      if (this._mockState!.mockCallback) {
        mockResponse = await this._mockState!.mockCallback(
          processedRequest.session,
          processedRequest.options,
        );
      } else if (this._mockState!.mockResponses.length > 0) {
        mockResponse =
          this._mockState!.mockResponses[this._mockState!.currentResponseIndex];
        this._mockState!.currentResponseIndex =
          (this._mockState!.currentResponseIndex + 1) %
          this._mockState!.mockResponses.length;
      } else {
        mockResponse = { content: 'Mock LLM response' };
      }

      // Record the call
      this._mockState!.callHistory.push({
        session: processedRequest.session,
        options: processedRequest.options,
        response: mockResponse,
      });

      // Create the model output
      const modelOutput: ModelOutput = {
        content: mockResponse.content,
        toolCalls: mockResponse.toolCalls,
        toolResults: mockResponse.toolResults,
        metadata: mockResponse.metadata,
        structuredOutput: mockResponse.structuredOutput,
      };

      // Create response context and execute response interceptors
      const responseContext: ResponseContext = {
        ...processedRequest,
        response: modelOutput,
      };

      const processedResponse =
        await this.pipeline.executeResponseInterceptors(responseContext);

      // Transform the response through middleware
      const transformedResponse = await this.pipeline.transformContent(
        processedResponse.response,
        context,
      );

      // Validate the content from the transformed response
      const validationResult = await this.validateContent(
        transformedResponse.content,
        session,
      );

      if (!validationResult.isValid) {
        if (this.raiseError) {
          throw new ValidationError(
            `Validation failed: ${validationResult.instruction || ''}`,
          );
        } else {
          console.warn(
            'MockSource: Validation failed but raiseError is false. Returning content anyway.',
          );
        }
      }

      // Return the transformed response
      return transformedResponse;
    });
  }

  async getContent(session: Session<any, any>): Promise<ModelOutput> {
    // Check if this is a mocked source
    if (this._mockState) {
      return this._generateMockResponse(session);
    }

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

    // Use the enhanced middleware pipeline for content generation
    return this.executeWithMiddleware(session, async (context) => {
      // Create request context for interceptors
      const requestContext: RequestContext = {
        ...context,
        options: this.options,
        messages: undefined, // Will be filled by interceptors if needed
      };

      // Execute request interceptors
      const processedRequest =
        await this.pipeline.executeRequestInterceptors(requestContext);

      let response: any;

      if (this.schemaConfig) {
        // Use schema-based generation
        response = await generateWithSchema(
          processedRequest.session,
          processedRequest.options,
          this.schemaConfig,
        );
      } else {
        // Use regular generation
        response = await generateText(
          processedRequest.session,
          processedRequest.options,
        );
      }

      const responseContent = response.content ?? '';

      if (response.type && response.type !== 'assistant') {
        throw new Error('LLM generation did not return assistant response');
      }

      // Create the model output
      const modelOutput: ModelOutput = {
        content: responseContent,
        toolCalls: response.toolCalls,
        toolResults: response.toolResults,
        metadata: response.attrs,
        structuredOutput: response.structuredOutput,
      };

      // Create response context and execute response interceptors
      const responseContext: ResponseContext = {
        ...processedRequest,
        response: modelOutput,
      };

      const processedResponse =
        await this.pipeline.executeResponseInterceptors(responseContext);

      // Transform the response through middleware
      const transformedResponse = await this.pipeline.transformContent(
        processedResponse.response,
        context,
      );

      // Validate the content from the transformed response
      const validationResult = await this.validateContent(
        transformedResponse.content,
        session,
      );

      if (!validationResult.isValid) {
        if (this.raiseError) {
          throw new ValidationError(
            `Validation failed: ${validationResult.instruction || ''}`,
          );
        } else {
          console.warn(
            'LlmSource: Validation failed but raiseError is false. Returning content anyway.',
          );
        }
      }

      // Return the transformed response
      return transformedResponse;
    });
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

  /** Reset all LLM call counters (useful for testing) */
  export function resetCallCounters(): void {
    llmCallCounter.clear();
  }

  /** Get current call count for a specific LlmSource instance */
  export function getCallCount(instanceId: string): number {
    return llmCallCounter.get(instanceId) || 0;
  }

  /** Create CLI input source with fluent API */
  export function cli(
    prompt?: string,
    defaultValue?: string,
    options?: ValidationOptions,
  ): CLISource {
    return new CLISource(prompt, defaultValue, options);
  }

  /** Create static literal content source with fluent API */
  export function literal(
    content: string,
    options?: ValidationOptions,
  ): LiteralSource {
    return new LiteralSource(content, options);
  }

  /** Create callback-based source with fluent API */
  export function callback(
    callback: (context: { context?: SessionContext }) => Promise<string>,
    options?: ValidationOptions,
  ): CallbackSource {
    return new CallbackSource(callback, options);
  }

  /** Create random content source with fluent API */
  export function random(
    contentList: string[],
    options?: ValidationOptions,
  ): RandomSource {
    return new RandomSource(contentList, options);
  }

  /** Create list content source with fluent API */
  export function list(
    contentList: string[],
    options?: ValidationOptions & { loop?: boolean },
  ): ListSource {
    return new ListSource(contentList, options);
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
