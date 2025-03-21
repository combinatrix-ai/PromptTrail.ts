import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSession } from '../../session';
import { LinearTemplate, LoopTemplate } from '../../templates';
import {
  GuardrailTemplate,
  OnFailAction,
} from '../../templates/guardrail_template';
import { tool } from 'ai';
import { z } from 'zod';
import { extractMarkdown } from '../../utils/markdown_extractor';
import { RegexMatchValidator } from '../../validators/base_validators';
import { createMetadata } from '../../metadata';
import { generateText } from '../../generate';
import { createGenerateOptions } from '../../generate_options';

// Mock the generateText function
vi.mock('../../generate', () => {
  return {
    generateText: vi.fn(),
    generateTextStream: vi.fn(),
  };
});

describe('End-to-End Workflows', () => {
  let calculatorTool: any;
  let generateOptions: any;

  beforeEach(() => {
    // Create a calculator tool using ai-sdk's tool function
    calculatorTool = tool({
      description: 'A simple calculator that can perform basic operations',
      parameters: z.object({
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
        operation: z
          .enum(['add', 'subtract', 'multiply', 'divide'])
          .describe('Operation to perform'),
      }),
      execute: async ({ a, b, operation }) => {
        switch (operation) {
          case 'add':
            return a + b;
          case 'subtract':
            return a - b;
          case 'multiply':
            return a * b;
          case 'divide':
            if (b === 0) throw new Error('Cannot divide by zero');
            return a / b;
          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      },
    });

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
      .addAssistant({ generateOptions })
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

  it('should execute a complete tool usage workflow', async () => {
    // Create a template that uses a tool
    const calculatorTemplate = new LinearTemplate()
      .addSystem('You are a helpful assistant that can perform calculations.')
      .addUser('Can you calculate 5 + 3 for me?')
      .addAssistant({ generateOptions });

    // Execute the template
    const session = await calculatorTemplate.execute(createSession());

    // Verify the conversation flow
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');

    // Verify the tool call
    const metadata = messages[2].metadata?.toJSON() as {
      toolCalls?: Array<{
        name: string;
        arguments: Record<string, unknown>;
        id: string;
      }>;
    };
    expect(metadata?.toolCalls).toBeDefined();
    if (metadata?.toolCalls) {
      expect(metadata.toolCalls[0].name).toBe('calculator');
      expect(metadata.toolCalls[0].arguments).toEqual({
        a: 5,
        b: 3,
        operation: 'add',
      });
    }
  });

  it('should execute a complete conversation with guardrails', async () => {
    // Create a validator that checks for specific content
    const contentValidator = new RegexMatchValidator({
      regex: /help/i,
      description: 'Response must contain the word "help"',
    });

    // Create a guardrail template
    const guardrailTemplate = new GuardrailTemplate({
      template: new LinearTemplate()
        .addSystem('You are a helpful assistant.')
        .addUser('Can you assist me?')
        .addAssistant({ generateOptions }),
      validators: [contentValidator],
      onFail: OnFailAction.RETRY,
      maxAttempts: 3,
    });

    // Execute the template
    const session = await guardrailTemplate.execute(createSession());

    // Verify the conversation flow
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');

    // Verify the guardrail metadata
    const guardrailInfo = session.metadata.get('guardrail') as {
      passed: boolean;
      attempt: number;
      validationResults: Array<{ passed: boolean; feedback?: string }>;
    };
    expect(guardrailInfo).toBeDefined();
    if (guardrailInfo) {
      expect(guardrailInfo.passed).toBe(true);
    }
  });

  it('should execute a complete conversation with a loop', async () => {
    // Create a loop template
    const loopTemplate = new LinearTemplate()
      .addSystem('You are a helpful assistant.')
      .addLoop(
        new LoopTemplate()
          .addUser(
            'Tell me something interesting.',
            'Tell me something interesting.',
          )
          .addAssistant({ generateOptions })
          .addUser('Should we continue? (yes/no)', 'no')
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
    expect(messages[3].content).toBe('Should we continue? (yes/no)');
  });
});
