import { describe, it, expect, beforeEach } from 'vitest';
import { createSession } from '../../session';
import { LinearTemplate, LoopTemplate } from '../../templates';
import {
  GuardrailTemplate,
  OnFailAction,
} from '../../templates/guardrail_template';
import { createTool } from '../../tool';
import { extractMarkdown } from '../../utils/markdown_extractor';
import { RegexMatchValidator } from '../../validators/base_validators';
import { Model } from '../../model/base';
import { createMetadata } from '../../metadata';
import type {
  Session,
  Message,
  Tool,
  SchemaType,
} from '../../types';

// Create a mock model class that extends Model
class MockOpenAIModel extends Model {
  constructor(config: any) {
    super(config);
  }

  protected validateConfig(): void {
    // No validation needed for mock
  }

  protected formatTool(tool: Tool<SchemaType>): Record<string, any> {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.schema.properties,
          required: tool.schema.required || [],
        },
      },
    };
  }

  async send(session: Session): Promise<Message> {
    // Get the last user message
    const messages = Array.from(session.messages);
    const lastUserMessage = messages.filter((msg) => msg.type === 'user').pop();

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
  }

  async *sendAsync(): AsyncGenerator<Message, void, unknown> {
    yield {
      type: 'assistant',
      content: 'Streaming response',
      metadata: createMetadata(),
    };
  }
}

describe('End-to-End Workflows', () => {
  let model: MockOpenAIModel;
  let calculatorTool: any;

  beforeEach(() => {
    // Create a calculator tool
    calculatorTool = createTool({
      name: 'calculator',
      description: 'A simple calculator that can perform basic operations',
      schema: {
        properties: {
          a: { type: 'number', description: 'First number' },
          b: { type: 'number', description: 'Second number' },
          operation: {
            type: 'string',
            enum: ['add', 'subtract', 'multiply', 'divide'],
            description: 'Operation to perform',
          },
        },
        required: ['a', 'b', 'operation'],
      },
      execute: async (input) => {
        switch (input.operation) {
          case 'add':
            return { result: input.a + input.b };
          case 'subtract':
            return { result: input.a - input.b };
          case 'multiply':
            return { result: input.a * input.b };
          case 'divide':
            if (input.b === 0) throw new Error('Cannot divide by zero');
            return { result: input.a / input.b };
          default:
            throw new Error(`Unknown operation: ${input.operation}`);
        }
      },
    });

    // Create a mock model with tools
    model = new MockOpenAIModel({
      apiKey: 'test-api-key',
      modelName: 'gpt-4o-mini',
      temperature: 0.7,
      tools: [calculatorTool],
    });
  });

  it('should execute a complete weather information workflow with data extraction', async () => {
    // Create a template that asks for weather information and extracts structured data
    const weatherTemplate = new LinearTemplate()
      .addSystem('You are a helpful weather assistant.')
      .addUser('What is the weather in San Francisco?')
      .addAssistant({ model })
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
      .addAssistant({ model });

    // Execute the template
    const session = await calculatorTemplate.execute(createSession());

    // Verify the conversation flow
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');

    // Verify the tool call
    const metadata = messages[2].metadata?.toJSON() as any;
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
        .addAssistant({ model }),
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
    const guardrailInfo = session.metadata.get('guardrail') as any;
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
          .addAssistant({ model })
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
