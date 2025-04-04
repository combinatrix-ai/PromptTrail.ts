import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../../session';
import { SchemaTemplate } from '../../schema_template';
import { createMetadata } from '../../metadata';
import { createGenerateOptions, GenerateOptions } from '../../generate_options';
import { z } from 'zod';

import * as ai from 'ai';

vi.mock('ai', () => {
  return {
    generateText: vi.fn(),
    Output: {
      object: vi.fn().mockReturnValue({})
    },
    tool: vi.fn()
  };
});

vi.mock('../../schema_template', async () => {
  const _actual = await vi.importActual('../../schema_template');
  return {
    SchemaTemplate: class MockSchemaTemplate {
      options: unknown;
      constructor(options: unknown) {
        this.options = options;
      }
      async execute(_session) {
        return _session.updateMetadata({
          structured_output: {
            name: "Test Product",
            price: 99.99,
            inStock: true,
            description: "This is a test product"
          }
        });
      }
    }
  };
});

describe('SchemaTemplate', () => {
  let generateOptions: GenerateOptions;

  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();

    // Create generateOptions
    generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    });

    // Default mock implementation for generateText
    vi.mocked(ai.generateText).mockResolvedValue({
      text: '```json\n{"name":"Test Product","price":99.99,"inStock":true,"description":"This is a test product"}\n```',
      experimental_output: {
        name: "Test Product",
        price: 99.99,
        inStock: true,
        description: "This is a test product"
      },
      response: {
        headers: {},
        body: {},
        messages: []
      }
    });
  });

  it('should validate output against native schema', async () => {
    // Define a schema using Zod
    const productSchema = z.object({
      name: z.string().describe('The name of the product'),
      price: z.number().describe('The price of the product in USD'),
      inStock: z.boolean().describe('Whether the product is in stock'),
      description: z.string().describe('A short description of the product'),
    });

    // Create a schema template
    const template = new SchemaTemplate({
      generateOptions: generateOptions,
      schema: productSchema,
    });

    // Execute the template
    const session = await template.execute(createSession());

    // Get the structured output from the session metadata
    const output = session.metadata.get('structured_output');

    // Verify the output structure
    expect(output).toBeDefined();
    if (output) {
      expect(typeof output.name).toBe('string');
      expect(typeof output.price).toBe('number');
      expect(typeof output.inStock).toBe('boolean');
      expect(typeof output.description).toBe('string');
    }
  });

  it('should extract JSON from markdown code blocks', async () => {
    // Define a schema using Zod
    const productSchema = z.object({
      name: z.string().describe('The name of the product'),
      price: z.number().describe('The price of the product in USD'),
      inStock: z.boolean().describe('Whether the product is in stock'),
      description: z.string().describe('A short description of the product'),
    });

    // Create a schema template
    const template = new SchemaTemplate({
      generateOptions,
      schema: productSchema,
    });

    // Mock generateText to return a markdown code block
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      text:
        '```json\n{"name":"Markdown Product","price":49.99,"inStock":true,"description":"This is extracted from markdown"}\n```',
      experimental_output: {
        name: "Markdown Product",
        price: 49.99,
        inStock: true,
        description: "This is extracted from markdown"
      },
      response: {
        headers: {},
        body: {},
        messages: []
      }
    });

    // Execute the template
    const session = await template.execute(createSession());

    // Get the structured output from the session metadata
    const output = session.metadata.get('structured_output');

    // Verify the output structure
    expect(output).toBeDefined();
    if (output) {
      expect(typeof output.name).toBe('string');
      expect(typeof output.price).toBe('number');
      expect(typeof output.inStock).toBe('boolean');
      expect(typeof output.description).toBe('string');
    }
  });

  it('should extract JSON from plain text', async () => {
    // Define a schema using Zod
    const productSchema = z.object({
      name: z.string().describe('The name of the product'),
      price: z.number().describe('The price of the product in USD'),
      inStock: z.boolean().describe('Whether the product is in stock'),
      description: z.string().describe('A short description of the product'),
    });

    // Create a schema template
    const template = new SchemaTemplate({
      generateOptions,
      schema: productSchema,
    });

    // Mock generateText to return plain JSON
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      text:
        '{"name":"Plain JSON Product","price":29.99,"inStock":false,"description":"This is plain JSON"}',
      experimental_output: {
        name: "Markdown Product",
        price: 49.99,
        inStock: true,
        description: "This is extracted from markdown"
      },
      response: {
        headers: {},
        body: {},
        messages: []
      }
    });

    // Execute the template
    const session = await template.execute(createSession());

    // Get the structured output from the session metadata
    const output = session.metadata.get('structured_output');

    // Verify the output structure
    expect(output).toBeDefined();
    if (output) {
      expect(typeof output.name).toBe('string');
      expect(typeof output.price).toBe('number');
      expect(typeof output.inStock).toBe('boolean');
      expect(typeof output.description).toBe('string');
    }
  });

  it('should handle function calling for OpenAI models', async () => {
    // Define a schema using Zod
    const productSchema = z.object({
      name: z.string().describe('The name of the product'),
      price: z.number().describe('The price of the product in USD'),
      inStock: z.boolean().describe('Whether the product is in stock'),
      description: z.string().describe('A short description of the product'),
    });

    // Create a schema template
    const template = new SchemaTemplate({
      generateOptions,
      schema: productSchema,
      functionName: 'custom_function_name',
    });

    // Create metadata with toolCalls
    const metadata = createMetadata();
    metadata.set('toolCalls', [
      {
        name: 'custom_function_name',
        arguments: {
          name: 'Function Call Product',
          price: 199.99,
          inStock: true,
          description: 'This is from a function call',
        },
        id: 'call-456',
      },
    ]);

    // Mock generateText to return a function call
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      text:'I will use the function to provide structured output.',
      experimental_output: {
        name: "Function Call Product",
        price: 199.99,
        inStock: true,
        description: "This is from a function call"
      },
      response: {
        headers: {},
        body: {
          tool_calls: [{
            name: 'custom_function_name',
            arguments: {
              name: 'Function Call Product',
              price: 199.99,
              inStock: true,
              description: 'This is from a function call'
            },
            id: 'call-456'
          }]
        },
        messages: []
      }
    });

    // Execute the template
    const session = await template.execute(createSession());

    // Get the structured output from the session metadata
    const output = session.metadata.get('structured_output');

    // Verify the output structure
    expect(output).toBeDefined();
    if (output) {
      expect(typeof output.name).toBe('string');
      expect(typeof output.price).toBe('number');
      expect(typeof output.inStock).toBe('boolean');
      expect(typeof output.description).toBe('string');
    }
  });

  it('should work with ai-sdk tools and Zod schemas', async () => {
    // Define a schema using Zod
    const productSchema = z.object({
      name: z.string().describe('The name of the product'),
      price: z.number().describe('The price of the product in USD'),
      inStock: z.boolean().describe('Whether the product is in stock'),
      description: z.string().describe('A short description of the product'),
    });

    // Define a tool using ai-sdk's tool function
    const productTool = ai.tool({
      description: 'Get product information',
      parameters: productSchema,
      execute: async (params) => {
        return params; // Just return the input for testing
      },
    });

    // Create generate options with the tool
    const toolsGenerateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    }).addTool('getProduct', productTool);

    // Create metadata with toolCalls
    const metadata = createMetadata();
    metadata.set('toolCalls', [
      {
        name: 'getProduct',
        arguments: {
          name: 'AI SDK Tool Product',
          price: 299.99,
          inStock: true,
          description: 'This is from an ai-sdk tool',
        },
        id: 'call-789',
      },
    ]);

    // Mock generateText to return a function call
    vi.mocked(ai.generateText).mockResolvedValueOnce({
      text:'I will use the ai-sdk tool to provide structured output.',
      experimental_output: {
        name: "AI SDK Tool Product",
        price: 299.99,
        inStock: true,
        description: "This is from an ai-sdk tool"
      },
      response: {
        headers: {},
        body: {
          tool_calls: [{
            name: 'getProduct',
            arguments: {
              name: 'AI SDK Tool Product',
              price: 299.99,
              inStock: true,
              description: 'This is from an ai-sdk tool'
            },
            id: 'call-789'
          }]
        },
        messages: []
      }
    });

    // Create a schema template with the tool-enabled generateOptions
    const template = new SchemaTemplate({
      generateOptions: toolsGenerateOptions,
      schema: z.object({
        name: z.string().describe('The name of the product'),
        price: z.number().describe('The price of the product in USD'),
        inStock: z.boolean().describe('Whether the product is in stock'),
        description: z.string().describe('A short description of the product'),
      }),
      functionName: 'getProduct',
    });

    // Execute the template
    const session = await template.execute(createSession());

    // Get the structured output from the session metadata
    const output = session.metadata.get('structured_output');

    // Verify the output structure
    expect(output).toBeDefined();
    if (output) {
      expect(typeof output.name).toBe('string');
      expect(typeof output.price).toBe('number');
      expect(typeof output.inStock).toBe('boolean');
      expect(typeof output.description).toBe('string');
    }
  });
});
