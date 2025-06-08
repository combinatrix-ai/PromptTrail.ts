// middleware.ts - Enhanced middleware and plugin system for Sources
import type { Session } from './session';
import type { LLMOptions, ModelOutput } from './source';
import type { IValidator, TValidationResult } from './validators/base';

/**
 * Context passed through the middleware pipeline
 */
export interface MiddlewareContext<T = unknown> {
  session: Session<any, any>;
  options?: LLMOptions;
  attempt: number;
  previousError?: Error;
  metadata: Record<string, unknown>;
}

/**
 * Request context for LLM calls
 */
export interface RequestContext extends MiddlewareContext<ModelOutput> {
  options: LLMOptions;
  messages?: Array<{
    role: string;
    content: string;
    tool_call_id?: string;
    tool_calls?: Array<unknown>;
  }>;
}

/**
 * Response context for LLM calls
 */
export interface ResponseContext extends RequestContext {
  response: ModelOutput;
  validationResult?: TValidationResult;
}

/**
 * Middleware function that can transform requests, responses, or handle errors
 */
export interface Middleware<TIn = unknown, TOut = unknown> {
  name: string;
  order?: number; // Lower numbers execute first

  // Transform request before execution
  beforeRequest?(
    context: MiddlewareContext<TIn>,
  ): Promise<MiddlewareContext<TIn>> | MiddlewareContext<TIn>;

  // Transform response after execution
  afterResponse?(
    context: MiddlewareContext<TOut>,
  ): Promise<MiddlewareContext<TOut>> | MiddlewareContext<TOut>;

  // Handle errors during execution
  onError?(
    context: MiddlewareContext<TIn>,
    error: Error,
  ): Promise<MiddlewareContext<TIn> | null> | MiddlewareContext<TIn> | null;

  // Transform content during validation
  transformContent?(
    content: TOut,
    context: MiddlewareContext<TIn>,
  ): Promise<TOut> | TOut;
}

/**
 * Request interceptor for LLM calls
 */
export interface RequestInterceptor {
  name: string;
  order?: number;
  intercept(context: RequestContext): Promise<RequestContext> | RequestContext;
}

/**
 * Response interceptor for LLM calls
 */
export interface ResponseInterceptor {
  name: string;
  order?: number;
  intercept(
    context: ResponseContext,
  ): Promise<ResponseContext> | ResponseContext;
}

/**
 * Retry configuration with exponential backoff
 */
export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number; // Base delay in milliseconds
  maxDelay: number; // Maximum delay in milliseconds
  backoffFactor: number; // Multiplier for exponential backoff
  jitter: boolean; // Add random jitter to prevent thundering herd
  retryableErrors?: Array<string | RegExp>; // Error patterns that should trigger retry
  onRetry?: (attempt: number, error: Error, delay: number) => void;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  backoffFactor: 2,
  jitter: true,
  retryableErrors: [
    /rate.?limit/i,
    /timeout/i,
    /network/i,
    /connection/i,
    /502/,
    /503/,
    /504/,
    'ECONNRESET',
    'ETIMEDOUT',
    /validation failed/i, // Add validation errors as retryable
  ],
};

/**
 * Utility to calculate exponential backoff delay
 */
export function calculateBackoffDelay(
  attempt: number,
  config: RetryConfig,
): number {
  const exponentialDelay =
    config.baseDelay * Math.pow(config.backoffFactor, attempt - 1);
  const clampedDelay = Math.min(exponentialDelay, config.maxDelay);

  if (config.jitter) {
    // Add ±25% jitter
    const jitterRange = clampedDelay * 0.25;
    const jitter = (Math.random() - 0.5) * 2 * jitterRange;
    return Math.max(0, clampedDelay + jitter);
  }

  return clampedDelay;
}

/**
 * Check if an error should trigger a retry
 */
export function isRetryableError(error: Error, config: RetryConfig): boolean {
  if (!config.retryableErrors) return true;

  const errorMessage = error.message || error.toString();

  return config.retryableErrors.some((pattern) => {
    if (pattern instanceof RegExp) {
      return pattern.test(errorMessage);
    }
    return errorMessage.includes(pattern);
  });
}

/**
 * Sleep utility for delays
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Middleware pipeline executor
 */
export class MiddlewarePipeline<TIn = unknown, TOut = unknown> {
  private middlewares: Middleware<TIn, TOut>[] = [];
  private requestInterceptors: RequestInterceptor[] = [];
  private responseInterceptors: ResponseInterceptor[] = [];

  /**
   * Add middleware to the pipeline
   */
  use(middleware: Middleware<TIn, TOut>): this {
    this.middlewares.push(middleware);
    this.middlewares.sort((a, b) => (a.order || 0) - (b.order || 0));
    return this;
  }

