import { describe, it, expect } from 'vitest';
import { createSession } from '../../session';
import type { Message } from '../../message';

import { createMetadata } from '../../taggedRecord';

function createUserMessage(content: string): Message {
  return {
    type: 'user',
    content,
    metadata: createMetadata(),
  };
}
function createSystemMessage(content: string): Message {
  return {
    type: 'system',
    content,
    metadata: createMetadata(),
  };
}

function createMessage(
  type: 'user' | 'assistant' | 'system',
  content: string,
): Message {
  return {
    type,
    content,
    metadata: createMetadata(),
  };
}

describe('Session', () => {
  it('should create empty session', () => {
    const session = createSession();
    expect(session.messages).toHaveLength(0);
    expect(session.contextSize).toBe(0);
  });

  it('should create session with initial messages', () => {
    const messages = [
      createSystemMessage('System message'),
      createUserMessage('User message'),
    ];
    const session = createSession({ messages });
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].content).toBe('System message');
  });

  it('should add messages immutably', () => {
    const session = createSession();
    const newMessage = createUserMessage('Test message');
    const newSession = session.addMessage(newMessage);

    expect(session.messages).toHaveLength(0);
    expect(newSession.messages).toHaveLength(1);
    expect(newSession.messages[0].content).toBe('Test message');
  });

  it('should update metadata immutably', () => {
    type TestMetadata = Record<string, unknown> & {
      initial: boolean;
      added?: string;
    };

    const session = createSession<TestMetadata>({
      context: { initial: true },
    });
    const newSession = session.setContextValues({ added: 'value' });

    expect(session.getContextValue('initial')).toBe(true);
    expect(session.getContextValue('added')).toBeUndefined();
    expect(newSession.getContextValue('initial')).toBe(true);
    expect(newSession.getContextValue('added')).toBe('value');
  });

  it('should get messages by type', () => {
    const messages = [
      createSystemMessage('System message'),
      createUserMessage('User message 1'),
      createMessage('assistant', 'Assistant message'),
      createUserMessage('User message 2'),
    ];
    const session = createSession({ messages });

    const userMessages = session.getMessagesByType('user');
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0].content).toBe('User message 1');
    expect(userMessages[1].content).toBe('User message 2');
  });

  it('should validate session state', () => {
    const validSession = createSession({
      messages: [
        createSystemMessage('System message'),
        createUserMessage('User message'),
      ],
    });

    expect(() => validSession.validate()).not.toThrow();

    const emptySession = createSession();
    expect(() => emptySession.validate()).toThrow(
      'Session must have at least one message',
    );

    const multipleSystemMessages = createSession({
      messages: [
        createSystemMessage('System 1'),
        createUserMessage('User'),
        createSystemMessage('System 2'),
      ],
    });
    expect(() => multipleSystemMessages.validate()).toThrow(
      'Only one system message is allowed',
    );

    const systemNotFirst = createSession({
      messages: [createUserMessage('User'), createSystemMessage('System')],
    });
    expect(() => systemNotFirst.validate()).toThrow(
      'System message must be at the beginning',
    );
  });

  it('should serialize to JSON', () => {
    const messages = [createSystemMessage('Test')];
    const context = { key: 'value' };
    const session = createSession({ messages, context });

    const json = session.toJSON();
    expect(json).toEqual({
      messages,
      context: { ...context, _type: 'context' },
      print: false,
    });
  });

  it('should deserialize from JSON', () => {
    const data = {
      messages: [createSystemMessage('Test')],
      context: { key: 'value' },
    };

    const session = createSession(data);
    expect(session.messages).toEqual(data.messages);
    expect(session.getContextObject()).toEqual({
      ...data.context,
      _type: 'context',
    });
  });

  it('should create session with type inference', () => {
    type TestMetadata = Record<string, unknown> & {
      userId: number;
      settings: {
        theme: string;
      };
    };

    const metadata: TestMetadata = {
      userId: 123,
      settings: { theme: 'dark' },
    };

    const session = createSession({ context: metadata });
    expect(session.getContextValue('userId')).toBe(123);
    expect(session.getContextValue('settings')).toEqual({ theme: 'dark' });
  });

  it('should handle optional parameters', () => {
    const session1 = createSession();
    expect(session1.messages).toHaveLength(0);
    expect(session1.contextSize).toBe(0);
    expect(session1.print).toBe(false);

    const session2 = createSession({ messages: [createUserMessage('Test')] });
    expect(session2.messages).toHaveLength(1);
    expect(session2.contextSize).toBe(0);
    expect(session2.print).toBe(false);

    const session3 = createSession({ context: { test: true } });
    expect(session3.messages).toHaveLength(0);
    expect(session3.getContextValue('test')).toBe(true);
    expect(session3.print).toBe(false);
  });

  it('should handle print option', () => {
    const session = createSession({ print: true });
    expect(session.print).toBe(true);
  });

  it('should maintain print setting through immutable operations', () => {
    const session = createSession({ print: true });
    const newSession = session
      .addMessage(createUserMessage('Test'))
      .setContextValues({ test: true });

    expect(session.print).toBe(true);
    expect(newSession.print).toBe(true);
  });

  it('should include print in JSON representation', () => {
    const session = createSession({ print: true });
    const json = session.toJSON();
    expect(json).toHaveProperty('print', true);
  });
});
