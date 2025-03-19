import { describe, it, expect, vi } from 'vitest';
import { LinearTemplate, OpenAIModel, createSession } from '../../../src';

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

describe('Simple Example', () => {
  it('should create and execute a simple conversation template', async () => {
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

    expect(messages[0].content).toBe("I'm a helpful assistant.");
    expect(messages[1].content).toBe("What's TypeScript?");
    expect(messages[2].content).toBe(
      'This is a mock response from the OpenAI model.',
    );
  });

  it('should handle basic metadata in the session', async () => {
    // Create a mock OpenAI model
    const model = new OpenAIModel({
      apiKey: 'mock-api-key',
      modelName: 'gpt-4o-mini',
      temperature: 0.7,
    });

    // Create a session with simple metadata
    const session = createSession();
    session.metadata.set('username', 'Alice');
    session.metadata.set('topic', 'TypeScript');

    // Create a template with interpolation
    const chat = new LinearTemplate()
      .addSystem('Hello, ${username}!')
      .addUser('Tell me about ${topic}.')
      .addAssistant({ model });

    // Execute the template
    const result = await chat.execute(session);

    // Verify the conversation flow with interpolated values
    const messages = Array.from(result.messages);

    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('Hello, Alice!');
    expect(messages[1].content).toBe('Tell me about TypeScript.');
  });

  it('should handle print mode', async () => {
    // Create a mock OpenAI model
    const model = new OpenAIModel({
      apiKey: 'mock-api-key',
      modelName: 'gpt-4o-mini',
      temperature: 0.7,
    });

    // Spy on console.log
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Create a template
    const chat = new LinearTemplate()
      .addSystem("I'm a helpful assistant.")
      .addUser("What's TypeScript?")
      .addAssistant({ model });

    // Execute the template with print mode enabled
    // Session variable is intentionally unused (prefixed with underscore)
    // We only care about the side effect of console.log being called
    const _session = await chat.execute(createSession({ print: true }));

    // Verify console.log was called for each message
    expect(consoleSpy).toHaveBeenCalledTimes(3);

    // Restore console.log
    consoleSpy.mockRestore();
  });
});
