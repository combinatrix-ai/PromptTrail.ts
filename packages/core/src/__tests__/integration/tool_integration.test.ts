import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../../session';
import { LinearTemplate } from '../../templates';
import { generateText } from '../../generate';
import { createGenerateOptions } from '../../generate_options';
import { createMetadata } from '../../metadata';
import { tool } from 'ai';
import { z } from 'zod';

// Mock the generateText function
vi.mock('../../generate', () => {
  return {
    generateText: vi.fn(),
  };
});

describe('Tool Integration with ai-sdk', () => {
  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();

    // Default mock implementation for generateText
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'I used the calculator tool to compute 123 * 456 = 56088.',
      metadata: createMetadata(),
      toolCalls: [
        {
          name: 'calculator',
          arguments: {
            a: 123,
            b: 456,
            operation: 'multiply',
          },
          id: 'call-123',
        },
      ],
    });
  });

  it('should use ai-sdk tools with fluent GenerateOptions API', async () => {
    // Define a calculator tool using ai-sdk
    const calculatorTool = tool({
      description: 'Perform arithmetic operations',
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
            return a / b;
        }
      },
    });

    // Create generate options with fluent API
    const generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    })
      .addTool('calculator', calculatorTool)
      .setToolChoice('auto');

    // Create a conversation template
    const template = new LinearTemplate()
      .addSystem("I'm a helpful assistant with access to tools.")
      .addUser('What is 123 * 456?')
      .addAssistant(generateOptions);

    // Execute the template
    const session = await template.execute(createSession());

    // Verify the response contains tool usage
    expect(session.getLastMessage()).toBeDefined();
    expect(session.getLastMessage()?.content).toContain('56088');

    // Verify that generateText was called with the correct tools
    expect(generateText).toHaveBeenCalled();
    const callArgs = vi.mocked(generateText).mock.calls[0][1];
    expect(callArgs.tools).toHaveProperty('calculator');
    expect(callArgs.toolChoice).toBe('auto');
  });

  it('should allow adding multiple tools', async () => {
    // Define a calculator tool
    const calculatorTool = tool({
      description: 'Perform arithmetic operations',
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
            return a / b;
        }
      },
    });

    // Define a weather tool
    const weatherTool = tool({
      description: 'Get weather information',
      parameters: z.object({
        location: z.string().describe('City name'),
        days: z.number().optional().describe('Number of forecast days'),
      }),
      execute: async ({ location, days = 1 }) => {
        return {
          location,
          forecast: Array(days).fill({ temp: 72, condition: 'sunny' }),
        };
      },
    });

    // Create generate options with multiple tools
    const generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    })
      .addTool('calculator', calculatorTool)
      .addTool('weather', weatherTool);

    // Verify that tools were added correctly
    expect(generateOptions.tools).toHaveProperty('calculator');
    expect(generateOptions.tools).toHaveProperty('weather');
  });

  it('should support adding tools in bulk', async () => {
    // Define multiple tools
    const tools = {
      calculator: tool({
        description: 'Perform arithmetic operations',
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
              return a / b;
          }
        },
      }),
      weather: tool({
        description: 'Get weather information',
        parameters: z.object({
          location: z.string().describe('City name'),
          days: z.number().optional().describe('Number of forecast days'),
        }),
        execute: async ({ location, days = 1 }) => {
          return {
            location,
            forecast: Array(days).fill({ temp: 72, condition: 'sunny' }),
          };
        },
      }),
    };

    // Create generate options and add tools in bulk
    const generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    }).addTools(tools);

    // Verify that tools were added correctly
    expect(generateOptions.tools).toHaveProperty('calculator');
    expect(generateOptions.tools).toHaveProperty('weather');
  });

  it('should support type inference from tool definitions', async () => {
    // Define a calculator tool with type inference
    const calculatorTool = tool({
      description: 'Perform arithmetic operations',
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
            return a / b;
        }
      },
    });

    // Type inference works - TypeScript would error if we passed invalid parameters
    type CalculatorInput = Parameters<typeof calculatorTool.execute>[0];
    const validInput: CalculatorInput = {
      a: 10,
      b: 20,
      operation: 'add',
    };

    // This would cause a TypeScript error:
    // const invalidInput: CalculatorInput = {
    //   a: 10,
    //   b: 20,
    //   operation: 'invalid-op' // Error: Type '"invalid-op"' is not assignable to type...
    // };

    // Create generate options with the tool
    const generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
    }).addTool('calculator', calculatorTool);

    // Just verify the tool was added
    expect(generateOptions.tools).toHaveProperty('calculator');
  });
});
