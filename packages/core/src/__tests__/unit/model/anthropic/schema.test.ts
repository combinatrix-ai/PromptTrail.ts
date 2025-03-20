import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../../../../session';
import { SchemaTemplate } from '../../../../templates/schema_template';
import {
  defineSchema,
  createStringProperty,
  createNumberProperty,
  createBooleanProperty,
} from '../../../../utils/schema';
import { createMetadata } from '../../../../metadata';
import { generateText } from '../../../../generate';
import type { GenerateOptions } from '../../../../generate';

// Mock the generateText function
vi.mock('../../../../generate', () => {
  return {
    generateText: vi.fn(),
  };
});

describe('SchemaTemplate with Anthropic', () => {
  let generateOptions: GenerateOptions;

  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();

    // Create generateOptions for Anthropic
    generateOptions = {
      provider: {
        type: 'anthropic',
        apiKey: 'test-api-key',
        modelName: 'claude-3-5-haiku-latest',
      },
      temperature: 0.7,
    };

    // Default mock implementation for generateText
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content:
        '```json\n{"name":"Anthropic Product","price":149.99,"inStock":true,"description":"This is a product from Anthropic"}\n```',
      metadata: createMetadata(),
    });
  });

  it('should validate output from Anthropic models', async () => {
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

    // Verify the output
    expect(output).toEqual({
      name: 'Anthropic Product',
      price: 149.99,
      inStock: true,
      description: 'This is a product from Anthropic',
    });
  });

  it('should handle different JSON formats from Anthropic', async () => {
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

    // Mock generateText to return a different JSON format
    vi.mocked(generateText).mockResolvedValueOnce({
      type: 'assistant',
      content:
        'Here is the product information:\n\n```\n{\n  "name": "Alternative Format",\n  "price": 79.99,\n  "inStock": false,\n  "description": "This is in a different format"\n}\n```',
      metadata: createMetadata(),
    });

    // Execute the template
    const session = await template.execute(createSession());

    // Get the structured output from the session metadata
    const output = session.metadata.get('structured_output');

    // Verify the output
    expect(output).toBeDefined();
    expect(typeof output).toBe('object');
    expect(output).toHaveProperty('name');
    expect(output).toHaveProperty('price');
    expect(output).toHaveProperty('inStock');
    expect(output).toHaveProperty('description');
  });
});
