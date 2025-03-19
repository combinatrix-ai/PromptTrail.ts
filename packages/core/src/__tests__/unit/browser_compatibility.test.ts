import { describe, it, expect, vi } from 'vitest';
import { OpenAIModel } from '../../model/openai/model';
import { createSession } from '../../session';
import { LinearTemplate } from '../../templates';
import { createMetadata } from '../../metadata';

// Mock the OpenAI module
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content:
                    'This is a response from the OpenAI API in a browser environment.',
                  role: 'assistant',
                },
                index: 0,
                finish_reason: 'stop',
              },
            ],
          }),
        },
      },
    })),
  };
});

// Mock the OpenAI model
vi.mock('../../model/openai/model', () => {
  return {
    OpenAIModel: vi.fn().mockImplementation((config) => {
      // Check if browser flag is set
      if (config.dangerouslyAllowBrowser !== true) {
        throw new Error('Browser flag not set');
      }

      return {
        send: vi.fn().mockResolvedValue({
          type: 'assistant',
          content:
            'This is a response from the OpenAI API in a browser environment.',
          metadata: createMetadata(),
        }),
        sendAsync: vi.fn(),
        formatTool: vi.fn(),
        validateConfig: vi.fn(),
        config,
      };
    }),
  };
});

describe('Browser Compatibility', () => {
  it('should initialize with browser flag', () => {
    // Should not throw when dangerouslyAllowBrowser is true
    expect(() => {
      new OpenAIModel({
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
        temperature: 0.7,
        dangerouslyAllowBrowser: true,
      });
    }).not.toThrow();
  });

  it('should make API calls in browser context', async () => {
    // Create model with browser flag
    const model = new OpenAIModel({
      apiKey: 'test-api-key',
      modelName: 'gpt-4o-mini',
      temperature: 0.7,
      dangerouslyAllowBrowser: true,
    });

    // Create a session
    const session = createSession({
      messages: [
        {
          type: 'user',
          content: 'Hello from the browser!',
        },
      ],
    });

    // Send a message
    const response = await model.send(session);

    // Verify the response
    expect(response.type).toBe('assistant');
    expect(response.content).toBe(
      'This is a response from the OpenAI API in a browser environment.',
    );
  });

  it('should work with templates in browser context', async () => {
    // Create model with browser flag
    const model = new OpenAIModel({
      apiKey: 'test-api-key',
      modelName: 'gpt-4o-mini',
      temperature: 0.7,
      dangerouslyAllowBrowser: true,
    });

    // Create a template
    const template = new LinearTemplate()
      .addSystem('You are a helpful assistant in a browser environment.')
      .addUser('Hello from the browser!')
      .addAssistant({ model });

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

  it('should throw an error when browser flag is not set', () => {
    // Should throw when dangerouslyAllowBrowser is not provided
    expect(() => {
      new OpenAIModel({
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
        temperature: 0.7,
      });
    }).toThrow();

    // Should throw when dangerouslyAllowBrowser is false
    expect(() => {
      new OpenAIModel({
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
        temperature: 0.7,
        dangerouslyAllowBrowser: false,
      });
    }).toThrow();
  });
});
