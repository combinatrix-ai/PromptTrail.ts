import { describe, it, expect } from 'vitest';
import { createSession } from '../../session';
import {
  createMessage,
  createSystemMessage,
  createUserMessage,
} from '../utils';

describe('Session', () => {
  it('should create empty session', () => {
    const session = createSession();
    expect(session.messages).toHaveLength(0);
    expect(session.metadata.size).toBe(0);
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
      metadata: { initial: true },
    });
    const newSession = session.updateMetadata({ added: 'value' });

    expect(session.metadata.get('initial')).toBe(true);
    expect(session.metadata.get('added')).toBeUndefined();
    expect(newSession.metadata.get('initial')).toBe(true);
    expect(newSession.metadata.get('added')).toBe('value');
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
    const metadata = { key: 'value' };
    const session = createSession({ messages, metadata });

    const json = session.toJSON();
    expect(json).toEqual({
      messages,
      metadata,
      print: false,
    });
  });

  it('should deserialize from JSON', () => {
    const data = {
      messages: [createSystemMessage('Test')],
      metadata: { key: 'value' },
    };

    const session = createSession(data);
    expect(session.messages).toEqual(data.messages);
    expect(session.metadata.toObject()).toEqual(data.metadata);
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

    const session = createSession({ metadata });
    expect(session.metadata.get('userId')).toBe(123);
    expect(session.metadata.get('settings')).toEqual({ theme: 'dark' });
  });

  it('should handle optional parameters', () => {
    const session1 = createSession();
    expect(session1.messages).toHaveLength(0);
    expect(session1.metadata.size).toBe(0);
    expect(session1.print).toBe(false);

    const session2 = createSession({ messages: [createUserMessage('Test')] });
    expect(session2.messages).toHaveLength(1);
    expect(session2.metadata.size).toBe(0);
    expect(session2.print).toBe(false);

    const session3 = createSession({ metadata: { test: true } });
    expect(session3.messages).toHaveLength(0);
    expect(session3.metadata.get('test')).toBe(true);
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
      .updateMetadata({ test: true });

    expect(session.print).toBe(true);
    expect(newSession.print).toBe(true);
  });

  it('should include print in JSON representation', () => {
    const session = createSession({ print: true });
    const json = session.toJSON();
    expect(json).toHaveProperty('print', true);
  });
});
