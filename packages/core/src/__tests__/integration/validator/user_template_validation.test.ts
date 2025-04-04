import { describe, it, expect } from 'vitest';
import { createSession } from '../../../session';
import { UserTemplate } from '../../../templates';
import { CallbackInputSource } from '../../../input_source';
import { CustomValidator } from '../../../validators/custom';

describe('UserTemplate with real API validation', () => {
  const shouldRunTest = process.env.OPENAI_API_KEY !== undefined;
  
  (shouldRunTest ? it : it.skip)('should validate and enforce short answer restriction', async () => {
    const responses = [
      'This is a very long answer that exceeds the short answer limit of 20 words. It should fail validation and trigger a retry with feedback to the user about keeping responses short.',
      'This is still too long for a short answer that should be five words or less according to our validation rules.',
      'Short answer now.'
    ];
    
    let callCount = 0;
    const inputSource = new CallbackInputSource(async () => {
      const response = responses[callCount];
      callCount++;
      return response || 'No more responses';
    });
    
    const shortAnswerValidator = new CustomValidator(
      async (input: string) => {
        const wordCount = input.split(/\s+/).filter(Boolean).length;
        return wordCount <= 5
          ? { isValid: true }
          : { 
              isValid: false, 
              instruction: `Your answer must be 5 words or less (current: ${wordCount} words)`
            };
      },
      { 
        description: 'Please provide a short answer (max 5 words)',
        maxAttempts: 3,
        raiseErrorAfterMaxAttempts: true
      }
    );
    
    const template = new UserTemplate({
      description: 'Please provide a short answer (max 5 words)',
      inputSource,
      validator: shortAnswerValidator
    });
    
    const session = await template.execute(createSession());
    
    const messages = session.getMessagesByType('user');
    expect(messages.length).toBe(3);
    
    expect(messages[0].content).toBe(responses[0]);
    
    expect(messages[1].content).toBe(responses[1]);
    
    expect(messages[2].content).toBe('Short answer now.');
    
    const systemMessages = session.getMessagesByType('system');
    expect(systemMessages.length).toBe(2);
    expect(systemMessages[0].content).toContain('Validation failed');
    expect(systemMessages[1].content).toContain('Validation failed');
  });
});
