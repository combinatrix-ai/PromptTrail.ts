// middleware.test.ts - Tests for the enhanced middleware system
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MiddlewarePipeline,
  MiddlewareContext,
  RequestContext,
  ResponseContext,
  Middleware,
  RequestInterceptor,
  ResponseInterceptor,
  BuiltinMiddleware,
  calculateBackoffDelay,
  isRetryableError,
  DEFAULT_RETRY_CONFIG,
  sleep,
} from '../../middleware';
import { createSession } from '../../session';
import type { LLMOptions, ModelOutput } from '../../source';

describe('MiddlewarePipeline', () => {
  let pipeline: MiddlewarePipeline<string, string>;
  let session: ReturnType<typeof createSession>;
  let mockContext: MiddlewareContext<string>;

  beforeEach(() => {
    pipeline = new MiddlewarePipeline<string, string>();
    session = createSession();
    mockContext = {
      session,
      attempt: 1,
      metadata: {},
    };
  });

  describe('Middleware Management', () => {
    it('should add and order middleware by priority', () => {
      const middleware1: Middleware<string, string> = {
        name: 'high-priority',
        order: -100,
      };
      const middleware2: Middleware<string, string> = {
        name: 'low-priority',
        order: 100,
      };
      const middleware3: Middleware<string, string> = {
        name: 'default-priority',
      };

      pipeline.use(middleware2).use(middleware1).use(middleware3);

      const size = pipeline.size();
      expect(size.middlewares).toBe(3);
    });

    it('should clone pipeline with all middleware', () => {
      const middleware: Middleware<string, string> = {
        name: 'test',
      };
      pipeline.use(middleware);

      const cloned = pipeline.clone();
      expect(cloned.size().middlewares).toBe(1);
    });

    it('should clear all middleware', () => {
      const middleware: Middleware<string, string> = {
        name: 'test',
      };
      pipeline.use(middleware);

      pipeline.clear();
      const size = pipeline.size();
      expect(size.middlewares).toBe(0);
    });
  });

  describe('Middleware Execution', () => {
    it('should execute beforeRequest middleware in order', async () => {
      const executionOrder: string[] = [];

      const middleware1: Middleware<string, string> = {
        name: 'first',
        order: 1,
        beforeRequest: async (context) => {
          executionOrder.push('first');
          return context;
        },
      };

      const middleware2: Middleware<string, string> = {
        name: 'second',
        order: 2,
        beforeRequest: async (context) => {
          executionOrder.push('second');
          return context;
        },
      };

      pipeline.use(middleware2).use(middleware1);

      await pipeline.executeBeforeRequest(mockContext);

      expect(executionOrder).toEqual(['first', 'second']);
    });

    it('should execute afterResponse middleware in reverse order', async () => {
      const executionOrder: string[] = [];

      const middleware1: Middleware<string, string> = {
        name: 'first',
        order: 1,
        afterResponse: async (context) => {
          executionOrder.push('first');
          return context;
        },
      };

      const middleware2: Middleware<string, string> = {
        name: 'second',
        order: 2,
        afterResponse: async (context) => {
          executionOrder.push('second');
          return context;
        },
      };

      pipeline.use(middleware1).use(middleware2);

      await pipeline.executeAfterResponse(mockContext);

      expect(executionOrder).toEqual(['second', 'first']);
    });

    it('should transform content through middleware', async () => {
      const middleware: Middleware<string, string> = {
        name: 'transformer',
        transformContent: async (content) => {
          return content.toUpperCase();
        },
      };

      pipeline.use(middleware);

      const result = await pipeline.transformContent('hello', mockContext);
      expect(result).toBe('HELLO');
    });
  });

  describe('Error Handling', () => {
    it('should execute error handlers', async () => {
      let errorHandled = false;

      const middleware: Middleware<string, string> = {
        name: 'error-handler',
        onError: async (context, error) => {
          errorHandled = true;
          return context;
        },
      };

      pipeline.use(middleware);

      const error = new Error('Test error');
      const result = await pipeline.executeErrorHandlers(mockContext, error);

      expect(errorHandled).toBe(true);
      expect(result).toBe(mockContext);
    });

    it('should return null if no error handler succeeds', async () => {
      const middleware: Middleware<string, string> = {
        name: 'no-handler',
      };

      pipeline.use(middleware);

      const error = new Error('Test error');
      const result = await pipeline.executeErrorHandlers(mockContext, error);

      expect(result).toBeNull();
    });
  });

  describe('Retry Logic', () => {
    it('should execute function with retry on failure', async () => {
      let attempts = 0;
      const mockFn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Network timeout error'); // Use a retryable error pattern
        }
        return 'success';
      });

      const result = await pipeline.executeWithRetry(mockFn, mockContext, {
        ...DEFAULT_RETRY_CONFIG,
        maxAttempts: 3,
        baseDelay: 1, // Fast for testing
      });

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should throw after max attempts', async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValue(new Error('Network timeout error'));

      await expect(
        pipeline.executeWithRetry(mockFn, mockContext, {
          ...DEFAULT_RETRY_CONFIG,
          maxAttempts: 2,
          baseDelay: 1,
        }),
      ).rejects.toThrow('Network timeout error');

      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('Request/Response Interceptors', () => {
    it('should execute request interceptors', async () => {
      const requestContext: RequestContext = {
        ...mockContext,
        options: {} as LLMOptions,
      };

      const interceptor: RequestInterceptor = {
        name: 'test-interceptor',
        intercept: async (context) => {
          context.metadata.intercepted = true;
          return context;
        },
      };

      pipeline.interceptRequest(interceptor);

      const result = await pipeline.executeRequestInterceptors(requestContext);
      expect(result.metadata.intercepted).toBe(true);
    });

    it('should execute response interceptors', async () => {
      const responseContext: ResponseContext = {
        ...mockContext,
        options: {} as LLMOptions,
        response: { content: 'test' } as ModelOutput,
      };

      const interceptor: ResponseInterceptor = {
        name: 'test-interceptor',
        intercept: async (context) => {
          context.response.content = 'modified';
          return context;
        },
      };

      pipeline.interceptResponse(interceptor);

      const result =
        await pipeline.executeResponseInterceptors(responseContext);
      expect(result.response.content).toBe('modified');
    });
  });
});

describe('Retry Utilities', () => {
  describe('calculateBackoffDelay', () => {
    it('should calculate exponential backoff', () => {
      const config = {
        ...DEFAULT_RETRY_CONFIG,
        jitter: false,
      };

      expect(calculateBackoffDelay(1, config)).toBe(1000);
      expect(calculateBackoffDelay(2, config)).toBe(2000);
      expect(calculateBackoffDelay(3, config)).toBe(4000);
    });

    it('should respect max delay', () => {
      const config = {
        ...DEFAULT_RETRY_CONFIG,
        maxDelay: 3000,
        jitter: false,
      };

      expect(calculateBackoffDelay(5, config)).toBe(3000);
    });

    it('should add jitter when enabled', () => {
      const config = {
        ...DEFAULT_RETRY_CONFIG,
        jitter: true,
      };

      const delay1 = calculateBackoffDelay(1, config);
      const delay2 = calculateBackoffDelay(1, config);

      // With jitter, delays should potentially be different
      // We can't guarantee they're different, but they should be in the right range
      expect(delay1).toBeGreaterThan(500);
      expect(delay1).toBeLessThan(1500);
    });
  });

  describe('isRetryableError', () => {
    it('should identify retryable errors', () => {
      const config = DEFAULT_RETRY_CONFIG;

      expect(isRetryableError(new Error('Rate limit exceeded'), config)).toBe(
        true,
      );
      expect(isRetryableError(new Error('Connection timeout'), config)).toBe(
        true,
      );
      expect(isRetryableError(new Error('502 Bad Gateway'), config)).toBe(true);
      expect(isRetryableError(new Error('ECONNRESET'), config)).toBe(true);
    });

    it('should identify non-retryable errors', () => {
      const config = {
        ...DEFAULT_RETRY_CONFIG,
        retryableErrors: [/rate.?limit/i],
      };

      expect(isRetryableError(new Error('Rate limit exceeded'), config)).toBe(
        true,
      );
      expect(isRetryableError(new Error('Invalid API key'), config)).toBe(
        false,
      );
    });
  });

  describe('sleep', () => {
    it('should sleep for specified duration', async () => {
      const start = Date.now();
      await sleep(10);
      const end = Date.now();

      expect(end - start).toBeGreaterThanOrEqual(8); // Allow some margin
    });
  });
});

describe('BuiltinMiddleware', () => {
  let pipeline: MiddlewarePipeline<string, string>;
  let mockContext: MiddlewareContext<string>;

  beforeEach(() => {
    pipeline = new MiddlewarePipeline<string, string>();
    mockContext = {
      session: createSession(),
      attempt: 1,
      metadata: {},
    };
  });

  describe('logging', () => {
    it('should log requests and responses', async () => {
      const logs: string[] = [];
      const logger = (message: string) => logs.push(message);

      const loggingMiddleware = BuiltinMiddleware.logging({
        logger,
        logRequests: true,
        logResponses: true,
      });

      pipeline.use(loggingMiddleware);

      if (loggingMiddleware.beforeRequest) {
        await loggingMiddleware.beforeRequest(mockContext);
      }

      if (loggingMiddleware.afterResponse) {
        await loggingMiddleware.afterResponse(mockContext);
      }

      expect(logs.length).toBe(2);
      expect(logs[0]).toContain('Request attempt 1');
      expect(logs[1]).toContain('Response received');
    });
  });

  describe('rateLimit', () => {
    it('should enforce rate limiting', async () => {
      const rateLimitMiddleware = BuiltinMiddleware.rateLimit({
        requestsPerSecond: 2,
        burstSize: 1,
      });

      pipeline.use(rateLimitMiddleware);

      const start = Date.now();

      // First request should go through immediately
      if (rateLimitMiddleware.beforeRequest) {
        await rateLimitMiddleware.beforeRequest(mockContext);
      }

      // Second request should be delayed
      if (rateLimitMiddleware.beforeRequest) {
        await rateLimitMiddleware.beforeRequest(mockContext);
      }

      const end = Date.now();
      const duration = end - start;

      // Should take at least 400ms due to rate limiting (1/2 requests per second = 500ms, with some margin)
      expect(duration).toBeGreaterThan(300);
    });
  });

  describe('transform', () => {
    it('should transform content', async () => {
      const transformMiddleware = BuiltinMiddleware.transform({
        transformContent: async (content: string) => content.toUpperCase(),
      });

      pipeline.use(transformMiddleware);

      const result = await pipeline.transformContent('hello', mockContext);
      expect(result).toBe('HELLO');
    });
  });

  describe('cache', () => {
    it('should cache responses', async () => {
      const storage = new Map();
      const cacheMiddleware = BuiltinMiddleware.cache({
        ttl: 1000,
        storage,
        keyGenerator: () => 'test-key',
      });

      pipeline.use(cacheMiddleware);

      // First request - should cache
      const contextWithResponse = { ...mockContext, response: 'cached-data' };
      if (cacheMiddleware.afterResponse) {
        await cacheMiddleware.afterResponse(contextWithResponse);
      }

      expect(storage.has('test-key')).toBe(true);

      // Second request - should use cache
      if (cacheMiddleware.beforeRequest) {
        await cacheMiddleware.beforeRequest(mockContext);
      }

      expect((mockContext as any).cachedResponse).toBe('cached-data');
    });
  });
});
