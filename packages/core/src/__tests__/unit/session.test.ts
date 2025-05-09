import { describe, expect, it } from 'vitest';
import type { Message } from '../../message';
import { createSession } from '../../session';
import { Vars } from '../../tagged_record';

function createUserMessage(content: string): Message {
  return {
    type: 'user',
    content,
  };
}
function createSystemMessage(content: string): Message {
  return {
    type: 'system',
    content,
  };
}

function createMessage(
  type: 'user' | 'assistant' | 'system',
  content: string,
): Message {
  return {
    type,
    content,
  };
}

describe('Session', () => {
  it('should create empty session', () => {
    const session = createSession();
    expect(session.messages).toHaveLength(0);
    expect(session.varsSize).toBe(0);
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
    type TesTAttrs = Record<string, unknown> & {
      initial: boolean;
      added?: string;
    };

    const session = createSession<TesTAttrs>({
      context: { initial: true },
    });
    const newSession = session.withVars({ added: 'value' });

    expect(session.getVar('initial')).toBe(true);
    expect(session.getVar('added')).toBeUndefined();
    expect(newSession.getVar('initial')).toBe(true);
    expect(newSession.getVar('added')).toBe('value');
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

  it('should serialize to / desezialize from JSON', () => {
    const messages = [createSystemMessage('Test')];
    const context = { key: 'value' };
    const session = createSession({ messages, context });

    const json = JSON.stringify(session);
    console.log(json);
    const parsedJson = JSON.parse(json);
    expect(parsedJson).toHaveProperty('messages');
    expect(parsedJson).toHaveProperty('context');
    expect(parsedJson).toHaveProperty('print');
    expect(parsedJson.context).toEqual(context);
    // Brand Symbol is not serialized, so we need to create a new Context object
    // TODO: We need to use toMatchObject here. toEqual will fail on our current implementation
    // because the context is created with spread operator,
    // which changes the order of the properties
    expect(Vars.create(parsedJson.context)).toMatchObject(Vars.create(context));
    expect(parsedJson.messages).toEqual(session.messages);

    const sessionFromJson = createSession(parsedJson);
    expect(sessionFromJson.messages).toEqual(session.messages);
    expect(sessionFromJson.context).toMatchObject(session.context);
    expect(sessionFromJson.print).toEqual(session.print);
    expect(sessionFromJson.getVar('key')).toEqual('value');
    expect(sessionFromJson.getVar('nonexistent')).toBeUndefined();
  });

  it('should create session with type inference', () => {
    type TesTAttrs = Record<string, unknown> & {
      userId: number;
      settings: {
        theme: string;
      };
    };

    const metadata: TesTAttrs = {
      userId: 123,
      settings: { theme: 'dark' },
    };

    const session = createSession({ context: metadata });
    expect(session.getVar('userId')).toBe(123);
    expect(session.getVar('settings')).toEqual({ theme: 'dark' });
  });

  it('should handle optional parameters', () => {
    const session1 = createSession();
    expect(session1.messages).toHaveLength(0);
    expect(session1.varsSize).toBe(0);
    expect(session1.print).toBe(false);

    const session2 = createSession({ messages: [createUserMessage('Test')] });
    expect(session2.messages).toHaveLength(1);
    expect(session2.varsSize).toBe(0);
    expect(session2.print).toBe(false);

    const session3 = createSession({ context: { test: true } });
    expect(session3.messages).toHaveLength(0);
    expect(session3.getVar('test')).toBe(true);
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
      .withVars({ test: true });

    expect(session.print).toBe(true);
    expect(newSession.print).toBe(true);
  });

  it('should include print in JSON representation', () => {
    const session = createSession({ print: true });
    const json = session.toJSON();
    expect(json).toHaveProperty('print', true);
  });
});
