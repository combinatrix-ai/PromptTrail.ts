import { describe, it, expect, vi } from 'vitest';
import { OpenAIModel } from '../../../model/openai/model';
import { createSession } from '../../../session';

// Mock the OpenAI API client
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async (params) => {
            // Return the temperature that was passed to the API
            return {
              choices: [
                {
                  message: {
                    content: `Response with temperature: ${params.temperature}`,
                    role: 'assistant',
                  },
                  index: 0,
                  finish_reason: 'stop',
                },
              ],
            };
          }),
        },
      },
    })),
  };
});

describe('Model Temperature Settings', () => {
  it('should use the configured temperature', async () => {
    // Create a model with a specific temperature
    const model = new OpenAIModel({
      apiKey: 'test-api-key',
      modelName: 'gpt-4o-mini',
      temperature: 0.7,
    });

    // Create a session
    const session = createSession({
      messages: [
        {
          type: 'user',
          content: 'Hello!',
        },
      ],
    });

    // Send a message
    const response = await model.send(session);

    // Verify the response contains the temperature
    expect(response.content).toBe('Response with temperature: 0.7');
  });

  it('should use different temperature values', async () => {
    // Test with different temperature values
    const temperatures = [0, 0.3, 0.5, 0.8, 1.0];

    for (const temp of temperatures) {
      // Create a model with the specific temperature
      const model = new OpenAIModel({
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
        temperature: temp,
      });

      // Create a session
      const session = createSession({
        messages: [
          {
            type: 'user',
            content: 'Hello!',
          },
        ],
      });

      // Send a message
      const response = await model.send(session);

      // Verify the response contains the temperature
      expect(response.content).toBe(`Response with temperature: ${temp}`);
    }
  });

  it('should handle different temperature values', () => {
    // Test with boundary values
    const validTemperatures = [0, 0.3, 0.5, 0.8, 1.0];

    for (const temp of validTemperatures) {
      // Should not throw for valid temperatures
      expect(() => {
        new OpenAIModel({
          apiKey: 'test-api-key',
          modelName: 'gpt-4o-mini',
          temperature: temp,
        });
      }).not.toThrow();
    }

    // Note: The OpenAI API actually accepts temperatures outside the 0-1 range,
    // so we're not testing for validation errors here. Instead, we're just
    // verifying that valid temperatures work correctly.
  });

  // Note: If the OpenAIModel class is updated to support overriding temperature
  // in the send method, a test could be added here to verify that functionality.
});
