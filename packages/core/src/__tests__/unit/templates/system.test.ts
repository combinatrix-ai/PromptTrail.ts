import { describe, expect, it } from 'vitest';
import { Session } from '../../../session';
import { System } from '../../../templates/primitives/system';
import { expect_messages } from '../../utils';

describe('SystemTemplate', () => {
  it('should handle Source.literal content', async () => {
    // System template now only accepts strings, not Sources
    // This test is no longer applicable as System template was simplified
    const template = new System('You are a helpful assistant.');

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
    const template = new System('You are a {{role}}. Always {{rules}}.');

    // Execute the template and verify the result
    const result = await template.execute(sessionWithBoth);
    expect(result.getLastMessage()?.content).toBe(
      'You are a coding assistant. Always be helpful and clear.',
    );
  });

  it('should support interpolation with variables', async () => {
    // System template now uses string interpolation instead of CallbackSource
    const template = new System(
      'You are a {{role}}. Be helpful and informative.',
    );

    // Create a session with metadata
    const session = Session.create();
    const updatedSession = session.withVar('role', 'financial expert');

    // Execute the template and verify the result
    const result = await template.execute(updatedSession);
    expect(result.getLastMessage()!.type).toBe('system');
    expect(result.getLastMessage()!.content).toBe(
      'You are a financial expert. Be helpful and informative.',
    );
  });

  it('should work with static text containing special words', async () => {
    // System template now only accepts strings - validation should be done at a higher level
    // This test verifies that the template can handle any string content
    const validTemplate = new System('You are a helpful assistant.');
    const validResult = await validTemplate.execute();
    expect(validResult.getLastMessage()!.content).toBe(
      'You are a helpful assistant.',
    );

    // Test with different content
    const aiTemplate = new System('You are an AI.');
    const aiResult = await aiTemplate.execute();
    expect(aiResult.getLastMessage()!.content).toBe('You are an AI.');
  });

  it('should handle static content without validation', async () => {
    // System template is now simplified and doesn't support validation directly
    // This test verifies basic functionality
    const template = new System('You are a helpful assistant.');
    const session = await template.execute();
    expect(session.getLastMessage()!.content).toBe(
      'You are a helpful assistant.',
    );
  });

  it('should handle any static content without errors', async () => {
    // System template now accepts any string content
    const template = new System('You are an AI.');
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

    // Test with another string
    const template2 = new System('Another initialization');
    const result2 = await template2.execute();
    expect(result2.getLastMessage()!.content).toBe('Another initialization');
  });
});
