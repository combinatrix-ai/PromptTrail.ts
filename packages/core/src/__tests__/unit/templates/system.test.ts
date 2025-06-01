import { describe, expect, it, vi } from 'vitest';
import { Session } from '../../../session';
import { Source } from '../../../source';
import { System } from '../../../templates/primitives/system';
import { CustomValidator } from '../../../validators/custom';
import { expect_messages } from '../../utils';

describe('SystemTemplate', () => {
  it('should handle ContentSource on constructor', async () => {
    // Create a mock static source
    const mockSource = Source.literal('You are a helpful assistant.');

    // Create a SystemTemplate with the source
    const template = new System(mockSource);

    // Verify the template has the content source
    expect(template.getContentSource()).toBeDefined();

    // Execute the template and verify the result
    const session = await template.execute();
    expect(session.getLastMessage()!.type).toBe('system');
    expect(session.getLastMessage()!.content).toBe(
      'You are a helpful assistant.',
    );
  });

  it('should handle text on constructor', async () => {
    // Create a SystemTemplate with a static text
    const template = new System('You are a helpful assistant.');

    // Execute the template and verify the result
    const session = await template.execute();
    expect(session.getLastMessage()!.type).toBe('system');
    expect(session.getLastMessage()!.content).toBe(
      'You are a helpful assistant.',
    );
  });

  it('should not be instantiated without ContentSource, but throw an error', async () => {
    // Create an instance of the test template
    try {
      // @ts-expect-error
      new System();
    } catch (error) {
      // Expect the error to be thrown
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('should support interpolation in static content', async () => {
    // Create a session with metadata
    const session = Session.create();
    const sessionWithRole = session.withVar('role', 'coding assistant');
    const sessionWithBoth = sessionWithRole.withVar(
      'rules',
      'be helpful and clear',
    );

    // Create a SystemTemplate with interpolated text
    const template = new System('You are a ${role}. Always ${rules}.');

    // Execute the template and verify the result
    const result = await template.execute(sessionWithBoth);
    expect(result.getLastMessage()?.content).toBe(
      'You are a coding assistant. Always be helpful and clear.',
    );
  });

  it('should work with CallbackSource', async () => {
    // Create a callback function that uses context
    const callback = vi.fn(({ context }) => {
      const role = context?.role || 'assistant';
      return Promise.resolve(`You are a ${role}. Be helpful and informative.`);
    });

    // Create a CallbackSource
    const callbackSource = Source.callback(callback);

    // Create a SystemTemplate with the callback source
    const template = new System(callbackSource);

    // Create a session with metadata
    const session = Session.create();
    const updatedSession = session.withVar('role', 'financial expert');

    // Execute the template and verify the result
    const result = await template.execute(updatedSession);
    expect(result.getLastMessage()!.type).toBe('system');
    expect(result.getLastMessage()!.content).toBe(
      'You are a financial expert. Be helpful and informative.',
    );

    // Verify the callback was called with the session context
    expect(callback).toHaveBeenCalledWith({ context: expect.anything() });
  });

  it('should validate content with a custom validator', async () => {
    // Create a custom validator that requires specific content
    const validator = new CustomValidator((content) => {
      // System prompt must contain "helpful" and "assistant"
      const hasHelpful = content.toLowerCase().includes('helpful');
      const hasAssistant = content.toLowerCase().includes('assistant');

      return hasHelpful && hasAssistant
        ? { isValid: true }
        : {
            isValid: false,
            instruction:
              'System prompt must contain the words "helpful" and "assistant"',
          };
    });

    // Create a static source with validation
    const validSource = Source.literal('You are a helpful assistant.', {
      validator,
      maxAttempts: 1,
      raiseError: true,
    });

    // Create a SystemTemplate with valid source
    const validTemplate = new System(validSource);

    // Execute the template and verify it passes validation
    const validResult = await validTemplate.execute();
    expect(validResult.getLastMessage()!.content).toBe(
      'You are a helpful assistant.',
    );

    // Create a static source with invalid content
    const invalidSource = Source.literal('You are an AI.', {
      validator,
      maxAttempts: 1,
      raiseError: true,
    });

    // Create a SystemTemplate with invalid source
    const invalidTemplate = new System(invalidSource);

    // Execute the template and verify it fails validation
    await expect(invalidTemplate.execute()).rejects.toThrow();
  });

  it('should retry validation when maxAttempts > 1', async () => {
    // Create a validator
    const validator = new CustomValidator((content) => {
      // System prompt must contain "helpful" and "assistant"
      const hasHelpful = content.toLowerCase().includes('helpful');
      const hasAssistant = content.toLowerCase().includes('assistant');

      return hasHelpful && hasAssistant
        ? { isValid: true }
        : {
            isValid: false,
            instruction:
              'System prompt must contain the words "helpful" and "assistant"',
          };
    });

    // Create a callback that returns different values on subsequent calls
    const callback = vi
      .fn()
      .mockResolvedValueOnce('You are an AI.')
      .mockResolvedValueOnce('You are a helpful assistant.');

    // Create a CallbackSource with validation options
    const callbackSource = Source.callback(callback, {
      validator,
      maxAttempts: 2,
      raiseError: true,
    });

    // Create a SystemTemplate with the callback source
    const template = new System(callbackSource);

    // Execute the template and verify it succeeds on the second attempt
    const session = await template.execute();
    expect(session.getLastMessage()!.content).toBe(
      'You are a helpful assistant.',
    );
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('should not throw error when validation fails and raiseError is false', async () => {
    // Create a validator
    const validator = new CustomValidator((content) => {
      // System prompt must contain "helpful" and "assistant"
      const hasHelpful = content.toLowerCase().includes('helpful');
      const hasAssistant = content.toLowerCase().includes('assistant');

      return hasHelpful && hasAssistant
        ? { isValid: true }
        : {
            isValid: false,
            instruction:
              'System prompt must contain the words "helpful" and "assistant"',
          };
    });

    // Create a static source with invalid content and raiseError set to false
    const invalidSource = Source.literal('You are an AI.', {
      validator,
      maxAttempts: 1,
      raiseError: false,
    });

    // Create a SystemTemplate with the invalid source
    const template = new System(invalidSource);

    // Execute the template and verify it doesn't throw an error
    const session = await template.execute();
    expect(session.getLastMessage()!.content).toBe('You are an AI.');
  });

  it('should handle a session with existing messages', async () => {
    // Create a session with an existing message
    // Create session and assign the result of addMessage back
    let session = Session.create();
    session = session.addMessage({
      type: 'user',
      content: 'Hello',
    });

    // Create a SystemTemplate
    const template = new System('You are a helpful assistant.');

    // Execute the template and verify the result
    const result = await template.execute(session);

    // Check that both messages are present
    const messages = Array.from(result.messages);
    expect(messages).toHaveLength(2);
    expect_messages(messages, [
      { type: 'user', content: 'Hello' },
      { type: 'system', content: 'You are a helpful assistant.' },
    ]);
  });

  it('should properly initialize with various constructor inputs', async () => {
    // Test with string constructor
    const template1 = new System('String initialization');
    const result1 = await template1.execute();
    expect(result1.getLastMessage()!.content).toBe('String initialization');

    // Test with StaticSource constructor
    const source = Source.literal('Source initialization');
    const template2 = new System(source);
    const result2 = await template2.execute();
    expect(result2.getLastMessage()!.content).toBe('Source initialization');
  });
});
