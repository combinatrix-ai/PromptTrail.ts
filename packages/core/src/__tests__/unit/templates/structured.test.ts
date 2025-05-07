import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createGenerateOptions,
  GenerateOptions,
} from '../../../generate_options';
import { createSession } from '../../../session';
import { Structured } from '../../../templates/primitives/structured';

const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

describe('SchemaTemplate API Integration', () => {
  let openaiOptions: GenerateOptions;
  let anthropicOptions: GenerateOptions;

  beforeAll(() => {
    openaiOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || '',
        modelName: 'gpt-3.5-turbo',
      },
      temperature: 0.7,
    });

    anthropicOptions = createGenerateOptions({
      provider: {
        type: 'anthropic',
        apiKey: process.env.ANTHROPIC_API_KEY || '',
        modelName: 'claude-3-haiku-20240307',
      },
      temperature: 0.7,
    });
  });

  const productSchema = z.object({
    name: z.string().describe('The name of the product'),
    price: z.number().describe('The price of the product in USD'),
    inStock: z.boolean().describe('Whether the product is in stock'),
    description: z.string().describe('A short description of the product'),
  });

  const zodProductSchema = z.object({
    name: z.string().describe('The name of the product'),
    price: z.number().describe('The price of the product in USD'),
    inStock: z.boolean().describe('Whether the product is in stock'),
    description: z.string().describe('A short description of the product'),
  });

  it('should generate structured data with OpenAI and native schema', async () => {
    const template = new Structured({
      generateOptions: openaiOptions,
      schema: productSchema,
      maxAttempts: 2, // Test the retry logic with a smaller number of attempts
    });

    const session = createSession({
      messages: [
        {
          type: 'user',
          content: 'Generate information about a smartphone product.',
        },
      ],
    });

    const resultSession = await template.execute(session);

    const output = resultSession.getLastMessage()?.structuredContent;

    expect(output).toBeDefined();
    if (output) {
      expect(typeof output.name).toBe('string');
      expect(typeof output.price).toBe('number');
      expect(typeof output.inStock).toBe('boolean');
      expect(typeof output.description).toBe('string');
    }
  }, 30000); // Increase timeout for API call

  it('should generate structured data with OpenAI and Zod schema', async () => {
    const template = new Structured({
      generateOptions: openaiOptions,
      schema: zodProductSchema,
      maxAttempts: 2,
    });

    const session = createSession({
      messages: [
        {
          type: 'user',
          content: 'Generate information about a laptop product.',
        },
      ],
    });

    const resultSession = await template.execute(session);

    const output = resultSession.getLastMessage()?.structuredContent;

    expect(output).toBeDefined();
    if (output) {
      expect(typeof output.name).toBe('string');
      expect(typeof output.price).toBe('number');
      expect(typeof output.inStock).toBe('boolean');
      expect(typeof output.description).toBe('string');
    }
  }, 30000);

  it('should generate structured data with Anthropic and native schema', async () => {
    const template = new Structured({
      generateOptions: anthropicOptions,
      schema: productSchema,
      maxAttempts: 2,
    });

    const session = createSession({
      messages: [
        {
          type: 'user',
          content: 'Generate information about a gaming console product.',
        },
      ],
    });
    const resultSession = await template.execute(session);
    const output = resultSession.messages.at(-1)!.structuredContent;

    expect(output).toBeDefined();
    if (output) {
      expect(typeof output.name).toBe('string');
      expect(typeof output.price).toBe('number');
      expect(typeof output.inStock).toBe('boolean');
      expect(typeof output.description).toBe('string');
    }
  }, 30000);

  it('should generate structured data with Anthropic and Zod schema', async () => {
    const template = new Structured({
      generateOptions: anthropicOptions,
      schema: zodProductSchema,
      maxAttempts: 2,
    });

    const session = createSession({
      messages: [
        {
          type: 'user',
          content: 'Generate information about a smartwatch product.',
        },
      ],
    });

    const resultSession = await template.execute(session);
    const output = resultSession.messages.at(-1)!.structuredContent;

    expect(output).toBeDefined();
    if (output) {
      expect(typeof output.name).toBe('string');
      expect(typeof output.price).toBe('number');
      expect(typeof output.inStock).toBe('boolean');
      expect(typeof output.description).toBe('string');
    }
  }, 30000);

  it('should retry on failure and eventually fail with max attempts', async () => {
    const invalidSchema = z.object({
      name: z.string().describe('The name of the product'),
      price: z.number().describe('The price of the product in USD'),
      inStock: z.boolean().describe('Whether the product is in stock'),
      nonExistentProperty: z
        .string()
        .describe(
          'This property does not exist and will cause validation errors',
        ),
    });

    const template = new Structured({
      generateOptions: openaiOptions,
      schema: invalidSchema,
      maxAttempts: 2, // Set a small number to make the test faster
    });

    const session = createSession({
      messages: [
        {
          type: 'user',
          content:
            'Generate information about a product without including any additional properties.',
        },
      ],
    });

    await expect(template.execute(session)).rejects.toThrow();
  }, 30000);
});
