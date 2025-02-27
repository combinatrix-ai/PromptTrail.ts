import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createSession } from '../session';
import { SchemaTemplate } from '../templates/schema_template';
import { OpenAIModel } from '../model/openai/model';
import {
  defineSchema,
  createStringProperty,
  createNumberProperty,
  createBooleanProperty,
} from '../utils/schema';
import { createMetadata } from '../metadata';

// Mock OpenAI model
vi.mock('../model/openai/model');

describe('SchemaTemplate', () => {
  let model: OpenAIModel;

  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();

    // Create a mock OpenAI model
    model = {
      send: vi.fn().mockImplementation(async (session) => {
        // Default implementation for the first test
        return {
          type: 'assistant',
          content:
            '```json\n{"name":"Test Product","price":99.99,"inStock":true,"description":"This is a test product"}\n```',
          metadata: createMetadata(),
        };
      }),
      sendAsync: vi.fn(),
      formatTool: vi.fn(),
      validateConfig: vi.fn(),
      config: {},
    } as unknown as OpenAIModel;

    // Mock the instanceof check
    Object.defineProperty(model, Symbol.hasInstance, {
      value: (obj: any) => true,
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
      model,
      schema: productSchema,
    });

    // Execute the template
    const session = await template.execute(createSession());

    // Get the structured output from the session metadata
    const output = session.metadata.get('structured_output');

    // Verify the output
    expect(output).toEqual({
      name: 'Test Product',
      price: 99.99,
      inStock: true,
      description: 'This is a test product',
    });
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
      model,
      schema: productSchema,
    });

    // Mock the model to return a markdown code block
    vi.spyOn(model, 'send').mockImplementationOnce(async () => {
      return {
        type: 'assistant',
        content:
          '```json\n{"name":"Markdown Product","price":49.99,"inStock":true,"description":"This is extracted from markdown"}\n```',
        metadata: createMetadata(),
      };
    });

    // Execute the template
    const session = await template.execute(createSession());

    // Get the structured output from the session metadata
    const output = session.metadata.get('structured_output');

    // Verify the output matches what we expect
    expect(output).toBeDefined();
    expect(typeof output).toBe('object');
    expect(output).toHaveProperty('name');
    expect(output).toHaveProperty('price');
    expect(output).toHaveProperty('inStock');
    expect(output).toHaveProperty('description');
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
      model,
      schema: productSchema,
    });

    // Mock the model to return plain JSON
    vi.spyOn(model, 'send').mockImplementationOnce(async () => {
      return {
        type: 'assistant',
        content:
          '{"name":"Plain JSON Product","price":29.99,"inStock":false,"description":"This is plain JSON"}',
        metadata: createMetadata(),
      };
    });

    // Execute the template
    const session = await template.execute(createSession());

    // Get the structured output from the session metadata
    const output = session.metadata.get('structured_output');

    // Verify the output
    expect(output).toEqual({
      name: 'Plain JSON Product',
      price: 29.99,
      inStock: false,
      description: 'This is plain JSON',
    });
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
      model,
      schema: productSchema,
      functionName: 'custom_function_name',
    });

    // Mock the model to return a function call
    vi.spyOn(model, 'send').mockImplementationOnce(async () => {
      return {
        type: 'assistant',
        content: 'I will use the function to provide structured output.',
        metadata: createMetadata({
          initial: {
            toolCalls: [
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
            ],
          },
        }),
      } as any;
    });

    // Execute the template
    const session = await template.execute(createSession());

    // Get the structured output from the session metadata
    const output = session.metadata.get('structured_output');

    // Verify the output matches what we expect
    expect(output).toBeDefined();
    expect(typeof output).toBe('object');
    expect(output).toHaveProperty('name');
    expect(output).toHaveProperty('price');
    expect(output).toHaveProperty('inStock');
    expect(output).toHaveProperty('description');
  });
});
