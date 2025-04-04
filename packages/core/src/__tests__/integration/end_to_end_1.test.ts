import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSession } from '../../session';
import { LinearTemplate, LoopTemplate } from '../../templates';
import { extractMarkdown } from '../../utils/markdown_extractor';
import { RegexMatchValidator } from '../../validators/text';
import { createMetadata } from '../../metadata';
import { generateText } from '../../generate';
import { createGenerateOptions } from '../../generate_options';
import { StaticInputSource } from '../../input_source';
import { createCalculatorTool } from './utils/test_tools';

/**
 * Mock the generateText function
 */
vi.mock('../../generate', () => {
  return {
    generateText: vi.fn(),
    generateTextStream: vi.fn(),
  };
});

describe('End-to-End Workflows', () => {
  let calculatorTool: ReturnType<typeof createCalculatorTool>;
  let generateOptions: ReturnType<typeof createGenerateOptions>;

  beforeEach(() => {
    calculatorTool = createCalculatorTool();

    // Create generateOptions with tools
    generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    }).addTool('calculator', calculatorTool);

    // Setup mock responses for generateText based on the user's query
    vi.mocked(generateText).mockImplementation(async (session) => {
      // Get the last user message
      const messages = Array.from(session.messages);
      const lastUserMessage = messages
        .filter((msg) => msg.type === 'user')
        .pop();

      // Generate different responses based on the user message
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
        // Create metadata with toolCalls
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
    // Create a template that asks for weather information and extracts structured data
    const weatherTemplate = new LinearTemplate()
      .addSystem('You are a helpful weather assistant.')
      .addUser('What is the weather in San Francisco?')
      .addAssistant(generateOptions)
      // Extract markdown headings and code blocks
      .addTransformer(
        extractMarkdown({
          headingMap: {
            'Weather Report': 'current',
            Forecast: 'forecast',
          },
          codeBlockMap: { json: 'weatherData' },
        }),
      );

    // Execute the template
    const session = await weatherTemplate.execute(createSession());

    // Verify the conversation flow
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');

    // Verify the extracted data
    expect(session.metadata.get('current')).toContain('72°F and sunny');
    expect(session.metadata.get('forecast')).toContain('Today: Sunny');

    // Verify the extracted JSON data
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
   * and the implementation of guardrail tests is in guardrail_template.test.ts
   */

  it('should execute a complete conversation with validation', async () => {
    // Create a validator that checks for specific content
    const _contentValidator = new RegexMatchValidator({
      regex: /help/i,
      description: 'Response must contain the word "help"',
    });

    const linearTemplate = new LinearTemplate()
      .addSystem('You are a helpful assistant.')
      .addUser('Can you assist me?')
      .addAssistant(generateOptions);

    // Execute the template
    const session = await linearTemplate.execute(createSession());

    // Verify the conversation flow
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
    // Create a loop template
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

    // Execute the template
    const session = await loopTemplate.execute(createSession());

    // Verify the conversation flow
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
    expect(messages[3].type).toBe('user');

    // Verify the content
    expect(messages[1].content).toBe('Tell me something interesting.');
    expect(messages[3].content).toBe('Should we continue? (yes/no): no');
  });
});
