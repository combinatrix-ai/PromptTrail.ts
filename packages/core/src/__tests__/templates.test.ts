import { describe, it, expect, vi } from 'vitest';
import type { Session } from '../session';
import type { Message } from '../types';
import { SessionImpl } from '../session';
import { LinearTemplate, LoopTemplate, SystemTemplate, UserTemplate, AssistantTemplate } from '../templates';

describe('Templates', () => {
  describe('LinearTemplate with Loop', () => {
    it('should execute a math teacher conversation flow', async () => {
      // Mock the LLM responses
      const mockLLM = {
        generate: vi.fn()
          .mockReturnValueOnce('Dividing a number by zero is undefined in mathematics because...')
          .mockReturnValueOnce('END')
      };

      // Create the template structure
      const template = new LinearTemplate([
        new SystemTemplate({
          content: "You're a math teacher bot."
        }),
        new LoopTemplate({
          templates: [
            new UserTemplate({
              description: "Let's ask a question to AI:",
              default: "Why can't you divide a number by zero?"
            }),
            new AssistantTemplate({
              llm: mockLLM
            }),
            new AssistantTemplate({
              content: "Are you satisfied?"
            }),
            new UserTemplate({
              description: "Input:",
              default: "Yes."
            }),
            new AssistantTemplate({
              content: "The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`."
            }),
            new AssistantTemplate({
              llm: mockLLM
            })
          ],
          exitCondition: (session: Session) => {
            const lastMessage = session.getLastMessage();
            return lastMessage?.content.includes('END') ?? false;
          }
        })
      ]);

      // Create an initial session
      const session = new SessionImpl();

      // Execute the template
      const result = await template.execute(session);

      // Verify the conversation flow
      const messages = Array.from(result.messages);
      expect(messages).toEqual([
        {
          type: 'system',
          content: "You're a math teacher bot.",
          metadata: {}
        },
        {
          type: 'user',
          content: "Why can't you divide a number by zero?",
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'Dividing a number by zero is undefined in mathematics because...',
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'Are you satisfied?',
          metadata: {}
        },
        {
          type: 'user',
          content: 'Yes.',
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'END',
          metadata: {}
        }
      ]);

      // Verify LLM was called correctly
      expect(mockLLM.generate).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple loop iterations when user is not satisfied', async () => {
      // Mock the LLM responses for multiple iterations
      const mockLLM = {
        generate: vi.fn()
          .mockReturnValueOnce('First explanation about division by zero...')
          .mockReturnValueOnce('RETRY')
          .mockReturnValueOnce('Second, more detailed explanation...')
          .mockReturnValueOnce('END')
      };

      const template = new LinearTemplate([
        new SystemTemplate({
          content: "You're a math teacher bot."
        }),
        new LoopTemplate({
          templates: [
            new UserTemplate({
              description: "Let's ask a question to AI:",
              default: "Why can't you divide a number by zero?"
            }),
            new AssistantTemplate({
              llm: mockLLM
            }),
            new AssistantTemplate({
              content: "Are you satisfied?"
            }),
            new UserTemplate({
              description: "Input:",
              default: "No, please explain more."
            }),
            new AssistantTemplate({
              content: "The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`."
            }),
            new AssistantTemplate({
              llm: mockLLM
            })
          ],
          exitCondition: (session: Session) => {
            const lastMessage = session.getLastMessage();
            return lastMessage?.content.includes('END') ?? false;
          }
        })
      ]);

      const session = new SessionImpl();
      const result = await template.execute(session);

      // Verify multiple iterations occurred
      const messages = Array.from(result.messages);
      expect(messages).toEqual([
        {
          type: 'system',
          content: "You're a math teacher bot.",
          metadata: {}
        },
        {
          type: 'user',
          content: "Why can't you divide a number by zero?",
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'First explanation about division by zero...',
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'Are you satisfied?',
          metadata: {}
        },
        {
          type: 'user',
          content: 'No, please explain more.',
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'RETRY',
          metadata: {}
        },
        {
          type: 'user',
          content: "Why can't you divide a number by zero?",
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'Second, more detailed explanation...',
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'Are you satisfied?',
          metadata: {}
        },
        {
          type: 'user',
          content: 'No, please explain more.',
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
          metadata: {}
        },
        {
          type: 'assistant',
          content: 'END',
          metadata: {}
        }
      ]);

      // Verify LLM was called the correct number of times
      expect(mockLLM.generate).toHaveBeenCalledTimes(4);
    });
  });
});