  /**
   * Add request interceptor
   */
  interceptRequest(interceptor: RequestInterceptor): this {
    this.requestInterceptors.push(interceptor);
    this.requestInterceptors.sort((a, b) => (a.order || 0) - (b.order || 0));
    return this;
  }

  /**
   * Add response interceptor
   */
  interceptResponse(interceptor: ResponseInterceptor): this {
    this.responseInterceptors.push(interceptor);
    this.responseInterceptors.sort((a, b) => (a.order || 0) - (b.order || 0));
    return this;
  }

  /**
   * Execute request interceptors
   */
  async executeRequestInterceptors(
    context: RequestContext,
  ): Promise<RequestContext> {
    let currentContext = context;

    for (const interceptor of this.requestInterceptors) {
      currentContext = await interceptor.intercept(currentContext);
    }

    return currentContext;
  }

  /**
   * Execute response interceptors
   */
  async executeResponseInterceptors(
    context: ResponseContext,
  ): Promise<ResponseContext> {
    let currentContext = context;

    for (const interceptor of this.responseInterceptors) {
      currentContext = await interceptor.intercept(currentContext);
    }

    return currentContext;
  }

  /**
   * Execute middleware before request
   */
  async executeBeforeRequest(
    context: MiddlewareContext<TIn>,
  ): Promise<MiddlewareContext<TIn>> {
    let currentContext = context;

    for (const middleware of this.middlewares) {
      if (middleware.beforeRequest) {
        currentContext = await middleware.beforeRequest(currentContext);
      }
    }

    return currentContext;
  }

  /**
   * Execute middleware after response
   */
  async executeAfterResponse(
    context: MiddlewareContext<TOut>,
  ): Promise<MiddlewareContext<TOut>> {
    let currentContext = context;

    // Execute in reverse order for after hooks
    for (const middleware of [...this.middlewares].reverse()) {
      if (middleware.afterResponse) {
        currentContext = await middleware.afterResponse(currentContext);
      }
    }

    return currentContext;
  }

  /**
   * Execute middleware error handlers
   */
  async executeErrorHandlers(
    context: MiddlewareContext<TIn>,
    error: Error,
  ): Promise<MiddlewareContext<TIn> | null> {
    for (const middleware of this.middlewares) {
      if (middleware.onError) {
        const result = await middleware.onError(context, error);
        if (result) {
          return result;
        }
      }
    }
    return null;
  }

  /**
   * Transform content through middleware
   */
  async transformContent(
    content: TOut,
    context: MiddlewareContext<TIn>,
  ): Promise<TOut> {
    let currentContent = content;

    for (const middleware of this.middlewares) {
      if (middleware.transformContent) {
        currentContent = await middleware.transformContent(
          currentContent,
          context,
        );
      }
    }

    return currentContent;
  }

  /**
   * Execute a function with retry logic and full middleware pipeline
   */
  async executeWithRetry<TResult>(
    fn: (context: MiddlewareContext<TIn>) => Promise<TResult>,
    initialContext: MiddlewareContext<TIn>,
    retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  ): Promise<TResult> {
    // Handle edge case where maxAttempts is 0
    if (retryConfig.maxAttempts <= 0) {
      throw new Error(
        'LLM content generation failed unexpectedly after 0 attempts.',
      );
    }

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
      const context: MiddlewareContext<TIn> = {
        ...initialContext,
        attempt,
        previousError: lastError,
      };

      try {
        // Execute before request middleware
        const beforeContext = await this.executeBeforeRequest(context);

        // Execute the main function
        const result = await fn(beforeContext);

        // Execute after response middleware with result
        const afterContext = { ...beforeContext, result } as any;
        await this.executeAfterResponse(afterContext);

        return result;
      } catch (error) {
        lastError = error as Error;

        // Try middleware error handlers first
        const recoveredContext = await this.executeErrorHandlers(
          context,
          lastError,
        );
        if (recoveredContext) {
          // Middleware handled the error, retry with recovered context
          if (retryConfig.onRetry) {
            retryConfig.onRetry(attempt, lastError, 0);
          }
          continue;
        }

        // Check if we should retry
        const isLastAttempt = attempt >= retryConfig.maxAttempts;

        if (isLastAttempt) {
          throw lastError;
        }

        // Only retry if the error is retryable
        if (!isRetryableError(lastError, retryConfig)) {
          throw lastError;
        }

        // Calculate delay and wait
        const delay = calculateBackoffDelay(attempt, retryConfig);

        if (retryConfig.onRetry) {
          retryConfig.onRetry(attempt, lastError, delay);
        }

        await sleep(delay);
      }
    }

