import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmSource, Source } from '../../../content_source';
import { generateText } from '../../../generate';
import { createSession } from '../../../session';
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
      await source.getContent(createSession());

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
      await source.getContent(createSession());

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
      await source.getContent(createSession());

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
      await source.getContent(createSession());

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
      await source.getContent(createSession());

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

      await source.getContent(createSession());

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

      await source.getContent(createSession());

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

      await source.getContent(createSession());

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

      await source.getContent(createSession());

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

      await source.getContent(createSession());

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

      await source.getContent(createSession());

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
      await source.getContent(createSession());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          temperature: 0.9,
        }),
      );
    });

    it('should set maxTokens', async () => {
      const source = Source.llm().maxTokens(2000);
      await source.getContent(createSession());

      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          maxTokens: 2000,
        }),
      );
    });

    it('should set topP and topK', async () => {
      const source = Source.llm().topP(0.9).topK(40);
      await source.getContent(createSession());

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

      const source = Source.llm().addTool('weather', weatherTool);
      await source.getContent(createSession());

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
      await source.getContent(createSession());

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
        .addTool('weather', weatherTool)
        .addTool('calculator', calculatorTool)
        .toolChoice('auto');

      await source.getContent(createSession());

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
  });

  describe('Browser compatibility', () => {
    it('should enable browser compatibility', async () => {
      const source = Source.llm().dangerouslyAllowBrowser();
      await source.getContent(createSession());

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
      await source.getContent(createSession());

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
      const result = await source.getContent(createSession());

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
      const result = await source.getContent(createSession());

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

      await expect(source.getContent(createSession())).rejects.toThrow(
        'LLM generation failed after 1 attempts: Did not return assistant response.',
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
      const result = await source.getContent(createSession());

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
      const result = await source.getContent(createSession());

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

      await expect(source.getContent(createSession())).rejects.toThrow(
        'Validation failed after 2 attempts: Always fails',
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

      const result = await source.getContent(createSession());
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
      await anthropicSource.getContent(createSession());

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
      await expect(source.getContent(createSession())).rejects.toThrow(
        'API Error',
      );
    });

    it('should retry on generateText errors', async () => {
      vi.mocked(generateText)
        .mockRejectedValueOnce(new Error('API Error'))
        .mockResolvedValueOnce({
          type: 'assistant',
          content: 'Success on retry',
        });

      const source = new LlmSource({}, { maxAttempts: 2 });
      const result = await source.getContent(createSession());

      expect(result.content).toBe('Success on retry');
      expect(generateText).toHaveBeenCalledTimes(2);
    });

    it('should throw "unexpectedly" error only in edge cases', async () => {
      // maxAttempts が 0 の場合など、予期しない状態での動作をテスト
      const source = new LlmSource({}, { maxAttempts: 0, raiseError: true });

      await expect(source.getContent(createSession())).rejects.toThrow(
        'LLM content generation failed unexpectedly after 0 attempts.',
      );
    });

    it('should return empty content when raiseError is false', async () => {
      vi.mocked(generateText).mockRejectedValue(new Error('API Error'));

      const source = new LlmSource({}, { maxAttempts: 1, raiseError: false });
      const result = await source.getContent(createSession());

      expect(result.content).toBe('');
    });
  });
});
