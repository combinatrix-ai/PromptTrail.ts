import { describe, expect, it } from 'vitest';
import { convertSessionToAiSdkMessages, createProvider } from '../../generate';
import { Session } from '../../session';

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

describe('convertSessionToAiSdkMessages', () => {
  it('should inject runtime skill instructions as system messages for ai-sdk path', () => {
    const messages = convertSessionToAiSdkMessages(
      Session.create({
        messages: [{ type: 'user', content: 'Use the skill.' }],
      }),
      {
        capabilities: [
          {
            kind: 'skill',
            name: 'docs',
            instructions: 'Prefer local docs.',
          },
        ],
      },
    );

    expect(messages[0]).toEqual({
      role: 'system',
      content: 'Available runtime skills:\n\nSkill: docs\nPrefer local docs.',
    });
    expect(messages[1]).toEqual({ role: 'user', content: 'Use the skill.' });
  });
});
