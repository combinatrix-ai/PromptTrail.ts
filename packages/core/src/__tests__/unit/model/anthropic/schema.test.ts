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
import { AnthropicModel } from '../../../../model/anthropic/model';

// Mock Anthropic model
vi.mock('../../../../model/anthropic/model');

describe('SchemaTemplate with Anthropic', () => {
  let model: AnthropicModel;

  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();

    // Create a mock Anthropic model
    model = {
      send: vi.fn().mockImplementation(async (_session) => {
        // Session parameter intentionally unused (prefixed with underscore)
        // Default implementation for Anthropic response
        return {
          type: 'assistant',
          content:
            '```json\n{"name":"Anthropic Product","price":149.99,"inStock":true,"description":"This is a product from Anthropic"}\n```',
          metadata: createMetadata(),
        };
      }),
      sendAsync: vi.fn(),
      formatTool: vi.fn(),
      validateConfig: vi.fn(),
      config: {},
    } as unknown as AnthropicModel;
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
      model,
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
      model,
      schema: productSchema,
    });

    // Mock the model to return a different JSON format
    vi.spyOn(model, 'send').mockImplementationOnce(async (_session) => {
      // Session parameter intentionally unused (prefixed with underscore)
      return {
        type: 'assistant',
        content:
          'Here is the product information:\n\n```\n{\n  "name": "Alternative Format",\n  "price": 79.99,\n  "inStock": false,\n  "description": "This is in a different format"\n}\n```',
        metadata: createMetadata(),
      };
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
