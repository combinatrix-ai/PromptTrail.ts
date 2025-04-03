import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../../session';
import { createGenerateOptions } from '../../generate_options';
import * as generateModule from '../../generate';
import { createMetadata } from '../../metadata';
import { LinearTemplate } from '../../templates';

vi.mock('../../generate', () => ({
  generateText: vi.fn(),
}));

describe('README Examples', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    
    vi.mocked(generateModule.generateText).mockResolvedValue({
      type: 'assistant',
      content: 'This is a mock response from the AI model.',
      metadata: createMetadata(),
    });
  });

  describe('Quick Start Example', () => {
    it('should create a conversation template and execute it', async () => {
      const generateOptions = createGenerateOptions({
        provider: {
          type: 'openai',
          apiKey: process.env.OPENAI_API_KEY || 'sk-dummy-key',
          modelName: 'gpt-4o-mini',
        },
        temperature: 0.7,
      });

      const chat = new LinearTemplate()
        .addSystem("I'm a helpful assistant.")
        .addUser("What's TypeScript?")
        .addAssistant(generateOptions);

      const session = await chat.execute(
        createSession({
          print: true,
        }),
      );

      expect(session.messages).toHaveLength(3);
      expect(session.messages[0].type).toBe('system');
      expect(session.messages[0].content).toBe("I'm a helpful assistant.");
      expect(session.messages[1].type).toBe('user');
      expect(session.messages[1].content).toBe("What's TypeScript?");
      expect(session.messages[2].type).toBe('assistant');
      
      expect(generateModule.generateText).toHaveBeenCalled();
    });
  });

  describe('Session Management', () => {
    it('should create and manage a session', () => {
      const session = createSession();
      expect(session.messages).toHaveLength(0);
      
      const updatedSession = session
        .addMessage({
          type: 'system',
          content: 'You are a helpful assistant.',
          metadata: undefined,
        })
        .addMessage({
          type: 'user',
          content: 'Hello!',
          metadata: undefined,
        });
      
      expect(session.messages).toHaveLength(0);
      
      expect(updatedSession.messages).toHaveLength(2);
      expect(updatedSession.messages[0].type).toBe('system');
      expect(updatedSession.messages[1].type).toBe('user');
    });
    
    it('should manage metadata in a session', () => {
      const session = createSession({
        metadata: {
          userId: '12345',
          conversationId: 'abc-123',
        },
      });
      
      expect(session.metadata.get('userId')).toBe('12345');
      expect(session.metadata.get('conversationId')).toBe('abc-123');
      
      const updatedSession = session.updateMetadata({
        userId: 'updated-user-id',
      });
      
      expect(session.metadata.has('userId')).toBe(true);
      expect(session.metadata.get('userId')).toBe('12345');
      
      expect(updatedSession.metadata.has('userId')).toBe(true);
      expect(updatedSession.metadata.get('userId')).toBe('updated-user-id'); // Original metadata is updated
    });
  });

  describe('Tool Integration', () => {
    it('should use tools with generateOptions', async () => {
      vi.mocked(generateModule.generateText).mockResolvedValue({
        type: 'assistant',
        content: 'I need to calculate 123 * 456.',
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
      
      const calculator = {
        description: 'Perform arithmetic operations',
        parameters: {
          type: 'object',
          properties: {
            a: { type: 'number', description: 'First number' },
            b: { type: 'number', description: 'Second number' },
            operation: { 
              type: 'string', 
              enum: ['add', 'subtract', 'multiply', 'divide'],
              description: 'Operation to perform'
            },
          },
          required: ['a', 'b', 'operation'],
        }
      };
      
      const generateOptions = createGenerateOptions({
        provider: {
          type: 'openai',
          apiKey: process.env.OPENAI_API_KEY || 'sk-dummy-key',
          modelName: 'gpt-4o-mini',
        },
        temperature: 0.7,
      }).addTool('calculator', calculator);
      
      const chat = new LinearTemplate()
        .addSystem("I'm a helpful assistant with calculator abilities.")
        .addUser("What is 123 * 456?")
        .addAssistant(generateOptions);
      
      await chat.execute(createSession());
      
      expect(generateModule.generateText).toHaveBeenCalled();
      const callArgs = vi.mocked(generateModule.generateText).mock.calls[0][1];
      expect(callArgs.tools).toHaveProperty('calculator');
    });
  });

  describe('Session-to-Metadata Conversion', () => {
    it('should extract data using extractMarkdown', async () => {
      const { extractMarkdown } = await import('../../utils/markdown_extractor');
      
      const mockAssistantResponse = {
        type: 'assistant',
        content: `
## Explanation
Here's how factorial works in TypeScript.

## Usage Example
Here's how to use the factorial function.

\`\`\`typescript
function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
\`\`\`
        `,
        metadata: createMetadata(),
      };
      
      vi.mocked(generateModule.generateText).mockResolvedValue({
        type: 'assistant',
        content: mockAssistantResponse.content,
        metadata: mockAssistantResponse.metadata,
      });
      
      const generateOptions = createGenerateOptions({
        provider: {
          type: 'openai',
          apiKey: process.env.OPENAI_API_KEY || 'sk-dummy-key',
          modelName: 'gpt-4o-mini',
        },
        temperature: 0.7,
      });
      
      const codeTemplate = new LinearTemplate()
        .addSystem(
          "You're a TypeScript expert. Always include code examples in ```typescript blocks and use ## headings for sections.",
        )
        .addUser(
          'Write a function to calculate the factorial of a number with explanation.',
        )
        .addAssistant(generateOptions)
        .addTransformer(
          extractMarkdown({
            headingMap: {
              Explanation: 'explanation',
              'Usage Example': 'usageExample',
            },
            codeBlockMap: { typescript: 'code' },
          }),
        );

      const session = await codeTemplate.execute(createSession());

      expect(session.metadata.get('explanation')).toContain("Here's how factorial works");
      expect(session.metadata.get('usageExample')).toContain("Here's how to use the factorial function");
      expect(session.metadata.get('code')).toContain("function factorial(n: number)");
    });
  });

  describe('Validation', () => {
    it('should validate assistant responses', async () => {
      const { RegexMatchValidator } = await import('../../validator');
      
      //   regex: /```json[\s\S]*```/,
      //   description: 'Response must contain a JSON code block',
      // });
      
      vi.mocked(generateModule.generateText).mockResolvedValue({
        type: 'assistant',
        content: 'Here is your data:\n```json\n{"name": "John", "age": 30}\n```',
        metadata: createMetadata(),
      });
      
      const generateOptions = createGenerateOptions({
        provider: {
          type: 'openai',
          apiKey: process.env.OPENAI_API_KEY || 'sk-dummy-key',
          modelName: 'gpt-4o-mini',
        },
      });
      
      const chat = new LinearTemplate()
        .addSystem("You must respond with JSON.")
        .addUser("Give me some user data")
        .addAssistant(generateOptions);
      
      const session = await chat.execute(createSession());
      
      expect(session.messages[2].type).toBe('assistant');
      expect(session.messages[2].content).toContain('```json');
    });
    
  });
});
