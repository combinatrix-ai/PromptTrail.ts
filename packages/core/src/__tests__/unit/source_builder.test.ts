import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Source } from '../../content_source';
import { generateText } from '../../generate';
import { createSession } from '../../session';
import { Assistant } from '../../templates/primitives/assistant';
import { User } from '../../templates/primitives/user';
import { CustomValidator } from '../../validators/custom';

vi.mock('../../generate', () => ({
  generateText: vi.fn(),
}));

vi.mock('node:readline/promises', () => {
  return {
    createInterface: vi.fn(() => ({
      question: vi.fn().mockResolvedValue('cli input'),
      close: vi.fn(),
    })),
  };
});

describe('Source builders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'hello',
    });
  });

  it('uses default OpenAI configuration when none provided', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    const assistant = new Assistant(Source.llm());

    await assistant.execute(createSession());

    expect(generateText).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: expect.objectContaining({
          type: 'openai',
          apiKey: 'env-key',
          modelName: 'gpt-4o-mini',
        }),
      }),
    );
  });

  it('configures LlmSource via chaining', async () => {
    const assistant = new Assistant(
      Source.llm()
        .openai({ apiKey: 'key', modelName: 'gpt-4' })
        .temperature(0.5),
    );

    await assistant.execute(createSession());

    expect(generateText).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        temperature: 0.5,
        provider: expect.objectContaining({
          type: 'openai',
          modelName: 'gpt-4',
        }),
      }),
    );
  });

  it('configures LlmSource with Google provider', async () => {
    const assistant = new Assistant(
      Source.google({ apiKey: 'g-key', modelName: 'gemini-pro' })
        .temperature(0.2),
    );

    await assistant.execute(createSession());

    expect(generateText).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        temperature: 0.2,
        provider: expect.objectContaining({
          type: 'google',
          modelName: 'gemini-pro',
        }),
      }),
    );
  });

  it('builds CLISource via builder', async () => {
    const validator = new CustomValidator((c) => ({ isValid: true }));
    const user = new User(
      Source.cli()
        .prompt('Your input: ')
        .defaultValue('def')
        .validate(validator)
        .build(),
    );

    const session = await user.execute(createSession());

    expect(session.getLastMessage()?.content).toBe('cli input');
  });
});
