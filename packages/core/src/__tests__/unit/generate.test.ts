import { describe, expect, it } from 'vitest';
import { createProvider } from '../../generate';

describe('createProvider', () => {
  it('should use OpenAI Responses API when requested', () => {
    const provider = createProvider({
      provider: {
        type: 'openai',
        apiKey: 'test-key',
        modelName: 'gpt-5.4-nano',
        api: 'responses',
      },
    }) as any;

    expect(provider.modelId).toBe('gpt-5.4-nano');
    expect(provider.config.provider).toBe('openai.responses');
  });

  it('should keep OpenAI chat compatibility when requested', () => {
    const provider = createProvider({
      provider: {
        type: 'openai',
        apiKey: 'test-key',
        modelName: 'gpt-5.4-nano',
        api: 'chat',
      },
    }) as any;

    expect(provider.modelId).toBe('gpt-5.4-nano');
    expect(provider.config.provider).toBe('openai.chat');
  });
});
