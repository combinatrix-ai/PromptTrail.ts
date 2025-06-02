// enhanced_source_demo.ts - Demonstration of enhanced Source capabilities
import {
  Agent,
  Source,
  BuiltinMiddleware,
  createSession,
  type RequestInterceptor,
  type ResponseInterceptor,
  type Middleware,
} from '@prompttrail/core';

/**
 * Demo: Enhanced Source with Middleware, Retry, and Interceptors
 */
async function demonstrateEnhancedSource() {
  console.log('🚀 Enhanced Source Capabilities Demo\n');

  // Create a session
  const session = createSession();

  // 1. Basic LLM Source with Retry Configuration
  console.log('1. Basic LLM Source with Enhanced Retry');
  const basicSource = Source.llm()
    .openai({ modelName: 'gpt-4o-mini' })
    .temperature(0.7)
    .withRetry({
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 5000,
      backoffFactor: 2,
      jitter: true,
      retryableErrors: [/rate.?limit/i, /timeout/i, /502/, /503/, /504/],
      onRetry: (attempt, error, delay) => {
        console.log(
          `   ⚠️  Retry attempt ${attempt} after ${delay}ms: ${error.message}`,
        );
      },
    });

  // 2. Add Built-in Middleware
  console.log('\n2. Adding Built-in Middleware');

  // Add logging middleware
  const enhancedSource = basicSource
    .useMiddleware(
      BuiltinMiddleware.logging({
        name: 'request-logger',
        logRequests: true,
        logResponses: true,
        logger: (message, data) => {
          console.log(`   📝 ${message}`);
          if (data && typeof data === 'object') {
            console.log(
              `       Data: ${JSON.stringify(data, null, 2).slice(0, 200)}...`,
            );
          }
        },
      }),
    )
    // Add rate limiting
    .useMiddleware(
      BuiltinMiddleware.rateLimit({
        name: 'rate-limiter',
        requestsPerSecond: 2,
        burstSize: 3,
      }),
    )
    // Add content transformation
    .useMiddleware(
      BuiltinMiddleware.transform({
        name: 'content-enhancer',
        transformContent: async (content: string) => {
          // Add metadata to responses
          return `${content}\n\n---\n🤖 Enhanced by PromptTrail.ts middleware`;
        },
      }),
    );

  // 3. Custom Request/Response Interceptors
  console.log('\n3. Adding Custom Interceptors');

  // Request interceptor to modify context
  const requestInterceptor: RequestInterceptor = {
    name: 'context-enricher',
    order: -10, // Execute early
    intercept: async (context) => {
      // Add custom metadata
      context.metadata.timestamp = new Date().toISOString();
      context.metadata.requestId = Math.random().toString(36).substr(2, 9);

      console.log(
        `   📤 Request interceptor: Added metadata ${context.metadata.requestId}`,
      );

      return context;
    },
  };

  // Response interceptor to modify responses
  const responseInterceptor: ResponseInterceptor = {
    name: 'response-enhancer',
    order: 10,
    intercept: async (context) => {
      // Add custom response metadata
      if (!context.response.metadata) {
        context.response.metadata = {};
      }

      context.response.metadata.processedAt = new Date().toISOString();
      context.response.metadata.requestId = context.metadata.requestId;

      console.log(
        `   📥 Response interceptor: Enhanced response for ${context.metadata.requestId}`,
      );

      return context;
    },
  };

  const interceptedSource = enhancedSource
    .interceptRequest(requestInterceptor)
    .interceptResponse(responseInterceptor);

  // 4. Custom Middleware for Complex Logic
  console.log('\n4. Adding Custom Middleware');

  // Custom middleware for content validation and correction
  const validationMiddleware: Middleware<unknown, string> = {
    name: 'content-validator',
    order: 5,
    transformContent: async (content: string, context) => {
      // Example: Ensure content meets certain criteria
      const lines = content.split('\n');
      const hasGreeting = lines.some(
        (line) =>
          line.toLowerCase().includes('hello') ||
          line.toLowerCase().includes('hi') ||
          line.toLowerCase().includes('greetings'),
      );

      if (!hasGreeting && context.attempt === 1) {
        console.log(`   ✨ Validation middleware: Adding greeting to content`);
        return `Hello! ${content}`;
      }

      return content;
    },
    onError: async (context, error) => {
      console.log(
        `   ❌ Validation middleware: Handling error - ${error.message}`,
      );

      // Example recovery logic
      if (error.message.includes('rate limit')) {
        console.log(`   🔄 Validation middleware: Attempting error recovery`);
        // Could modify context for retry
        return context;
      }

      return null; // Don't handle this error
    },
  };

  // Custom caching middleware with TTL
  const cachingMiddleware = BuiltinMiddleware.cache({
    name: 'smart-cache',
    ttl: 30000, // 30 seconds
    keyGenerator: (context) => {
      // Create cache key based on session content
      const messages = context.session.messages
        .map((m) => `${m.type}:${m.content}`)
        .join('|');
      return Buffer.from(messages).toString('base64').slice(0, 32);
    },
    storage: new Map(), // In-memory cache
  });

  const fullSource = interceptedSource
    .useMiddleware(validationMiddleware)
    .useMiddleware(cachingMiddleware);

  // 5. Demonstrate with Agent
  console.log('\n5. Using Enhanced Source with Agent');

  // Mock the source for demo (replace with real API call in production)
  const demoSource = fullSource.mock().mockResponse({
    content: 'I can help you with TypeScript development and AI integration!',
    metadata: { confidence: 0.95 },
  });

  const agent = Agent.create()
    .system('You are a helpful TypeScript and AI development assistant.')
    .user('What can you help me with?')
    .assistant(demoSource);

  try {
    const result = await agent.run(session, { print: false });

    console.log('\n✅ Final Result:');
    console.log(
      'Content:',
      result.session.getLastMessage()?.content?.slice(0, 200) + '...',
    );
    console.log('Metadata:', result.session.getLastMessage()?.attrs);

    // Demonstrate call history for mocked source
    const mockSource = demoSource as any;
    if (mockSource.getCallHistory) {
      console.log('\n📊 Call History:');
      console.log(`Total calls: ${mockSource.getCallCount()}`);
    }
  } catch (error) {
    console.error('❌ Error during execution:', error);
  }

  // 6. Demonstrate Error Recovery
  console.log('\n6. Demonstrating Error Recovery');

  const errorSource = Source.llm()
    .mock()
    .withRetry({
      maxAttempts: 3,
      baseDelay: 100, // Fast for demo
      onRetry: (attempt, error, delay) => {
        console.log(
          `   🔄 Retry ${attempt}: ${error.message} (waiting ${delay}ms)`,
        );
      },
    })
    .useMiddleware(
      BuiltinMiddleware.logging({
        logErrors: true,
        logger: (message) => console.log(`   📝 ${message}`),
      }),
    );

  // Simulate failures then success
  let errorAttempts = 0;
  errorSource.mockCallback(async (session, options) => {
    errorAttempts++;
    if (errorAttempts < 3) {
      throw new Error('Temporary network error');
    }
    return { content: 'Success after retries!' };
  });

  try {
    const errorResult = await errorSource.getContent(session);
    console.log(
      `   ✅ Recovered after ${errorAttempts} attempts: ${errorResult.content}`,
    );
  } catch (error) {
    console.log(`   ❌ Failed after all retries: ${error}`);
  }

  console.log('\n🎉 Enhanced Source Demo Complete!');
  console.log('\nKey Features Demonstrated:');
  console.log('✓ Exponential backoff retry with jitter');
  console.log(
    '✓ Built-in middleware (logging, rate limiting, caching, transforms)',
  );
  console.log('✓ Custom request/response interceptors');
  console.log('✓ Custom middleware with error handling');
  console.log('✓ Middleware pipeline composition');
  console.log('✓ Error recovery and resilience');
}

