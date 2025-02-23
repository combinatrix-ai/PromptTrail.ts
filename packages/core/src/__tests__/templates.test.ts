import { describe, it, expect, vi } from 'vitest';
import type { Session } from '../session';
import { createSession } from '../session';
import {
  LinearTemplate,
  LoopTemplate,
  SystemTemplate,
  UserTemplate,
  AssistantTemplate,
} from '../templates';
import { DefaultInputSource, CallbackInputSource } from '../input_source';

describe('Templates', () => {
  describe('LinearTemplate with Loop', () => {
    it('should execute a math teacher conversation flow (array-based)', async () => {
      // Mock the LLM responses
      const mockLLM = {
        generate: vi
          .fn()
          .mockReturnValueOnce(
            'Dividing a number by zero is undefined in mathematics because...',
          )
          .mockReturnValueOnce('END'),
      };

      // Create the template structure
      const template = new LinearTemplate([
        new SystemTemplate({
          content: "You're a math teacher bot.",
        }),
        new LoopTemplate({
          templates: [
            new UserTemplate({
              description: "Let's ask a question to AI:",
              default: "Why can't you divide a number by zero?",
            }),
            new AssistantTemplate({
              llm: mockLLM,
            }),
            new AssistantTemplate({
              content: 'Are you satisfied?',
            }),
            new UserTemplate({
              description: 'Input:',
              default: 'Yes.',
            }),
            new AssistantTemplate({
              content:
                'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
            }),
            new AssistantTemplate({
              llm: mockLLM,
            }),
          ],
          exitCondition: (session: Session) => {
            const lastMessage = session.getLastMessage();
            return lastMessage?.content.includes('END') ?? false;
          },
        }),
      ]);

      // Create an initial session
      const session = createSession();

      // Execute the template
      const result = await template.execute(session);

      // Verify the conversation flow
      const messages = Array.from(result.messages);

      expect(
        messages.map((msg) => ({
          ...msg,
          metadata: (msg.metadata as any).toJSON(),
        })),
      ).toEqual([
        {
          type: 'system',
          content: "You're a math teacher bot.",
          metadata: {},
        },
        {
          type: 'user',
          content: "Why can't you divide a number by zero?",
          metadata: {},
        },
        {
          type: 'assistant',
          content:
            'Dividing a number by zero is undefined in mathematics because...',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'Are you satisfied?',
          metadata: {},
        },
        {
          type: 'user',
          content: 'Yes.',
          metadata: {},
        },
        {
          type: 'assistant',
          content:
            'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'END',
          metadata: {},
        },
      ]);

      // Verify LLM was called correctly
      expect(mockLLM.generate).toHaveBeenCalledTimes(2);
    });

    it('should execute a math teacher conversation flow (chaining API)', async () => {
      // Mock the LLM responses
      const mockLLM = {
        generate: vi
          .fn()
          .mockReturnValueOnce(
            'Dividing a number by zero is undefined in mathematics because...',
          )
          .mockReturnValueOnce('END'),
      };

      // Create the template structure using chaining API
      const template = new LinearTemplate()
        .addSystem("You're a math teacher bot.")
        .addLoop(
          new LoopTemplate()
            .addUser(
              "Let's ask a question to AI:",
              "Why can't you divide a number by zero?",
            )
            .addAssistant({ llm: mockLLM })
            .addAssistant('Are you satisfied?')
            .addUser('Input:', 'Yes.')
            .addAssistant(
              'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
            )
            .addAssistant({ llm: mockLLM })
            .setExitCondition(
              (session: Session) =>
                session.getLastMessage()?.content.includes('END') ?? false,
            ),
        );

      // Create an initial session
      const session = createSession();

      // Execute the template
      const result = await template.execute(session);

      // Verify the conversation flow
      const messages = Array.from(result.messages);

      expect(
        messages.map((msg) => ({
          ...msg,
          metadata: (msg.metadata as any).toJSON(),
        })),
      ).toEqual([
        {
          type: 'system',
          content: "You're a math teacher bot.",
          metadata: {},
        },
        {
          type: 'user',
          content: "Why can't you divide a number by zero?",
          metadata: {},
        },
        {
          type: 'assistant',
          content:
            'Dividing a number by zero is undefined in mathematics because...',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'Are you satisfied?',
          metadata: {},
        },
        {
          type: 'user',
          content: 'Yes.',
          metadata: {},
        },
        {
          type: 'assistant',
          content:
            'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'END',
          metadata: {},
        },
      ]);

      // Verify LLM was called correctly
      expect(mockLLM.generate).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple loop iterations when user is not satisfied', async () => {
      // Mock the LLM responses for multiple iterations
      const mockLLM = {
        generate: vi
          .fn()
          .mockReturnValueOnce('First explanation about division by zero...')
          .mockReturnValueOnce('RETRY')
          .mockReturnValueOnce('Second, more detailed explanation...')
          .mockReturnValueOnce('END'),
      };

      const template = new LinearTemplate([
        new SystemTemplate({
          content: "You're a math teacher bot.",
        }),
        new LoopTemplate({
          templates: [
            new UserTemplate({
              description: "Let's ask a question to AI:",
              default: "Why can't you divide a number by zero?",
            }),
            new AssistantTemplate({
              llm: mockLLM,
            }),
            new AssistantTemplate({
              content: 'Are you satisfied?',
            }),
            new UserTemplate({
              description: 'Input:',
              default: 'No, please explain more.',
            }),
            new AssistantTemplate({
              content:
                'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
            }),
            new AssistantTemplate({
              llm: mockLLM,
            }),
          ],
          exitCondition: (session: Session) => {
            const lastMessage = session.getLastMessage();
            return lastMessage?.content.includes('END') ?? false;
          },
        }),
      ]);

      const session = createSession();
      const result = await template.execute(session);

      // Verify multiple iterations occurred
      const messages = Array.from(result.messages);

      expect(
        messages.map((msg) => ({
          ...msg,
          metadata: (msg.metadata as any).toJSON(),
        })),
      ).toEqual([
        {
          type: 'system',
          content: "You're a math teacher bot.",
          metadata: {},
        },
        {
          type: 'user',
          content: "Why can't you divide a number by zero?",
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'First explanation about division by zero...',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'Are you satisfied?',
          metadata: {},
        },
        {
          type: 'user',
          content: 'No, please explain more.',
          metadata: {},
        },
        {
          type: 'assistant',
          content:
            'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'RETRY',
          metadata: {},
        },
        {
          type: 'user',
          content: "Why can't you divide a number by zero?",
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'Second, more detailed explanation...',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'Are you satisfied?',
          metadata: {},
        },
        {
          type: 'user',
          content: 'No, please explain more.',
          metadata: {},
        },
        {
          type: 'assistant',
          content:
            'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'END',
          metadata: {},
        },
      ]);

      // Verify LLM was called the correct number of times
      expect(mockLLM.generate).toHaveBeenCalledTimes(4);
    });
  });

  describe('UserTemplate', () => {
    it('should support string constructor', async () => {
      const template = new UserTemplate('test description');
      const session = await template.execute(createSession());
      const messages = session.getMessagesByType('user');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('');
    });

    it('should support options object constructor', async () => {
      const template = new UserTemplate({
        description: 'test description',
        default: 'default value',
      });
      const session = await template.execute(createSession());
      const messages = session.getMessagesByType('user');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('default value');
    });

    it('should support custom input source', async () => {
      const inputSource = new CallbackInputSource(async () => 'custom input');
      const template = new UserTemplate({
        description: 'test description',
        inputSource,
      });
      const session = await template.execute(createSession());
      const messages = session.getMessagesByType('user');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('custom input');
    });

    it('should validate input', async () => {
      const inputSource = new CallbackInputSource(async () => 'valid input');
      const validate = vi
        .fn()
        .mockImplementation((input: string) =>
          Promise.resolve(input === 'valid input'),
        );

      const template = new UserTemplate({
        description: 'test description',
        inputSource,
        validate,
      });

      const session = await template.execute(createSession());
      const messages = session.getMessagesByType('user');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('valid input');
      expect(validate).toHaveBeenCalledWith('valid input');
    });

    it('should call onInput callback', async () => {
      const onInput = vi.fn();
      const template = new UserTemplate({
        description: 'test description',
        default: 'test input',
        onInput,
      });

      await template.execute(createSession());
      expect(onInput).toHaveBeenCalledWith('test input');
    });
  });
});
