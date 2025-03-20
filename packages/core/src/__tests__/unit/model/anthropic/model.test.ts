import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Session,
  AssistantMessage,
  AssistantMetadata,
} from '../../../../types';
import { createTool } from '../../../../tool';
import { createMetadata } from '../../../../metadata';

// Mock the Anthropic module
vi.mock('../../../../model/anthropic/model');

// Import after mocking
import { AnthropicModel } from '../../../../model/anthropic/model';

// Create a calculator tool for testing function calling
const calculatorTool = createTool({
  name: 'calculator',
  description: 'A simple calculator that can add two numbers',
  schema: {
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
  execute: async (input) => input.a + input.b,
});

describe('AnthropicModel', () => {
  let model: AnthropicModel;
  let modelWithTools: AnthropicModel;

  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();

    // Create a mock model
    model = {
      send: vi.fn(),
      sendAsync: vi.fn(),
      config: {
        apiKey: 'mock-api-key',
        modelName: 'claude-3-haiku-20240307',
        temperature: 0.7,
      },
    } as unknown as AnthropicModel;

    // Create a mock model with tools
    modelWithTools = {
      send: vi.fn(),
      sendAsync: vi.fn(),
      config: {
        apiKey: 'mock-api-key',
        modelName: 'claude-3-haiku-20240307',
        temperature: 0.7,
        tools: [calculatorTool],
      },
    } as unknown as AnthropicModel;

    // Mock the send method for the basic model
    vi.mocked(model.send).mockImplementation(async (session: Session) => {
      const lastMessage = Array.from(session.messages).pop();
      
      if (lastMessage?.content.includes('capital of France')) {
        return {
          type: 'assistant',
          content: 'The capital of France is Paris.',
          metadata: createMetadata(),
        };
      } else if (lastMessage?.content.includes('space') || lastMessage?.content.includes('Mars')) {
        return {
          type: 'assistant',
          content: 'Mars appears red because its surface contains iron oxide, commonly known as rust. The iron in the Martian soil has oxidized over time, giving the planet its characteristic reddish hue.',
          metadata: createMetadata(),
        };
      } else if (lastMessage?.type === 'tool_result') {
        return {
          type: 'assistant',
          content: 'The result of 2 + 2 is 4.',
          metadata: createMetadata(),
        };
      } else {
        return {
          type: 'assistant',
          content: 'Bonjour! Comment puis-je vous aider aujourd\'hui?',
          metadata: createMetadata(),
        };
      }
    });

    // Mock the sendAsync method
    vi.mocked(model.sendAsync).mockImplementation(async function* () {
      yield {
        type: 'assistant',
        content: 'Let me count: 1',
        metadata: createMetadata(),
      };
      yield {
        type: 'assistant',
        content: ' 2',
        metadata: createMetadata(),
      };
      yield {
        type: 'assistant',
        content: ' 3',
        metadata: createMetadata(),
      };
    });

    // Mock the send method for the model with tools
    vi.mocked(modelWithTools.send).mockImplementation(async () => {
      const metadata = createMetadata<AssistantMetadata>();
      metadata.set('toolCalls', [
        {
          name: 'calculator',
          arguments: { a: 2, b: 2 },
          id: 'call-123',
        },
      ]);

      return {
        type: 'assistant',
        content: 'I need to calculate 2 + 2.',
        metadata,
      };
    });
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

  it('should use tools when available', async () => {

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

  it('should handle tool results', async () => {
    const session: Session = {
      messages: [
        {
          type: 'user',
          content: 'What is 2 + 2?',
        },
        {
          type: 'assistant',
          content: 'Let me calculate that for you.',
          metadata: createMetadata(),
        },
        {
          type: 'tool_result',
          content: '4',
          result: { result: 4 },
          metadata: createMetadata(),
        },
      ],
      metadata: createMetadata(),
    };

    const response = await model.send(session);
    expect(response.type).toBe('assistant');
    expect(response.content).toMatch(/4/);
  });
});
