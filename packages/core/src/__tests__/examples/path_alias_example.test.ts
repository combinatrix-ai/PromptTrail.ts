import { describe, it, expect, vi } from 'vitest';
import { LinearTemplate, OpenAIModel, createSession } from '../../../src';
import { createMessage } from '../utils';

// Mock OpenAI model
vi.mock('../../../src/model/openai/model', () => {
  return {
    OpenAIModel: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({
        type: 'assistant',
        content: 'This is a mock response from the OpenAI model.',
        metadata: undefined,
      }),
      sendAsync: vi.fn(),
      formatTool: vi.fn(),
      validateConfig: vi.fn(),
      config: {
        modelName: 'gpt-4o-mini',
        temperature: 0.7,
      },
    })),
  };
});

/**
 * This test demonstrates how to use path aliases in tests.
 * The tsconfig.json in the __tests__ directory defines path aliases:
 *
 * "paths": {
 *   "@core/*": ["../*"],
 *   "@tests/*": ["./*"]
 * }
 *
 * This allows importing from core using @core/ and from tests using @tests/
 */
describe('Path Alias Example', () => {
  it('should work with path aliases for imports', async () => {
    // Create a mock OpenAI model
    const model = new OpenAIModel({
      apiKey: 'mock-api-key',
      modelName: 'gpt-4o-mini',
      temperature: 0.7,
    });

    // Create a simple conversation template
    const chat = new LinearTemplate()
      .addSystem("I'm a helpful assistant.")
      .addUser("What's TypeScript?")
      .addAssistant({ model });

    // Execute the template
    const session = await chat.execute(createSession());

    // Verify the conversation flow
    const messages = Array.from(session.messages);

    // Check message types and content
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
  });

  it('should demonstrate how path aliases can be used for test utilities', async () => {
    // Create a session with a message using the test utility
    const session = createSession({
      messages: [
        createMessage('system', 'System message created with test utility'),
        createMessage('user', 'User message created with test utility'),
      ],
    });

    // Verify the messages were created correctly
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].type).toBe('system');
    expect(session.messages[0].content).toBe(
      'System message created with test utility',
    );
    expect(session.messages[1].type).toBe('user');
    expect(session.messages[1].content).toBe(
      'User message created with test utility',
    );
  });

  it('should demonstrate how path aliases can simplify imports', async () => {
    // In a real test, you would import from @core/ and @tests/ instead of relative paths
    // For example:
    // import { LinearTemplate } from '@core/templates';
    // import { createMessage } from '@tests/utils';

    // This test is just a placeholder to demonstrate the concept
    expect(true).toBe(true);
  });
});
