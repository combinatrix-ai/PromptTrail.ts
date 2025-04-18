import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Assistant } from '../../../templates/assistant';
import { createSession } from '../../../session';
import { createMetadata } from '../../../metadata';
import { generateText } from '../../../generate';
import { User } from '../../../templates/user';
import { Conditional } from '../../../templates/conditional';
import type { Session } from '../../../types';
import { Sequence } from '../../../templates/sequence';

// Mock the generate module
vi.mock('../../../generate', () => ({
  generateText: vi.fn(),
}));

describe('If Template', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Set up default mock for generateText
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'Mock response',
      metadata: createMetadata(),
    });
  });

  it('should execute thenTemplate when condition is true', async () => {
    // Create a condition that always returns true
    const condition = () => true;

    // Create then and else templates
    const thenTemplate = new User('Then branch executed');
    const elseTemplate = new User('Else branch executed');

    // Create an if template
    const ifTemplate = new Conditional({
      condition,
      thenTemplate,
      elseTemplate,
    });

    // Execute the template and verify the result
    const session = await ifTemplate.execute(createSession());

    // Verify the then branch was executed
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('user');
    expect(messages[0].content).toBe('Then branch executed');
  });

  it('should execute elseTemplate when condition is false', async () => {
    // Create a condition that always returns false
    const condition = () => false;

    // Create then and else templates
    const thenTemplate = new User('Then branch executed');
    const elseTemplate = new User('Else branch executed');

    // Create an if template
    const ifTemplate = new Conditional({
      condition,
      thenTemplate,
      elseTemplate,
    });

    // Execute the template and verify the result
    const session = await ifTemplate.execute(createSession());

    // Verify the else branch was executed
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('user');
    expect(messages[0].content).toBe('Else branch executed');
  });

  it('should return unchanged session when condition is false and no elseTemplate provided', async () => {
    // Create a condition that always returns false
    const condition = () => false;

    // Create a then template
    const thenTemplate = new User('Then branch executed');

    // Create an if template without an else branch
    const ifTemplate = new Conditional({
      condition,
      thenTemplate,
      // No elseTemplate
    });

    // Create a session with an existing message
    const initialSession = createSession().addMessage({
      type: 'system',
      content: 'Initial message',
      metadata: createMetadata(),
    });

    // Execute the template and verify the result
    const resultSession = await ifTemplate.execute(initialSession);

    // Verify the session was returned unchanged
    const messages = Array.from(resultSession.messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('Initial message');
  });

  it('should handle complex conditions using session data', async () => {
    // Create a session with metadata
    const session = createSession();
    session.metadata.set('userRole', 'admin');

    // Create a condition that checks metadata
    const condition = (session: Session) => {
      return session.metadata.get('userRole') === 'admin';
    };

    // Create then and else templates
    const thenTemplate = new User('Admin access granted');
    const elseTemplate = new User('Access denied');

    // Create an if template
    const ifTemplate = new Conditional({
      condition,
      thenTemplate,
      elseTemplate,
    });

    // Execute the template and verify the result
    const resultSession = await ifTemplate.execute(session);

    // Verify the then branch was executed (admin access)
    const messages = Array.from(resultSession.messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Admin access granted');

    // Now test with a different role
    const userSession = createSession();
    userSession.metadata.set('userRole', 'user');

    // Execute the template with user role
    const userResultSession = await ifTemplate.execute(userSession);

    // Verify the else branch was executed (access denied)
    const userMessages = Array.from(userResultSession.messages);
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe('Access denied');
  });

  it('should handle conditions based on message content', async () => {
    // Create a session with a message
    const session = createSession().addMessage({
      type: 'user',
      content: 'Hello, how are you?',
      metadata: createMetadata(),
    });

    // Create a condition that checks if the last message contains a greeting
    const condition = (session: Session) => {
      const lastMessage = session.getLastMessage();
      return lastMessage?.content.toLowerCase().includes('hello') || false;
    };

    // Create then and else templates
    const thenTemplate = new Assistant('Hello! I am an AI assistant.');
    const elseTemplate = new Assistant('I did not understand your message.');

    // Create an if template
    const ifTemplate = new Conditional({
      condition,
      thenTemplate,
      elseTemplate,
    });

    // Execute the template and verify the result
    const resultSession = await ifTemplate.execute(session);

    // Verify the then branch was executed (greeting response)
    const messages = Array.from(resultSession.messages);
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('user');
    expect(messages[1].type).toBe('assistant');
    expect(messages[1].content).toBe('Hello! I am an AI assistant.');

    // Now test with a non-greeting message
    const questionSession = createSession().addMessage({
      type: 'user',
      content: 'What is the weather today?',
      metadata: createMetadata(),
    });

    // Execute the template with the question
    const questionResultSession = await ifTemplate.execute(questionSession);

    // Verify the else branch was executed (not understood)
    const questionMessages = Array.from(questionResultSession.messages);
    expect(questionMessages).toHaveLength(2);
    expect(questionMessages[1].content).toBe(
      'I did not understand your message.',
    );
  });

  it('should handle nested templates in both branches', async () => {
    // Create a condition
    const condition = () => true;

    // Create complex nested templates for both branches
    const thenTemplate = new Sequence()
      .addSystem('System message in then branch')
      .addUser('User message in then branch');

    const elseTemplate = new Sequence()
      .addSystem('System message in else branch')
      .addUser('User message in else branch');

    // Create an if template
    const ifTemplate = new Conditional({
      condition,
      thenTemplate,
      elseTemplate,
    });

    // Execute the template and verify the result
    const resultSession = await ifTemplate.execute(createSession());

    // Verify the then branch sequence was executed
    const messages = Array.from(resultSession.messages);
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('System message in then branch');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('User message in then branch');

    // Test the else branch too by changing the condition
    const elseCondition = () => false;

    const elseIfTemplate = new Conditional({
      condition: elseCondition,
      thenTemplate,
      elseTemplate,
    });

    const elseResultSession = await elseIfTemplate.execute(createSession());

    // Verify the else branch sequence was executed
    const elseMessages = Array.from(elseResultSession.messages);
    expect(elseMessages).toHaveLength(2);
    expect(elseMessages[0].type).toBe('system');
    expect(elseMessages[0].content).toBe('System message in else branch');
    expect(elseMessages[1].type).toBe('user');
    expect(elseMessages[1].content).toBe('User message in else branch');
  });

  it('should handle nested if templates', async () => {
    // Create a session with metadata
    const session = createSession();
    session.metadata.set('userRole', 'admin');
    session.metadata.set('isAuthenticated', true);

    // Create a nested if template structure
    const innerIfTemplate = new Conditional({
      condition: (session) => session.metadata.get('isAuthenticated') === true,
      thenTemplate: new User('User is authenticated'),
      elseTemplate: new User('User is not authenticated'),
    });

    const outerIfTemplate = new Conditional({
      condition: (session) => session.metadata.get('userRole') === 'admin',
      thenTemplate: new Sequence()
        .addUser('Admin role detected')
        .add(innerIfTemplate),
      elseTemplate: new User('Not an admin'),
    });

    // Execute the template and verify the result
    const resultSession = await outerIfTemplate.execute(session);

    // Verify the correct branches were executed
    const messages = Array.from(resultSession.messages);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Admin role detected');
    expect(messages[1].content).toBe('User is authenticated');

    // Test with different metadata combinations
    const unauthSession = createSession();
    unauthSession.metadata.set('userRole', 'admin');
    unauthSession.metadata.set('isAuthenticated', false);

    const unauthResultSession = await outerIfTemplate.execute(unauthSession);
    const unauthMessages = Array.from(unauthResultSession.messages);
    expect(unauthMessages).toHaveLength(2);
    expect(unauthMessages[0].content).toBe('Admin role detected');
    expect(unauthMessages[1].content).toBe('User is not authenticated');

    const nonAdminSession = createSession();
    nonAdminSession.metadata.set('userRole', 'user');
    nonAdminSession.metadata.set('isAuthenticated', true);

    const nonAdminResultSession =
      await outerIfTemplate.execute(nonAdminSession);
    const nonAdminMessages = Array.from(nonAdminResultSession.messages);
    expect(nonAdminMessages).toHaveLength(1);
    expect(nonAdminMessages[0].content).toBe('Not an admin');
  });

  it('should update and maintain session metadata through conditional branches', async () => {
    // Create a condition
    const condition = () => true;

    // Create then template that updates metadata
    const thenTemplate = new Sequence()
      .addUser('Setting metadata in then branch')
      .addTransform((session) => {
        return session.updateMetadata({ branchTaken: 'then' });
      });

    // Create else template that updates metadata differently
    const elseTemplate = new Sequence()
      .addUser('Setting metadata in else branch')
      .addTransform((session) => {
        return session.updateMetadata({ branchTaken: 'else' });
      });

    // Create an if template
    const ifTemplate = new Conditional({
      condition,
      thenTemplate,
      elseTemplate,
    });

    // Execute the template and verify the result
    const resultSession = await ifTemplate.execute(createSession());

    // Verify both the message and metadata updates
    const messages = Array.from(resultSession.messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Setting metadata in then branch');
    expect(resultSession.metadata.get('branchTaken')).toBe('then');

    // Test with the else branch
    const elseCondition = () => false;

    const elseIfTemplate = new Conditional({
      condition: elseCondition,
      thenTemplate,
      elseTemplate,
    });

    const elseResultSession = await elseIfTemplate.execute(createSession());

    expect(elseResultSession.metadata.get('branchTaken')).toBe('else');
  });

  it('should handle dynamically determined template paths', async () => {
    // Create a session with a message type parameter
    const session = createSession();
    session.metadata.set('messageType', 'greeting');

    // Create templates for different message types
    const greetingTemplate = new User('Hello, nice to meet you!');
    const questionTemplate = new User('I have a question for you.');
    const statementTemplate = new User('Here is some information.');

    // Create a complex if-else chain using nested IFs to simulate a switch statement
    const messageTypeHandler = new Conditional({
      condition: (session) =>
        session.metadata.get('messageType') === 'greeting',
      thenTemplate: greetingTemplate,
      elseTemplate: new Conditional({
        condition: (session) =>
          session.metadata.get('messageType') === 'question',
        thenTemplate: questionTemplate,
        elseTemplate: statementTemplate, // default case
      }),
    });

    // Execute the template and verify the result
    const resultSession = await messageTypeHandler.execute(session);

    // Verify the greeting template was used
    const messages = Array.from(resultSession.messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Hello, nice to meet you!');

    // Try with a different message type
    const questionSession = createSession();
    questionSession.metadata.set('messageType', 'question');

    const questionResultSession =
      await messageTypeHandler.execute(questionSession);
    const questionMessages = Array.from(questionResultSession.messages);
    expect(questionMessages[0].content).toBe('I have a question for you.');

    // Try with an undefined message type (should use the default)
    const defaultSession = createSession();
    defaultSession.metadata.set('messageType', 'unknown');

    const defaultResultSession =
      await messageTypeHandler.execute(defaultSession);
    const defaultMessages = Array.from(defaultResultSession.messages);
    expect(defaultMessages[0].content).toBe('Here is some information.');
  });
});