/**
 * Demo: Performance and Monitoring Features
 */
async function demonstratePerformanceFeatures() {
  console.log('\n🔧 Performance & Monitoring Features Demo\n');

  const session = createSession();

  // Performance monitoring middleware
  const performanceMiddleware: Middleware = {
    name: 'performance-monitor',
    order: -1000, // Execute first
    beforeRequest: async (context) => {
      context.metadata.startTime = Date.now();
      return context;
    },
    afterResponse: async (context) => {
      const duration = Date.now() - (context.metadata.startTime as number);
      console.log(`   ⏱️  Request completed in ${duration}ms`);
      context.metadata.duration = duration;
      return context;
    },
  };

  // Circuit breaker pattern middleware
  let failureCount = 0;
  let circuitOpen = false;
  const circuitBreakerMiddleware: Middleware = {
    name: 'circuit-breaker',
    beforeRequest: async (context) => {
      if (circuitOpen) {
        throw new Error('Circuit breaker is open - service unavailable');
      }
      return context;
    },
    onError: async (context, error) => {
      failureCount++;
      if (failureCount >= 3) {
        circuitOpen = true;
        console.log('   🔴 Circuit breaker opened after 3 failures');
        // In real implementation, would close after timeout
        setTimeout(() => {
          circuitOpen = false;
          failureCount = 0;
          console.log('   🟢 Circuit breaker closed');
        }, 5000);
      }
      return null; // Don't handle the error, just monitor
    },
  };

  const monitoredSource = Source.llm()
    .mock()
    .useMiddleware(performanceMiddleware)
    .useMiddleware(circuitBreakerMiddleware)
    .mockResponse({ content: 'Monitored response' });

  console.log('1. Performance Monitoring');
  const result = await monitoredSource.getContent(session);
  console.log(`   📊 Response: ${result.content}`);

  console.log('\n2. Rate Limiting in Action');
  const rateLimitedSource = Source.llm()
    .mock()
    .useMiddleware(
      BuiltinMiddleware.rateLimit({
        requestsPerSecond: 1,
        burstSize: 2,
      }),
    )
    .mockResponse({ content: 'Rate limited response' });

  const start = Date.now();

  // These should be rate limited
  await Promise.all([
    rateLimitedSource.getContent(session),
    rateLimitedSource.getContent(session),
    rateLimitedSource.getContent(session),
  ]);

  const duration = Date.now() - start;
  console.log(
    `   ⏱️  Three requests completed in ${duration}ms (rate limited)`,
  );

  console.log('\n🎯 Performance Demo Complete!');
}

// Run the demos
if (require.main === module) {
  demonstrateEnhancedSource()
    .then(() => demonstratePerformanceFeatures())
    .catch(console.error);
}

export { demonstrateEnhancedSource, demonstratePerformanceFeatures };
