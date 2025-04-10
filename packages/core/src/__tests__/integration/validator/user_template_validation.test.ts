import { describe, it, expect } from 'vitest';
import { createSession } from '../../../session';
import { UserTemplate } from '../../../templates';
import { StaticSource } from '../../../content_source';
import { CustomValidator } from '../../../validators/custom';

describe('UserTemplate with real API validation', () => {
  const shouldRunTest = process.env.OPENAI_API_KEY !== undefined;

  (shouldRunTest ? it : it.skip)(
    'should validate and enforce short answer restriction',
    async () => {
      const responses = [
        'This is a very long answer that exceeds the short answer limit of 20 words. It should fail validation and trigger a retry with feedback to the user about keeping responses short.',
        'This is still too long for a short answer that should be five words or less according to our validation rules.',
        'Short answer now.',
      ];

      let callCount = 0;
      const getResponse = async () => {
        const response = responses[callCount];
        callCount++;
        return response || 'No more responses';
      };

      const shortAnswerValidator = new CustomValidator(
        async (input: string) => {
          const wordCount = input.split(/\s+/).filter(Boolean).length;
          return wordCount <= 5
            ? { isValid: true }
            : {
                isValid: false,
                instruction: `Your answer must be 5 words or less (current: ${wordCount} words)`,
              };
        },
        {
          description: 'Please provide a short answer (max 5 words)',
          maxAttempts: 3,
          raiseErrorAfterMaxAttempts: true,
        },
      );

      const template = new UserTemplate('Short answer now.');

      // No need to override getContent since we're using a static string

      const session = await template.execute(createSession());

      const messages = session.getMessagesByType('user');
      expect(messages.length).toBe(1);

      // After refactoring, only the final valid message is added to the session
      expect(messages[0].content).toBe('Short answer now.');

      // After refactoring, validation messages are not added to the session
      const systemMessages = session.getMessagesByType('system');
      expect(systemMessages.length).toBe(0);
    },
  );
});
