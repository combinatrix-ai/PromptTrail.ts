import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../../session';
import { SchemaTemplate } from '../../templates/schema_template';
import {
  defineSchema,
  createStringProperty,
  createNumberProperty,
  createBooleanProperty,
} from '../../utils/schema';
import { createMetadata } from '../../metadata';
import { generateText } from '../../generate';
import { createGenerateOptions } from '../../generate_options';
import { z } from 'zod';
import { tool } from 'ai';

// Mock the generateText function
vi.mock('../../generate', () => {
  return {
    generateText: vi.fn(),
  };
});

/**
 * Helper function to check if an object matches a pattern
 * This allows for more flexible testing with pattern matching instead of exact matching
 */
function expectObjectToMatchPattern(actual: any, pattern: any) {
  // First check that the actual value is defined
  expect(actual).toBeDefined();
  
  // Check each property in the pattern
  for (const key in pattern) {
    // Check that the property exists
    expect(actual).toHaveProperty(key);
    
    const expectedValue = pattern[key];
    const actualValue = actual[key];
    
    if (expectedValue === expect.any(String)) {
      expect(typeof actualValue).toBe('string');
    } else if (expectedValue === expect.any(Number)) {
      expect(typeof actualValue).toBe('number');
    } else if (expectedValue === expect.any(Boolean)) {
      expect(typeof actualValue).toBe('boolean');
    } else if (expectedValue instanceof RegExp) {
      expect(String(actualValue)).toMatch(expectedValue);
    } else if (typeof expectedValue === 'object' && expectedValue !== null) {
      // Recursively check nested objects
      expectObjectToMatchPattern(actualValue, expectedValue);
    } else {
      // Check exact values
      expect(actualValue).toEqual(expectedValue);
    }
  }
}

describe('SchemaTemplate', () => {
  let generateOptions: any;

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
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content:
        '```json\n{"name":"Test Product","price":99.99,"inStock":true,"description":"This is a test product"}\n```',
      metadata: createMetadata(),
    });
  });

  it('should validate output against native schema', async () => {
    // Define a schema using PromptTrail's native schema format
    const productSchema = defineSchema({
      properties: {
        name: createStringProperty('The name of the product'),
        price: createNumberProperty('The price of the product in USD'),
        inStock: createBooleanProperty('Whether the product is in stock'),
        description: createStringProperty('A short description of the product'),
      },
      required: ['name', 'price', 'inStock'],
    });

    // Create a schema template
    const template = new SchemaTemplate({
      generateOptions,
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
    // Define a schema using PromptTrail's native schema format
    const productSchema = defineSchema({
      properties: {
        name: createStringProperty('The name of the product'),
        price: createNumberProperty('The price of the product in USD'),
        inStock: createBooleanProperty('Whether the product is in stock'),
        description: createStringProperty('A short description of the product'),
      },
      required: ['name', 'price', 'inStock'],
    });

    // Create a schema template
    const template = new SchemaTemplate({
      generateOptions,
      schema: productSchema,
    });

    // Mock generateText to return a markdown code block
    vi.mocked(generateText).mockResolvedValueOnce({
      type: 'assistant',
      content:
        '```json\n{"name":"Markdown Product","price":49.99,"inStock":true,"description":"This is extracted from markdown"}\n```',
      metadata: createMetadata(),
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
    // Define a schema using PromptTrail's native schema format
    const productSchema = defineSchema({
      properties: {
        name: createStringProperty('The name of the product'),
        price: createNumberProperty('The price of the product in USD'),
        inStock: createBooleanProperty('Whether the product is in stock'),
        description: createStringProperty('A short description of the product'),
      },
      required: ['name', 'price', 'inStock'],
    });

    // Create a schema template
    const template = new SchemaTemplate({
      generateOptions,
      schema: productSchema,
    });

    // Mock generateText to return plain JSON
    vi.mocked(generateText).mockResolvedValueOnce({
      type: 'assistant',
      content:
        '{"name":"Plain JSON Product","price":29.99,"inStock":false,"description":"This is plain JSON"}',
      metadata: createMetadata(),
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
    // Define a schema using PromptTrail's native schema format
    const productSchema = defineSchema({
      properties: {
        name: createStringProperty('The name of the product'),
        price: createNumberProperty('The price of the product in USD'),
        inStock: createBooleanProperty('Whether the product is in stock'),
        description: createStringProperty('A short description of the product'),
      },
      required: ['name', 'price', 'inStock'],
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
    vi.mocked(generateText).mockResolvedValueOnce({
      type: 'assistant',
      content: 'I will use the function to provide structured output.',
      metadata,
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
    const productTool = tool({
      description: 'Get product information',
      parameters: productSchema,
      execute: async (params) => {
        return params; // Just return the input for testing
      }
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
    vi.mocked(generateText).mockResolvedValueOnce({
      type: 'assistant',
      content: 'I will use the ai-sdk tool to provide structured output.',
      metadata,
    });

    // Create a schema template with the tool-enabled generateOptions
    const template = new SchemaTemplate({
      generateOptions: toolsGenerateOptions,
      schema: defineSchema({
        properties: {
          name: createStringProperty('The name of the product'),
          price: createNumberProperty('The price of the product in USD'),
          inStock: createBooleanProperty('Whether the product is in stock'),
          description: createStringProperty('A short description of the product'),
        },
        required: ['name', 'price', 'inStock'],
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
