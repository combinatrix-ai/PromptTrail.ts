import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Session } from '../../../session';
import { Source } from '../../../source';
import { Validation } from '../../../validators';

describe('Source.llm().mock()', () => {
  describe('API compatibility with LlmSource', () => {
    it('should have the same fluent API as LlmSource', () => {
      const llmSource = Source.llm();
      const mockSource = Source.llm().mock();

      // Both should have the same methods
      expect(typeof mockSource.openai).toBe(typeof llmSource.openai);
      expect(typeof mockSource.anthropic).toBe(typeof llmSource.anthropic);
      expect(typeof mockSource.google).toBe(typeof llmSource.google);
      expect(typeof mockSource.model).toBe(typeof llmSource.model);
      expect(typeof mockSource.apiKey).toBe(typeof llmSource.apiKey);
      expect(typeof mockSource.temperature).toBe(typeof llmSource.temperature);
      expect(typeof mockSource.maxTokens).toBe(typeof llmSource.maxTokens);
      expect(typeof mockSource.topP).toBe(typeof llmSource.topP);
      expect(typeof mockSource.topK).toBe(typeof llmSource.topK);
      expect(typeof mockSource.addTool).toBe(typeof llmSource.addTool);
      expect(typeof mockSource.withTool).toBe(typeof llmSource.withTool);
      expect(typeof mockSource.withTools).toBe(typeof llmSource.withTools);
      expect(typeof mockSource.toolChoice).toBe(typeof llmSource.toolChoice);
      expect(typeof mockSource.dangerouslyAllowBrowser).toBe(
        typeof llmSource.dangerouslyAllowBrowser,
      );
      expect(typeof mockSource.maxCalls).toBe(typeof llmSource.maxCalls);
      expect(typeof mockSource.withSchema).toBe(typeof llmSource.withSchema);
      expect(typeof mockSource.validate).toBe(typeof llmSource.validate);
      expect(typeof mockSource.withMaxAttempts).toBe(
        typeof llmSource.withMaxAttempts,
      );
      expect(typeof mockSource.withRaiseError).toBe(
        typeof llmSource.withRaiseError,
      );
    });

    it('should maintain fluent API chain with MockedLlmSource return type', () => {
      const source = Source.llm()
        .openai({ modelName: 'gpt-4' })
        .temperature(0.8)
        .maxTokens(1000)
        .withTool('weather', { name: 'weather' })
        .validate(Validation.length({ min: 10 }))
        .mock();

      // Mock-specific methods should be available
      expect(typeof source.mockResponse).toBe('function');
      expect(typeof source.mockResponses).toBe('function');
      expect(typeof source.mockCallback).toBe('function');
    });

    it('should support all provider configurations', () => {
      // OpenAI
      const openaiMock = Source.llm()
        .openai({
          modelName: 'gpt-4',
          apiKey: 'test-key',
          baseURL: 'https://test.com',
          organization: 'test-org',
          dangerouslyAllowBrowser: true,
        })
        .mock();
      expect(typeof openaiMock.mockResponse).toBe('function');

      // Anthropic
      const anthropicMock = Source.llm()
        .anthropic({
          modelName: 'claude-3',
          apiKey: 'test-key',
          baseURL: 'https://test.com',
        })
        .mock();
      expect(typeof anthropicMock.mockResponse).toBe('function');

      // Google
      const googleMock = Source.llm()
        .google({
          modelName: 'gemini-pro',
          apiKey: 'test-key',
          baseURL: 'https://test.com',
        })
        .mock();
      expect(typeof googleMock.mockResponse).toBe('function');
    });

    it('should support schema configuration', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const mockWithSchema = Source.llm()
        .withSchema(schema, {
          mode: 'structured_output',
          functionName: 'getUser',
        })
        .mock();

      expect(typeof mockWithSchema.mockResponse).toBe('function');
    });
  });

  describe('Mock functionality', () => {
    it('should return mock response', async () => {
      const session = Session.create();
      const mockSource = Source.llm().mock().mockResponse({
        content: 'Test response',
      });

      const result = await mockSource.getContent(session);
      expect(result.content).toBe('Test response');
    });

    it('should cycle through multiple mock responses', async () => {
      const session = Session.create();
      const mockSource = Source.llm()
        .mock()
        .mockResponses(
          { content: 'Response 1' },
          { content: 'Response 2' },
          { content: 'Response 3' },
        );

      // First cycle
      expect((await mockSource.getContent(session)).content).toBe('Response 1');
      expect((await mockSource.getContent(session)).content).toBe('Response 2');
      expect((await mockSource.getContent(session)).content).toBe('Response 3');

      // Should cycle back to the beginning
      expect((await mockSource.getContent(session)).content).toBe('Response 1');
    });

    it('should use callback for dynamic responses', async () => {
      const session = Session.withVars({ name: 'Alice' });
      const mockSource = Source.llm()
        .temperature(0.9)
        .mock()
        .mockCallback(async (sess, options) => ({
          content: `Hello, ${sess.vars.name}! Temperature: ${options.temperature}`,
        }));

      const result = await mockSource.getContent(session);
      expect(result.content).toBe('Hello, Alice! Temperature: 0.9');
    });

    it('should track call history', async () => {
      const session = Session.create();
      const mockSource = Source.llm()
        .model('gpt-4')
        .temperature(0.7)
        .mock()
        .mockResponse({ content: 'Test' });

      expect(mockSource.getCallCount()).toBe(0);

      await mockSource.getContent(session);
      await mockSource.getContent(session);

      expect(mockSource.getCallCount()).toBe(2);

      const lastCall = mockSource.getLastCall();
      expect(lastCall).toBeDefined();
      expect(lastCall.session).toBe(session);
      expect(lastCall.options.provider.modelName).toBe('gpt-4');
      expect(lastCall.options.temperature).toBe(0.7);
    });

    it('should support reset', async () => {
      const session = Session.create();
      const mockSource = Source.llm().mock().mockResponse({ content: 'Test' });

      await mockSource.getContent(session);
      expect(mockSource.getCallCount()).toBe(1);

      const resetSource = mockSource.reset();
      expect(resetSource.getCallCount()).toBe(0);
    });

    it('should include tool calls and structured output in response', async () => {
      const session = Session.create();
      const mockSource = Source.llm()
        .mock()
        .mockResponse({
          content: 'Using weather tool',
          toolCalls: [
            { name: 'weather', arguments: { city: 'Tokyo' }, id: 'call_1' },
          ],
          toolResults: [{ toolCallId: 'call_1', result: { temp: 25 } }],
          metadata: { usage: { tokens: 100 } },
          structuredOutput: { parsed: true },
        });

      const result = await mockSource.getContent(session);
      expect(result.content).toBe('Using weather tool');
      expect(result.toolCalls).toEqual([
        { name: 'weather', arguments: { city: 'Tokyo' }, id: 'call_1' },
      ]);
      expect(result.toolResults).toEqual([
        { toolCallId: 'call_1', result: { temp: 25 } },
      ]);
      expect(result.metadata).toEqual({ usage: { tokens: 100 } });
      expect(result.structuredOutput).toEqual({ parsed: true });
    });

    it('should apply validation to mock responses', async () => {
      const session = Session.create();
      const validator = Validation.length({ min: 20 });

      const mockSource = Source.llm()
        .validate(validator)
        .withRaiseError(true)
        .mock()
        .mockResponse({ content: 'Too short' });

      await expect(mockSource.getContent(session)).rejects.toThrow(
        'Validation failed after 1 attempts:',
      );
    });

    it('should respect validation settings', async () => {
      const session = Session.create();
      const validator = Validation.length({ min: 20 });

      // With raiseError = false, should return content even if invalid
      const mockSource = Source.llm()
        .validate(validator)
        .withRaiseError(false)
        .mock()
        .mockResponse({ content: 'Too short' });

      const result = await mockSource.getContent(session);
      expect(result.content).toBe('Too short');
    });

    it('should return default mock response when none is set', async () => {
      const session = Session.create();
      const mockSource = Source.llm().mock();

      const result = await mockSource.getContent(session);
      expect(result.content).toBe('Mock LLM response');
    });

    it('should maintain immutability', async () => {
      const session = Session.create();
      const original = Source.llm()
        .mock()
        .mockResponse({ content: 'Original' });

      // Call getContent to populate call history
      await original.getContent(session);
      expect(original.getCallCount()).toBe(1);

      // Create modified version should not affect original's call history
      const modified = Source.llm().temperature(0.5).mock().mockResponse({
        content: 'Modified',
      });

      // They should be different instances with independent state
      expect(original.getCallCount()).toBe(1);
      expect(modified.getCallCount()).toBe(0);
    });
  });
});
