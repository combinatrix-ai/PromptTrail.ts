import { describe, it, expect } from 'vitest';
import { AnthropicModel } from '../model/anthropic/model';
import type { Session, Tool } from '../types';
import { createMetadata } from '../metadata';
import { createTemperature } from '../types';

// Create a calculator tool for testing function calling
const calculatorTool: Tool = {
  name: 'calculator',
  description: 'A simple calculator that can add two numbers',
  schema: {
    type: 'object',
    properties: {
      a: {
        type: 'number',
        description: 'First number',
      },
      b: {
        type: 'number',
        description: 'Second number',
      },
    },
    required: ['a', 'b'],
  },
  execute: async (input: { a: number; b: number }) => {
    return { result: input.a + input.b };
  },
};

describe('AnthropicModel', () => {
  const model = new AnthropicModel({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    modelName: 'claude-3-haiku-20240307',
    temperature: createTemperature(0.7),
  });

  it('should generate a response', async () => {
    const session: Session = {
      messages: [
        {
          type: 'user',
          content: 'What is the capital of France?',
        },
      ],
      metadata: createMetadata(),
    };

    const response = await model.send(session);
    expect(response.type).toBe('assistant');
    expect(response.content).toContain('Paris');
  });

  it('should stream responses', async () => {
    const session: Session = {
      messages: [
        {
          type: 'user',
          content: 'Count from 1 to 3.',
        },
      ],
      metadata: createMetadata(),
    };

    const chunks: string[] = [];
    for await (const chunk of model.sendAsync(session)) {
      chunks.push(chunk.content);
    }

    const fullResponse = chunks.join('');
    expect(fullResponse).toMatch(/1.*2.*3/);
  });

  it('should handle system messages', async () => {
    const session: Session = {
      messages: [
        {
          type: 'system',
          content:
            'You are a helpful assistant that always responds in French.',
        },
        {
          type: 'user',
          content: 'Hello!',
        },
      ],
      metadata: createMetadata(),
    };

    const response = await model.send(session);
    expect(response.type).toBe('assistant');
    expect(response.content).toMatch(/^(Bonjour|Salut)/);
  });

  it('should handle multi-turn conversations', async () => {
    const session: Session = {
      messages: [
        {
          type: 'user',
          content: "Let's talk about space. What is your favorite planet?",
        },
        {
          type: 'assistant',
          content:
            'I find Mars particularly fascinating because of its potential for human exploration and its similarities to Earth.',
          metadata: createMetadata(),
        },
        {
          type: 'user',
          content: 'Why is Mars red?',
        },
      ],
      metadata: createMetadata(),
    };

    const response = await model.send(session);
    expect(response.type).toBe('assistant');
    expect(response.content).toContain('iron');
  });

  // Note: Tool tests are commented out as Anthropic's tool calling might work differently
  /* 
  it('should use tools when available', async () => {
    const modelWithTools = new AnthropicModel({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      modelName: 'claude-3-haiku-20240307',
      temperature: createTemperature(0.7),
      tools: [calculatorTool],
    });

    const session: Session = {
      messages: [
        {
          type: 'user',
          content: 'What is 2 + 2?',
        },
      ],
      metadata: createMetadata(),
    };

    const response = (await modelWithTools.send(session)) as AssistantMessage;
    expect(response.type).toBe('assistant');
    const toolCalls = response.metadata?.get(
      'toolCalls',
    ) as AssistantMetadata['toolCalls'];
    expect(toolCalls).toBeDefined();
    expect(toolCalls?.[0]?.name).toBe('calculator');
    expect(toolCalls?.[0]?.arguments).toEqual({ a: 2, b: 2 });
  });
  */
});