    throw lastError || new Error('Retry loop completed without result');
  }

  /**
   * Clone the pipeline
   */
  clone(): MiddlewarePipeline<TIn, TOut> {
    const clone = new MiddlewarePipeline<TIn, TOut>();
    clone.middlewares = [...this.middlewares];
    clone.requestInterceptors = [...this.requestInterceptors];
    clone.responseInterceptors = [...this.responseInterceptors];
    return clone;
  }

  /**
   * Clear all middleware and interceptors
   */
  clear(): this {
    this.middlewares = [];
    this.requestInterceptors = [];
    this.responseInterceptors = [];
    return this;
  }

  /**
   * Get current middleware count
   */
  size(): {
    middlewares: number;
    requestInterceptors: number;
    responseInterceptors: number;
  } {
    return {
      middlewares: this.middlewares.length,
      requestInterceptors: this.requestInterceptors.length,
      responseInterceptors: this.responseInterceptors.length,
    };
  }
}

/**
 * Built-in middleware for common use cases
 */
export namespace BuiltinMiddleware {
  /**
   * Logging middleware
   */
  export function logging(
    options: {
      name?: string;
      logRequests?: boolean;
      logResponses?: boolean;
      logErrors?: boolean;
      logger?: (message: string, data?: any) => void;
    } = {},
  ): Middleware {
    const {
      name = 'logging',
      logRequests = true,
      logResponses = true,
      logErrors = true,
      logger = console.log,
    } = options;

    return {
      name,
      order: -1000, // Execute early
      beforeRequest: logRequests
        ? async (context) => {
            logger(`[${name}] Request attempt ${context.attempt}`, {
              session: context.session.toJSON(),
              options: context.options,
            });
            return context;
          }
        : undefined,
      afterResponse: logResponses
        ? async (context) => {
            logger(`[${name}] Response received`, { response: context });
            return context;
          }
        : undefined,
      onError: logErrors
        ? async (context, error) => {
            logger(`[${name}] Error on attempt ${context.attempt}:`, error);
            return null; // Don't handle, just log
          }
        : undefined,
    };
  }

  /**
   * Rate limiting middleware
   */
  export function rateLimit(options: {
    name?: string;
    requestsPerSecond: number;
    burstSize?: number;
  }): Middleware {
    const {
      name = 'rateLimit',
      requestsPerSecond,
      burstSize = requestsPerSecond,
    } = options;

    let tokens = burstSize;
    let lastRefill = Date.now();

    return {
      name,
      order: -500, // Execute early but after logging
      beforeRequest: async (context) => {
        const now = Date.now();
        const timePassed = (now - lastRefill) / 1000;

        // Refill tokens
        tokens = Math.min(burstSize, tokens + timePassed * requestsPerSecond);
        lastRefill = now;

        if (tokens < 1) {
          const waitTime = ((1 - tokens) / requestsPerSecond) * 1000;
          await sleep(waitTime);
          tokens = 0;
        } else {
          tokens -= 1;
        }

        return context;
      },
    };
  }

  /**
   * Content transformation middleware
   */
  export function transform<T>(options: {
    name?: string;
    transformContent: (
      content: T,
      context: MiddlewareContext,
    ) => Promise<T> | T;
  }): Middleware<unknown, T> {
    const { name = 'transform', transformContent } = options;

    return {
      name,
      transformContent,
    };
  }

  /**
   * Validation middleware
   */
  export function validation(options: {
    name?: string;
    validator: IValidator;
    onValidationFailure?: (
      result: TValidationResult,
      context: MiddlewareContext,
    ) => void;
  }): Middleware<unknown, string> {
    const { name = 'validation', validator, onValidationFailure } = options;

    return {
      name,
      transformContent: async (content: string, context) => {
        const validationResult = await validator.validate(
          content,
          context.session,
        );

        if (!validationResult.isValid && onValidationFailure) {
          onValidationFailure(validationResult, context);
        }

        return content;
      },
    };
  }

  /**
   * Caching middleware
   */
  export function cache<T>(
    options: {
      name?: string;
      ttl?: number; // Time to live in milliseconds
      keyGenerator?: (context: MiddlewareContext) => string;
      storage?: Map<string, { data: T; timestamp: number }>;
    } = {},
  ): Middleware<unknown, T> {
    const {
      name = 'cache',
      ttl = 60000, // 1 minute default
      keyGenerator = (context) => JSON.stringify(context.session.toJSON()),
      storage = new Map(),
    } = options;

    return {
      name,
      order: -100, // Execute early
      beforeRequest: async (context) => {
        const key = keyGenerator(context);
        const cached = storage.get(key);

        if (cached && Date.now() - cached.timestamp < ttl) {
          // Inject cached data into context to short-circuit execution
          (context as any).cachedResponse = cached.data;
          (context as any).useCache = true;
        }

        return context;
      },
      afterResponse: async (context) => {
        if (!(context as any).useCache) {
          const key = keyGenerator(context);
          // Store the result/content that was generated
          const dataToStore =
            (context as any).result || (context as any).response || context;
          storage.set(key, {
            data: dataToStore,
            timestamp: Date.now(),
          });
        }
        return context;
      },
    };
  }
}
