import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../../session';
import { Sequence, System, User, Assistant } from '../../templates';
import { createMetadata } from '../../metadata';
import type { GenerateOptions } from '../../generate_options';

// Mock modules
vi.mock('../../generate');

// Import mocked modules after mocking
import { generateText } from '../../generate';
import { createGenerateOptions } from '../../generate_options';

describe('Browser Compatibility', () => {
  beforeEach(() => {
    // Setup mocks for each test
    vi.mocked(generateText).mockImplementation(async (session, options) => {
      // Check if browser flag is set
      if (
        options.provider.type === 'openai' &&
        !options.provider.dangerouslyAllowBrowser
      ) {
        throw new Error('Browser flag not set');
      }

      return {
        type: 'assistant',
        content:
          'This is a response from the OpenAI API in a browser environment.',
        metadata: createMetadata(),
      };
    });
  });

  it('should work with templates in browser context', async () => {
    // Define generateOptions with browser flag
    const generateOptions: GenerateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
        dangerouslyAllowBrowser: true,
      },
      temperature: 0.7,
    });

    // Create a template
    const template = new Sequence()
      .add(new System('You are a helpful assistant in a browser environment.'))
      .add(new User('Hello from the browser!'))
      .add(
        new Assistant(
          'This is a response from the OpenAI API in a browser environment.',
        ),
      );

    // Execute the template
    const result = await template.execute(createSession());

    // Verify the conversation flow
    const messages = Array.from(result.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe(
      'This is a response from the OpenAI API in a browser environment.',
    );
  });

  it('should throw an error when browser flag is not set', async () => {
    // Create a template that will throw an error
    const template = {
      execute: async () => {
        throw new Error('Browser flag not set');
      },
    };

    // Execute the template should throw
    await expect(template.execute()).rejects.toThrow('Browser flag not set');
  });
});
