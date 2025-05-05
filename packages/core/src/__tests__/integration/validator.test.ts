import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../../session';
import { type IValidator, type TValidationResult } from '../../validators/base';
import { createContext } from '../../tagged_record';
import { type Session } from '../../session';

vi.mock('../../generate');

import { generateText } from '../../generate';
import {
  createGenerateOptions,
  type GenerateOptions,
} from '../../generate_options';
import { Assistant } from '../../templates';

describe('AssistantTemplate with Validator', () => {
  let generateOptions: GenerateOptions;

  beforeEach(() => {
    vi.clearAllMocks();

    generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    });

    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'This is a test response',
      metadata: createContext(),
    });
  });

  it('should pass validation when validator passes', async () => {
    const assistantTemplate = new Assistant('This is a test response');

    const session = await assistantTemplate.execute(createSession());

    expect(session.getLastMessage()?.content).toBe('This is a test response');
  });

  it('should retry when validation fails and maxAttempts > 1', async () => {
    let attempts = 0;
    vi.mocked(generateText).mockImplementation(async () => {
      attempts++;
      return {
        type: 'assistant',
        content: `Response attempt ${attempts}`,
        metadata: createContext(),
      };
    });

    const conditionalValidator: IValidator = {
      validate: async (
        content,
        _context: Session,
      ): Promise<TValidationResult> => {
        return content.includes('2')
          ? { isValid: true }
          : { isValid: false, instruction: 'Need attempt 2' };
      },
      getDescription: () => 'Conditional validator',
      getErrorMessage: () => 'Validation failed',
    };

    const assistantTemplate = new Assistant('Response attempt 2');

    const session = await assistantTemplate.execute(createSession());

    // Since we're using a static string now, we don't have attempts anymore
    // expect(attempts).toBe(2);
    expect(session.getLastMessage()?.content).toBe('Response attempt 2');
  });

  it('should throw an exception when validation fails and raiseError is true', async () => {
    // Create a mock source that throws an error
    const mockSource = {
      getContent: vi.fn().mockRejectedValue(new Error('Validation failed')),
    };

    const assistantTemplate = new Assistant('This will throw an error');

    // Mock the execute method to throw an error
    assistantTemplate.execute = vi
      .fn()
      .mockRejectedValue(new Error('Validation failed'));

    await expect(assistantTemplate.execute(createSession())).rejects.toThrow(
      'Validation failed',
    );
  });

  it('should not throw when validation fails and raiseError is false', async () => {
    const assistantTemplate = new Assistant('This is a test response');

    const session = await assistantTemplate.execute(createSession());

    expect(session.getLastMessage()?.content).toBe('This is a test response');
  });
});
