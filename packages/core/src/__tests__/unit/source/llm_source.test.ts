import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from '../../../generate';
import { Session } from '../../../session';
import { LlmSource, Source } from '../../../source';
import { CustomValidator } from '../../../validators/custom';

// Mock the generate module
vi.mock('../../../generate', () => ({
  generateText: vi.fn(),
}));

describe('LlmSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'Mock response',
    });
  });

  describe('Factory method', () => {
    it('should create LlmSource with sensible defaults', () => {
      const source = Source.llm();
      expect(source).toBeInstanceOf(LlmSource);
    });

    it('should use OpenAI as default provider', async () => {
      const source = Source.llm();
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            type: 'openai',
            modelName: 'gpt-4o-mini',
          }),
        }),
      );
    });

    it('should use environment variable for API key', async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      const source = Source.llm();
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            apiKey: 'test-key',
          }),
        }),
      );
    });

    it('should use default temperature 0.7', async () => {
      const source = Source.llm();
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          temperature: 0.7,
        }),
      );
    });
  });

  describe('Fluent API - Model configuration', () => {
    it('should change model name', async () => {
      const source = Source.llm().model('gpt-4');
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            modelName: 'gpt-4',
          }),
        }),
      );
    });

    it('should set API key explicitly', async () => {
      const source = Source.llm().apiKey('explicit-key');
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            apiKey: 'explicit-key',
          }),
        }),
      );
    });

    it('should chain multiple configurations', async () => {
      const source = Source.llm()
        .model('gpt-4')
        .apiKey('test-key')
        .temperature(0.5)
        .maxTokens(1000);

      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            modelName: 'gpt-4',
            apiKey: 'test-key',
          }),
          temperature: 0.5,
          maxTokens: 1000,
        }),
      );
    });
  });

  describe('Fluent API - Provider configuration', () => {
    it('should configure OpenAI provider', async () => {
      const source = Source.llm().openai({
        modelName: 'gpt-3.5-turbo',
        apiKey: 'openai-key',
        organization: 'org-123',
      });

      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            type: 'openai',
            modelName: 'gpt-3.5-turbo',
            apiKey: 'openai-key',
            organization: 'org-123',
          }),
        }),
      );
    });

    it('should configure Anthropic provider', async () => {
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      const source = Source.llm().anthropic();

      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            type: 'anthropic',
            modelName: 'claude-3-5-haiku-latest',
            apiKey: 'anthropic-key',
          }),
        }),
      );
    });

    it('should configure Anthropic with custom settings', async () => {
      const source = Source.llm().anthropic({
        modelName: 'claude-3-5-haiku-latest',
        apiKey: 'custom-anthropic-key',
        baseURL: 'https://custom.anthropic.com',
      });

      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            type: 'anthropic',
            modelName: 'claude-3-5-haiku-latest',
            apiKey: 'custom-anthropic-key',
            baseURL: 'https://custom.anthropic.com',
          }),
        }),
      );
    });

    it('should configure Google provider', async () => {
      process.env.GOOGLE_API_KEY = 'google-key';
      const source = Source.llm().google();

      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            type: 'google',
            modelName: 'gemini-pro',
            apiKey: 'google-key',
          }),
        }),
      );
    });

    it('should switch between providers', async () => {
      const source = Source.llm()
        .anthropic()
        .openai({ modelName: 'gpt-4' })
        .google({ modelName: 'gemini-pro' });

      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            type: 'google',
            modelName: 'gemini-pro',
          }),
        }),
      );
    });
  });

  describe('Fluent API - Generation parameters', () => {
    it('should set temperature', async () => {
      const source = Source.llm().temperature(0.9);
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          temperature: 0.9,
        }),
      );
    });

    it('should set maxTokens', async () => {
      const source = Source.llm().maxTokens(2000);
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          maxTokens: 2000,
        }),
      );
    });

    it('should set topP and topK', async () => {
      const source = Source.llm().topP(0.9).topK(40);
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          topP: 0.9,
          topK: 40,
        }),
      );
    });
  });

  describe('Fluent API - Tool configuration', () => {
    it('should add tools', async () => {
      const weatherTool = {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object' },
      };

      const source = Source.llm().withTool('weather', weatherTool);
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tools: expect.objectContaining({
            weather: weatherTool,
          }),
        }),
      );
    });

    it('should set tool choice', async () => {
      const source = Source.llm().toolChoice('required');
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          toolChoice: 'required',
        }),
      );
    });

    it('should add multiple tools', async () => {
      const weatherTool = { name: 'weather' };
      const calculatorTool = { name: 'calculator' };

      const source = Source.llm()
        .withTool('weather', weatherTool)
        .withTool('calculator', calculatorTool)
        .toolChoice('auto');

      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tools: expect.objectContaining({
            weather: weatherTool,
            calculator: calculatorTool,
          }),
          toolChoice: 'auto',
        }),
      );
    });

    it('should add tool with withTool method', async () => {
      const weatherTool = {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object' },
      };

      const source = Source.llm().withTool('weather', weatherTool);
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tools: expect.objectContaining({
            weather: weatherTool,
          }),
        }),
      );
    });

    it('should add multiple tools with withTools method', async () => {
      const tools = {
        weather: { name: 'weather', description: 'Get weather' },
        calculator: { name: 'calculator', description: 'Calculate' },
        search: { name: 'search', description: 'Search web' },
      };

      const source = Source.llm().withTools(tools);
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tools: expect.objectContaining(tools),
        }),
      );
    });

    it('should merge tools when using withTools multiple times', async () => {
      const firstTools = {
        weather: { name: 'weather' },
        calculator: { name: 'calculator' },
      };
      const secondTools = {
        search: { name: 'search' },
        translate: { name: 'translate' },
      };

      const source = Source.llm().withTools(firstTools).withTools(secondTools);

      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tools: expect.objectContaining({
            ...firstTools,
            ...secondTools,
          }),
        }),
      );
    });

    it('should override tools with same name when using withTools', async () => {
      const firstTools = {
        weather: { name: 'weather', version: 1 },
        calculator: { name: 'calculator' },
      };
      const secondTools = {
        weather: { name: 'weather', version: 2 }, // Should override
        search: { name: 'search' },
      };

      const source = Source.llm().withTools(firstTools).withTools(secondTools);

      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tools: expect.objectContaining({
            weather: { name: 'weather', version: 2 },
            calculator: { name: 'calculator' },
            search: { name: 'search' },
          }),
        }),
      );
    });

    it('should combine withTool and withTools methods', async () => {
      const tools = {
        weather: { name: 'weather' },
        calculator: { name: 'calculator' },
      };
      const searchTool = { name: 'search', description: 'Search' };

      const source = Source.llm()
        .withTools(tools)
        .withTool('search', searchTool);

      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tools: expect.objectContaining({
            ...tools,
            search: searchTool,
          }),
        }),
      );
    });
  });

  describe('Browser compatibility', () => {
    it('should enable browser compatibility', async () => {
      const source = Source.llm().dangerouslyAllowBrowser();
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          dangerouslyAllowBrowser: true,
          provider: expect.objectContaining({
            dangerouslyAllowBrowser: true,
          }),
        }),
      );
    });

    it('should disable browser compatibility explicitly', async () => {
      const source = Source.llm().dangerouslyAllowBrowser(false);
      await source.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          dangerouslyAllowBrowser: false,
        }),
      );
    });
  });

  describe('Content generation', () => {
    it('should return ModelOutput with content', async () => {
      vi.mocked(generateText).mockResolvedValue({
        type: 'assistant',
        content: 'Generated response',
      });

      const source = Source.llm();
      const result = await source.getContent(Session.create());

      expect(result).toEqual({
        content: 'Generated response',
        toolCalls: undefined,
        metadata: undefined,
      });
    });

    it('should return ModelOutput with tool calls', async () => {
      const mockToolCalls = [
        { name: 'weather', arguments: { location: 'Tokyo' }, id: 'call-1' },
      ];

      vi.mocked(generateText).mockResolvedValue({
        type: 'assistant',
        content: 'I need to check the weather',
        toolCalls: mockToolCalls,
      });

      const source = Source.llm();
      const result = await source.getContent(Session.create());

      expect(result).toEqual({
        content: 'I need to check the weather',
        toolCalls: mockToolCalls,
        metadata: undefined,
      });
    });

    it('should handle non-assistant responses', async () => {
      vi.mocked(generateText).mockResolvedValue({
        type: 'user',
        content: 'This is not an assistant response',
      });

      const source = Source.llm();

      await expect(source.getContent(Session.create())).rejects.toThrow(
        'LLM generation did not return assistant response',
      );
    });
  });

  describe('Validation', () => {
    it('should validate content with custom validator', async () => {
      const validator = new CustomValidator((content) => {
        return content.includes('valid')
          ? { isValid: true }
          : { isValid: false, instruction: 'Must contain "valid"' };
      });

      vi.mocked(generateText).mockResolvedValue({
        type: 'assistant',
        content: 'This is a valid response',
      });

      const source = new LlmSource({}, { validator });
      const result = await source.getContent(Session.create());

      expect(result.content).toBe('This is a valid response');
    });

    it('should retry on validation failure', async () => {
      const validator = new CustomValidator((content) => {
        return content.includes(' valid')
          ? { isValid: true }
          : { isValid: false, instruction: 'Must contain "valid"' };
      });

      vi.mocked(generateText)
        .mockResolvedValueOnce({
          type: 'assistant',
          content: 'Invalid response',
        })
        .mockResolvedValueOnce({
          type: 'assistant',
          content: 'This is a valid response',
        });

      const source = new LlmSource({}, { validator, maxAttempts: 2 });
      const result = await source.getContent(Session.create());

      expect(result.content).toBe('This is a valid response');
      expect(generateText).toHaveBeenCalledTimes(2);
    });

    it('should throw error after max attempts with raiseError=true', async () => {
      const validator = new CustomValidator((content) => ({
        isValid: false,
        instruction: 'Always fails',
      }));

      vi.mocked(generateText).mockResolvedValue({
        type: 'assistant',
        content: 'Any response',
      });

      const source = new LlmSource(
        {},
        {
          validator,
          maxAttempts: 2,
          raiseError: true,
        },
      );

      await expect(source.getContent(Session.create())).rejects.toThrow(
        'Validation failed: Always fails',
      );
    });

    it('should return invalid content with raiseError=false', async () => {
      const validator = new CustomValidator((content) => ({
        isValid: false,
        instruction: 'Always fails',
      }));

      vi.mocked(generateText).mockResolvedValue({
        type: 'assistant',
        content: 'Invalid but returned',
      });

      const source = new LlmSource(
        {},
        {
          validator,
          maxAttempts: 1,
          raiseError: false,
        },
      );

      const result = await source.getContent(Session.create());
      expect(result.content).toBe('Invalid but returned');
    });
  });

  describe('Method chaining immutability', () => {
    it('should not modify original instance', () => {
      const original = Source.llm();
      const modified = original.model('gpt-4').temperature(0.5);

      // Both should be different instances
      expect(modified).not.toBe(original);
    });

    it('should allow independent configuration', async () => {
      const base = Source.llm();
      const _ = base.openai({ modelName: 'gpt-4' });
      const anthropicSource = base.anthropic({
        modelName: 'claude-3-5-haiku-latest',
      });

      // Since it's the same instance, the last configuration wins
      await anthropicSource.getContent(Session.create());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            type: 'anthropic',
            modelName: 'claude-3-5-haiku-latest',
          }),
        }),
      );
    });
  });

  describe('Error handling', () => {
    it('should handle generateText errors', async () => {
      vi.mocked(generateText).mockRejectedValue(new Error('API Error'));

      const source = Source.llm();

      // 実際には元のエラーがそのまま投げられる
      await expect(source.getContent(Session.create())).rejects.toThrow(
        'API Error',
      );
    });

    it('should retry on generateText errors', async () => {
      vi.mocked(generateText)
        .mockRejectedValueOnce(new Error('Network timeout error'))
        .mockResolvedValueOnce({
          type: 'assistant',
          content: 'Success on retry',
        });

      const source = new LlmSource({}, { maxAttempts: 2 });
      const result = await source.getContent(Session.create());

      expect(result.content).toBe('Success on retry');
      expect(generateText).toHaveBeenCalledTimes(2);
    });

    it('should throw "unexpectedly" error only in edge cases', async () => {
      // maxAttempts が 0 の場合など、予期しない状態での動作をテスト
      const source = new LlmSource({}, { maxAttempts: 0, raiseError: true });

      await expect(source.getContent(Session.create())).rejects.toThrow(
        'LLM content generation failed unexpectedly after 0 attempts.',
      );
    });

    it('should return empty content when raiseError is false', async () => {
      vi.mocked(generateText).mockRejectedValue(
        new Error('Non-retryable error'),
      );

      const source = new LlmSource({}, { maxAttempts: 1, raiseError: false });
      const result = await source.getContent(Session.create());

      expect(result.content).toBe('');
    });
  });

  describe('Safe switch / Debug mode', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      // Reset environment and counters before each test
      process.env = { ...originalEnv };
      vi.clearAllMocks();
      Source.resetCallCounters();
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should not enforce call limits when debug mode is disabled', async () => {
      process.env.PROMPTTRAIL_DEBUG = 'false';

      const source = Source.llm().maxCalls(2);
      const session = Session.create();

      // Make 3 calls (more than the limit)
      await source.getContent(session);
      await source.getContent(session);
      await source.getContent(session);

      // All calls should succeed
      expect(generateText).toHaveBeenCalledTimes(3);
    });

    it('should enforce call limits when debug mode is enabled', async () => {
      process.env.PROMPTTRAIL_DEBUG = 'true';
      process.env.PROMPTTRAIL_MAX_LLM_CALLS = '2';

      const source = Source.llm();
      const session = Session.create();

      // First two calls should succeed
      await source.getContent(session);
      await source.getContent(session);

      // Third call should throw
      await expect(source.getContent(session)).rejects.toThrow(
        /LlmSource call limit exceeded: 2 calls made, limit is 2/,
      );
    });

    it('should use custom maxCallLimit from options', async () => {
      process.env.PROMPTTRAIL_DEBUG = 'true';

      const source = Source.llm().maxCalls(3);
      const session = Session.create();

      // First three calls should succeed
      await source.getContent(session);
      await source.getContent(session);
      await source.getContent(session);

      // Fourth call should throw
      await expect(source.getContent(session)).rejects.toThrow(
        /LlmSource call limit exceeded: 3 calls made, limit is 3/,
      );
    });

    it('should track calls per instance', async () => {
      process.env.PROMPTTRAIL_DEBUG = 'true';

      const source1 = Source.llm().maxCalls(2);
      const source2 = Source.llm().maxCalls(2);
      const session = Session.create();

      // Each source should have its own counter
      await source1.getContent(session);
      await source1.getContent(session);
      await source2.getContent(session);
      await source2.getContent(session);

      // Third call on each should throw
      await expect(source1.getContent(session)).rejects.toThrow(
        /call limit exceeded/,
      );
      await expect(source2.getContent(session)).rejects.toThrow(
        /call limit exceeded/,
      );
    });

    it('should share counters between cloned instances', async () => {
      process.env.PROMPTTRAIL_DEBUG = 'true';

      const original = Source.llm().maxCalls(2);
      const cloned = original.temperature(0.5);
      const session = Session.create();

      // Calls on both instances should count together
      await original.getContent(session);
      await cloned.getContent(session);

      // Third call on either should throw
      await expect(original.getContent(session)).rejects.toThrow(
        /call limit exceeded/,
      );
    });

    it('should reset counters with resetCallCounters', async () => {
      process.env.PROMPTTRAIL_DEBUG = 'true';

      const source = Source.llm().maxCalls(1);
      const session = Session.create();

      await source.getContent(session);
      await expect(source.getContent(session)).rejects.toThrow(
        /call limit exceeded/,
      );

      // Reset counters
      Source.resetCallCounters();

      // Should be able to call again
      await source.getContent(session);
    });

    it('should provide access to call count', async () => {
      process.env.PROMPTTRAIL_DEBUG = 'true';

      const source = Source.llm();
      const instanceId = source.getInstanceId();
      const session = Session.create();

      expect(Source.getCallCount(instanceId)).toBe(0);

      await source.getContent(session);
      expect(Source.getCallCount(instanceId)).toBe(1);

      await source.getContent(session);
      expect(Source.getCallCount(instanceId)).toBe(2);
    });

    it('should use default limit of 100 when not specified', async () => {
      process.env.PROMPTTRAIL_DEBUG = 'true';
      delete process.env.PROMPTTRAIL_MAX_LLM_CALLS;

      const source = Source.llm();
      const session = Session.create();

      // Make 99 calls
      for (let i = 0; i < 99; i++) {
        await source.getContent(session);
      }

      // 100th call should succeed
      await source.getContent(session);

      // 101st call should throw
      await expect(source.getContent(session)).rejects.toThrow(
        /LlmSource call limit exceeded: 100 calls made, limit is 100/,
      );
    });

    it('should include helpful error message', async () => {
      process.env.PROMPTTRAIL_DEBUG = 'true';

      const source = Source.llm().maxCalls(1);
      const session = Session.create();

      await source.getContent(session);

      try {
        await source.getContent(session);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).toContain(
          'This safety check prevents infinite loops',
        );
        expect(error.message).toContain('Set PROMPTTRAIL_DEBUG=false');
        expect(error.message).toContain('PROMPTTRAIL_MAX_LLM_CALLS');
      }
    });
  });
});
