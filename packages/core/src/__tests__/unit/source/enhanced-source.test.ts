// enhanced-source.test.ts - Tests for enhanced Source with middleware support
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../../../session';
import { Source, LlmSource, LiteralSource } from '../../../source';
import {
  MiddlewarePipeline,
  BuiltinMiddleware,
  RequestInterceptor,
  ResponseInterceptor,
  DEFAULT_RETRY_CONFIG,
} from '../../../middleware';
import type { ModelOutput } from '../../../source';

describe('Enhanced Source with Middleware', () => {
  let session: ReturnType<typeof createSession>;

  beforeEach(() => {
    session = createSession();
  });

  describe('Base Source Middleware Support', () => {
    it('should add middleware to pipeline', () => {
      const source = new LiteralSource('test');
      const middleware = BuiltinMiddleware.logging();

      source.useMiddleware(middleware);

      const pipeline = source.getMiddlewarePipeline();
      expect(pipeline.size().middlewares).toBe(1);
    });

    it('should configure retry behavior', () => {
      const source = new LiteralSource('test');

      source.withRetry({
        maxAttempts: 5,
        baseDelay: 2000,
      });

      // Access the protected retryConfig through any
      expect((source as any).retryConfig.maxAttempts).toBe(5);
      expect((source as any).retryConfig.baseDelay).toBe(2000);
    });

    it('should execute content generation with middleware', async () => {
      const source = new LiteralSource('test');
      let middlewareExecuted = false;

      const middleware = BuiltinMiddleware.transform({
        transformContent: async (content: string) => {
          middlewareExecuted = true;
          return content.toUpperCase();
        },
      });

      source.useMiddleware(middleware);

      const result = await source.getContent(session);

      expect(middlewareExecuted).toBe(true);
      expect(result).toBe('TEST');
    });
  });

  describe('LlmSource Enhanced Features', () => {
    let mockSource: LlmSource;

    beforeEach(() => {
      // Create a mocked LLM source for testing
      mockSource = Source.llm().mock();
    });

    it('should add request interceptors', () => {
      const interceptor: RequestInterceptor = {
        name: 'test-interceptor',
        intercept: async (context) => {
          context.metadata.intercepted = true;
          return context;
        },
      };

      mockSource.interceptRequest(interceptor);

      const pipeline = mockSource.getMiddlewarePipeline();
      expect(pipeline.size().requestInterceptors).toBe(1);
    });

    it('should add response interceptors', () => {
      const interceptor: ResponseInterceptor = {
        name: 'test-interceptor',
        intercept: async (context) => {
          context.response.content = 'intercepted';
          return context;
        },
      };

      mockSource.interceptResponse(interceptor);

      const pipeline = mockSource.getMiddlewarePipeline();
      expect(pipeline.size().responseInterceptors).toBe(1);
    });

    it('should process content through middleware pipeline', async () => {
      mockSource.mockResponse({ content: 'original' });

      // Add a transform middleware
      mockSource.useMiddleware(
        BuiltinMiddleware.transform({
          transformContent: async (content: string) =>
            `transformed: ${content}`,
        }),
      );

      const result = await mockSource.getContent(session);
      expect(result.content).toBe('transformed: original');
    });

    it('should execute request interceptors before generation', async () => {
      let interceptorExecuted = false;

      mockSource.mockResponse({ content: 'test' });

      mockSource.interceptRequest({
        name: 'test',
        intercept: async (context) => {
          interceptorExecuted = true;
          return context;
        },
      });

      await mockSource.getContent(session);
      expect(interceptorExecuted).toBe(true);
    });

    it('should execute response interceptors after generation', async () => {
      let interceptorExecuted = false;

      mockSource.mockResponse({ content: 'test' });

      mockSource.interceptResponse({
        name: 'test',
        intercept: async (context) => {
          interceptorExecuted = true;
          context.response.metadata = { modified: true };
          return context;
        },
      });

      const result = await mockSource.getContent(session);
      expect(interceptorExecuted).toBe(true);
      expect(result.metadata?.modified).toBe(true);
    });

    it('should preserve middleware in cloned instances', () => {
      const middleware = BuiltinMiddleware.logging();
      mockSource.useMiddleware(middleware);

      const cloned = mockSource.temperature(0.5);

      expect(cloned.getMiddlewarePipeline().size().middlewares).toBe(1);
    });
  });

  describe('Retry and Error Handling', () => {
    it('should retry on retryable errors', async () => {
      const source = Source.llm().mock();
      let attempts = 0;

      // Configure retry with fast delays for testing
      source.withRetry({
        maxAttempts: 3,
        baseDelay: 1,
        retryableErrors: ['ECONNRESET'],
      });

      // Mock responses: first two fail, third succeeds
      source.mockCallback(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('ECONNRESET');
        }
        return { content: 'success' };
      });

      const result = await source.getContent(session);

      expect(attempts).toBe(3);
      expect(result.content).toBe('success');
    });

    it('should not retry on non-retryable errors', async () => {
      const source = Source.llm().mock();
      let attempts = 0;

      source.withRetry({
        maxAttempts: 3,
        retryableErrors: ['ECONNRESET'], // Only specific errors are retryable
      });

      source.mockCallback(async () => {
        attempts++;
        throw new Error('Invalid API key'); // Non-retryable
      });

      await expect(source.getContent(session)).rejects.toThrow(
        'Invalid API key',
      );
      expect(attempts).toBe(1);
    });

    it('should execute error handlers in middleware', async () => {
      const source = Source.llm().mock();
      let errorHandled = false;

      source.useMiddleware({
        name: 'error-handler',
        onError: async (context, error) => {
          errorHandled = true;
          if (error.message === 'recoverable') {
            // Return a recovered context to continue execution
            return context;
          }
          return null; // Don't handle this error
        },
      });

      source.mockCallback(async () => {
        throw new Error('recoverable');
      });

      // Since we can't easily test recovery in this setup, just test that error handler is called
      await expect(source.getContent(session)).rejects.toThrow('recoverable');
      expect(errorHandled).toBe(true);
    });
  });

  describe('Built-in Middleware Integration', () => {
    it('should integrate logging middleware', async () => {
      const logs: Array<{ message: string; data?: any }> = [];
      const logger = (message: string, data?: any) =>
        logs.push({ message, data });

      const source = Source.llm().mock();
      source.mockResponse({ content: 'test response' });

      source.useMiddleware(
        BuiltinMiddleware.logging({
          logger,
          logRequests: true,
          logResponses: true,
        }),
      );

      await source.getContent(session);

      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].message).toContain('Request attempt');
    });

    it('should integrate rate limiting middleware', async () => {
      const source = Source.llm().mock();
      source.mockResponse({ content: 'test' });

      source.useMiddleware(
        BuiltinMiddleware.rateLimit({
          requestsPerSecond: 1,
          burstSize: 1,
        }),
      );

      const start = Date.now();

      // First request
      await source.getContent(session);

      // Second request should be rate limited
      await source.getContent(session);

      const duration = Date.now() - start;

      // Should take at least 900ms due to rate limiting (allowing some margin)
      expect(duration).toBeGreaterThan(800);
    });

    it('should integrate caching middleware', async () => {
      const storage = new Map();
      const source = Source.llm().mock();

      let callCount = 0;
      source.mockCallback(async () => {
        callCount++;
        return { content: `response-${callCount}` };
      });

      source.useMiddleware(
        BuiltinMiddleware.cache({
          ttl: 1000,
          storage,
          keyGenerator: () => 'fixed-key',
        }),
      );

      // First call should execute and cache
      const result1 = await source.getContent(session);

      // Second call should use cache
      const result2 = await source.getContent(session);

      expect(callCount).toBe(1); // Only one actual call
      expect(result1.content).toBe('response-1');
      expect(result2.content).toBe('response-1'); // Same cached result
    });
  });

  describe('Complex Middleware Composition', () => {
    it('should execute multiple middleware in correct order', async () => {
      const source = Source.llm().mock();
      source.mockResponse({ content: 'original' });

      const executionOrder: string[] = [];

      // Add middleware in reverse order to test ordering
      source.useMiddleware({
        name: 'third',
        order: 3,
        beforeRequest: async (context) => {
          executionOrder.push('third-before');
          return context;
        },
        afterResponse: async (context) => {
          executionOrder.push('third-after');
          return context;
        },
      });

      source.useMiddleware({
        name: 'first',
        order: 1,
        beforeRequest: async (context) => {
          executionOrder.push('first-before');
          return context;
        },
        afterResponse: async (context) => {
          executionOrder.push('first-after');
          return context;
        },
      });

      source.useMiddleware({
        name: 'second',
        order: 2,
        transformContent: async (content) => {
          executionOrder.push('second-transform');
          return content;
        },
      });

      await source.getContent(session);

      // beforeRequest should be in order, afterResponse in reverse order
      expect(executionOrder).toContain('first-before');
      expect(executionOrder).toContain('third-before');
      expect(executionOrder).toContain('first-after');
      expect(executionOrder).toContain('third-after');
      expect(executionOrder).toContain('second-transform');

      // Verify order relationships
      const firstBeforeIndex = executionOrder.indexOf('first-before');
      const thirdBeforeIndex = executionOrder.indexOf('third-before');
      const firstAfterIndex = executionOrder.indexOf('first-after');
      const thirdAfterIndex = executionOrder.indexOf('third-after');

      expect(firstBeforeIndex).toBeLessThan(thirdBeforeIndex);
      expect(thirdAfterIndex).toBeLessThan(firstAfterIndex);
    });
  });
});
