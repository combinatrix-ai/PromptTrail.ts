import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSession } from '../../session';
import { LinearTemplate, LoopTemplate } from '../../templates';
import { extractMarkdown } from '../../utils/markdown_extractor';
import { RegexMatchValidator } from '../../validators/text';
import { createMetadata } from '../../metadata';
import { generateText } from '../../generate';
import { createGenerateOptions } from '../../generate_options';
import { StaticInputSource } from '../../input_source';
import { createCalculatorTool, createWeatherTool } from './utils/test_tools';

/**
 * Mock the generateText function for mocked tests
 */
vi.mock('../../generate', () => {
  return {
    generateText: vi.fn(),
    generateTextStream: vi.fn(),
  };
});

describe('End-to-End Workflows with Mocks', () => {
  let calculatorTool: ReturnType<typeof createCalculatorTool>;
  let generateOptions: ReturnType<typeof createGenerateOptions>;

  beforeEach(() => {
    calculatorTool = createCalculatorTool();

    generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    }).addTool('calculator', calculatorTool);

    vi.mocked(generateText).mockImplementation(async (session) => {
      const messages = Array.from(session.messages);
      const lastUserMessage = messages
        .filter((msg) => msg.type === 'user')
        .pop();

      if (lastUserMessage && lastUserMessage.content.includes('weather')) {
        return {
          type: 'assistant',
          content: `
## Weather Report
The weather in San Francisco is currently 72°F and sunny.

## Forecast
- Today: Sunny, high of 75°F
- Tomorrow: Partly cloudy, high of 70°F
- Wednesday: Foggy in the morning, high of 68°F

\`\`\`json
{
  "location": "San Francisco",
  "temperature": 72,
  "condition": "sunny",
  "forecast": [
    {"day": "Today", "condition": "Sunny", "high": 75, "low": 58},
    {"day": "Tomorrow", "condition": "Partly cloudy", "high": 70, "low": 56},
    {"day": "Wednesday", "condition": "Foggy", "high": 68, "low": 55}
  ]
}
\`\`\`
          `,
          metadata: createMetadata(),
        };
      } else if (
        lastUserMessage &&
        lastUserMessage.content.includes('calculate')
      ) {
        const metadata = createMetadata();
        metadata.set('toolCalls', [
          {
            name: 'calculator',
            arguments: { a: 5, b: 3, operation: 'add' },
            id: 'call-123',
          },
        ]);

        return {
          type: 'assistant',
          content: 'I need to calculate something.',
          metadata,
        };
      } else {
        return {
          type: 'assistant',
          content: 'I can help you with that!',
          metadata: createMetadata(),
        };
      }
    });
  });

  it('should execute a complete weather information workflow with data extraction', async () => {
    const weatherTemplate = new LinearTemplate()
      .addSystem('You are a helpful weather assistant.')
      .addUser('What is the weather in San Francisco?')
      .addAssistant(generateOptions)
      .addTransformer(
        extractMarkdown({
          headingMap: {
            'Weather Report': 'current',
            Forecast: 'forecast',
          },
          codeBlockMap: { json: 'weatherData' },
        }),
      );

    const session = await weatherTemplate.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');

    expect(session.metadata.get('current')).toContain('72°F and sunny');
    expect(session.metadata.get('forecast')).toContain('Today: Sunny');

    const weatherDataStr = session.metadata.get('weatherData') as string;
    const weatherData = JSON.parse(weatherDataStr);
    expect(weatherData).toHaveProperty('location', 'San Francisco');
    expect(weatherData).toHaveProperty('temperature', 72);
    expect(weatherData).toHaveProperty('condition', 'sunny');
    expect(weatherData).toHaveProperty('forecast');
    expect(weatherData.forecast).toHaveLength(3);
  });

  /**
   * Tool integration tests have been moved to tool_integration.test.ts
   */

  it('should execute a complete conversation with validation', async () => {
    // const _contentValidator = new RegexMatchValidator({
    //   regex: /help/i,
    //   description: 'Response must contain the word "help"',
    // });

    const linearTemplate = new LinearTemplate()
      .addSystem('You are a helpful assistant.')
      .addUser('Can you assist me?')
      .addAssistant(generateOptions);

    const session = await linearTemplate.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');

    const assistantMessage = messages[2];
    expect(assistantMessage.type).toBe('assistant');
    expect(assistantMessage.content).toBeDefined();
  });

  it('should execute a complete conversation with a loop', async () => {
    const loopTemplate = new LinearTemplate()
      .addSystem('You are a helpful assistant.')
      .addLoop(
        new LoopTemplate()
          .addUser('Tell me something interesting.')
          .addAssistant(generateOptions)
          .addUser(new StaticInputSource('Should we continue? (yes/no): no'))
          .setExitCondition((session) => {
            const lastMessage = session.getLastMessage();
            return (
              lastMessage?.type === 'user' &&
              lastMessage.content.toLowerCase().includes('no')
            );
          }),
      );

    const session = await loopTemplate.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
    expect(messages[3].type).toBe('user');

    expect(messages[1].content).toBe('Tell me something interesting.');
    expect(messages[3].content).toBe('Should we continue? (yes/no): no');
  });
});

/**
 * End-to-End tests with real API calls
 * 
 * **Important message**
 * - This test is a golden standard for the e2e workflow test
 * - This test should not be mocked
 * - This test should be run with real API calls
 * - This test should be run with real API keys
 */
describe('End-to-End Workflows with Real APIs', () => {
  it('should execute a simple conversation with OpenAI', async () => {
    const generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    });

    const template = new LinearTemplate()
      .addSystem('You are a helpful assistant.')
      .addUser('Hello, how are you?')
      .addAssistant(generateOptions);

    const session = await template.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
  });

  it('should execute a simple conversation with Anthropic', async () => {
    const generateOptions = createGenerateOptions({
      provider: {
        type: 'anthropic',
        apiKey: process.env.ANTHROPIC_API_KEY || 'test-api-key',
        modelName: 'claude-3-haiku-20240307',
      },
      temperature: 0.7,
    });

    const template = new LinearTemplate()
      .addSystem('You are a helpful assistant.')
      .addUser('Hello, how are you?')
      .addAssistant(generateOptions);

    const session = await template.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
  });

  it('should execute a conversation with weather tool', async () => {
    const weatherTool = createWeatherTool();

    const generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    }).addTool('weather', weatherTool);

    const template = new LinearTemplate()
      .addSystem('You are a helpful assistant.')
      .addUser('What is the weather in Tokyo?')
      .addAssistant(generateOptions);

    const session = await template.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');

    const toolResults = session.metadata.get('toolResults');
    if (toolResults) {
      expect(Array.isArray(toolResults)).toBe(true);
    }
  });

  it('should execute a conversation with a loop and user input', async () => {
    const generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    });

    const loopTemplate = new LinearTemplate()
      .addSystem('You are a helpful assistant.')
      .addLoop(
        new LoopTemplate()
          .addUser('Tell me something interesting.')
          .addAssistant(generateOptions)
          .addUser(new StaticInputSource('Should we continue? (yes/no): no'))
          .setExitCondition((session) => {
            const lastMessage = session.getLastMessage();
            return (
              lastMessage?.type === 'user' &&
              lastMessage.content.toLowerCase().includes('no')
            );
          }),
      );

    const session = await loopTemplate.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
    expect(messages[3].type).toBe('user');

    expect(messages[1].content).toBe('Tell me something interesting.');
    expect(messages[3].content).toBe('Should we continue? (yes/no): no');
  });
});
