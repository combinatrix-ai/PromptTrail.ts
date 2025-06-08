import { describe, expect, it } from 'vitest';
import { Agent } from '../../templates';
import { Session } from '../../session';
import { Source } from '../../source';

describe('Source.llm().mock() examples', () => {
  it('should demonstrate basic mock usage', async () => {
    // Create a mock source that returns a fixed response
    const mockSource = Source.llm().mock().mockResponse({
      content: 'Hello from mock!',
    });

    // Use it in an Agent
    const agent = Agent.create()
      .system('You are a helpful assistant')
      .assistant(mockSource);

    const session = await agent.execute();
    const lastMessage = session.messages[session.messages.length - 1];

    expect(lastMessage.content).toBe('Hello from mock!');
  });

  it('should demonstrate mock with fluent API configuration', async () => {
    // Mock maintains the same fluent API as Source.llm()
    const mockSource = Source.llm()
      .openai({ modelName: 'gpt-4' })
      .temperature(0.8)
      .maxTokens(500)
      .mock()
      .mockResponse({ content: 'Configured mock response' });

    // The configuration is available for assertions
    const lastCall = mockSource.getCallHistory()[0];

    const agent = Agent.create().assistant(mockSource);
    const session = await agent.execute();

    // After execution, we can check what configuration was used
    const history = mockSource.getCallHistory();
    expect(history[0].options.provider.modelName).toBe('gpt-4');
    expect(history[0].options.temperature).toBe(0.8);
    expect(history[0].options.maxTokens).toBe(500);
  });

  it('should demonstrate cycling through multiple responses', async () => {
    const mockSource = Source.llm()
      .mock()
      .mockResponses(
        { content: 'First response' },
        { content: 'Second response' },
        { content: 'Third response' },
      );

    const agent = Agent.create()
      .assistant(mockSource)
      .assistant(mockSource)
      .assistant(mockSource)
      .assistant(mockSource); // This will cycle back to first

    const session = await agent.execute();

    expect(session.messages[0].content).toBe('First response');
    expect(session.messages[1].content).toBe('Second response');
    expect(session.messages[2].content).toBe('Third response');
    expect(session.messages[3].content).toBe('First response');
  });

  it('should demonstrate dynamic responses with callback', async () => {
    const mockSource = Source.llm()
      .model('claude-3')
      .mock()
      .mockCallback(async (session, options) => {
        // Access session variables
        const userName = session.vars.userName || 'User';

        // Access LLM options
        const model = options.provider.modelName;

        return {
          content: `Hello ${userName}, I'm using ${model}`,
        };
      });

    const agent = Agent.create().assistant(mockSource);

    const session = await agent.execute(
      Session.withContext({ userName: 'Alice' }),
    );

    expect(session.messages[0].content).toBe("Hello Alice, I'm using claude-3");
  });

  it('should demonstrate mocking tool calls', async () => {
    const mockSource = Source.llm()
      .mock()
      .mockResponse({
        content: 'Let me check the weather for you.',
        toolCalls: [
          {
            name: 'getWeather',
            arguments: { city: 'Tokyo' },
            id: 'call_123',
          },
        ],
        toolResults: [
          {
            toolCallId: 'call_123',
            result: { temperature: 25, condition: 'sunny' },
          },
        ],
      });

    const agent = Agent.create().assistant(mockSource);
    const session = await agent.execute();

    const lastMessage = session.messages[0];
    expect(lastMessage.content).toBe('Let me check the weather for you.');
    expect(lastMessage.toolCalls).toHaveLength(1);
    expect(lastMessage.toolCalls![0].name).toBe('getWeather');
  });

  it('should demonstrate testing with validation', async () => {
    const mockSource = Source.llm()
      .validate(Validation.length({ min: 10, max: 100 }))
      .mock()
      .mockResponse({ content: 'Valid response text' });

    const agent = Agent.create().assistant(mockSource);
    const session = await agent.execute();

    // The response passes validation
    expect(session.messages[0].content).toBe('Valid response text');

    // Test with invalid response
    const invalidMock = Source.llm()
      .validate(Validation.length({ min: 20 }))
      .withRaiseError(true)
      .mock()
      .mockResponse({ content: 'Too short' });

    const invalidAgent = Agent.create().assistant(invalidMock);

    // This should throw because content is too short
    await expect(invalidAgent.execute()).rejects.toThrow();
  });
});

// Import Validation for the example
import { Validation } from '../../validators';
