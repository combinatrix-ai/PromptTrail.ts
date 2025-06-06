import { describe, expect, it } from 'vitest';
import type { Message } from '../../message';
import { createSession, Session } from '../../session';

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
    // With plain objects, we can directly compare
    expect(parsedJson.context).toMatchObject(context);
    expect(parsedJson.messages).toEqual(session.messages);

    // Explicitly type the session to restore type information
    const sessionFromJson = createSession<{ key: string }>(parsedJson);
    expect(sessionFromJson.messages).toEqual(session.messages);
    expect(sessionFromJson.vars).toMatchObject(session.vars);
    expect(sessionFromJson.debug).toEqual(session.debug);
    expect(sessionFromJson.getVar('key')).toEqual('value');
    // @ts-expect-error - Testing non-existent key
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
    expect(session1.debug).toBe(false);

    const session2 = createSession({ messages: [createUserMessage('Test')] });
    expect(session2.messages).toHaveLength(1);
    expect(session2.varsSize).toBe(0);
    expect(session2.debug).toBe(false);

    const session3 = createSession({ context: { test: true } });
    expect(session3.messages).toHaveLength(0);
    expect(session3.getVar('test')).toBe(true);
    expect(session3.debug).toBe(false);
  });

  it('should handle print option', () => {
    const session = createSession({ print: true });
    expect(session.debug).toBe(true);
  });

  it('should maintain print setting through immutable operations', () => {
    const session = createSession({ print: true });
    const newSession = session
      .addMessage(createUserMessage('Test'))
      .withVars({ test: true });

    expect(session.debug).toBe(true);
    expect(newSession.debug).toBe(true);
  });

  it('should include print in JSON representation', () => {
    const session = createSession({ print: true });
    const json = session.toJSON();
    expect(json).toHaveProperty('print', true);
  });
});

describe('Session Namespace', () => {
  it('should create empty session using Session.create()', () => {
    const session = Session.create();
    expect(session.messages).toHaveLength(0);
    expect(session.varsSize).toBe(0);
    expect(session.debug).toBe(false);
  });

  it('should create session with vars using Session.create()', () => {
    const session = Session.create({
      vars: { userId: '123', name: 'John' },
    });
    expect(session.getVar('userId')).toBe('123');
    expect(session.getVar('name')).toBe('John');
    expect(session.varsSize).toBe(2);
  });

  it('should create empty session using Session.empty()', () => {
    const session = Session.empty();
    expect(session.messages).toHaveLength(0);
    expect(session.varsSize).toBe(0);
    expect(session.debug).toBe(false);
  });

  it('should create session with vars using Session.withVars()', () => {
    const session = Session.withVars({ userId: '123', name: 'John' });
    expect(session.getVar('userId')).toBe('123');
    expect(session.getVar('name')).toBe('John');
    expect(session.varsSize).toBe(2);
  });

  it('should create session with messages using Session.withMessages()', () => {
    const messages = [
      createSystemMessage('System message'),
      createUserMessage('User message'),
    ];
    const session = Session.withMessages(messages);
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].content).toBe('System message');
    expect(session.messages[1].content).toBe('User message');
  });

  it('should create session with both vars and messages using Session.withVarsAndMessages()', () => {
    const vars = { userId: '123', name: 'John' };
    const messages = [createUserMessage('Hello')];
    const session = Session.withVarsAndMessages(vars, messages);

    expect(session.getVar('userId')).toBe('123');
    expect(session.getVar('name')).toBe('John');
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('Hello');
  });

  it('should create debug session using Session.debug()', () => {
    const session = Session.debug({ vars: { debug: true } });
    expect(session.debug).toBe(true);
    expect(session.getVar('debug')).toBe(true);
  });

  it('should deserialize from JSON using Session.fromJSON()', () => {
    const jsonData = {
      messages: [createSystemMessage('Test')],
      context: { key: 'value' },
      print: false,
    };

    const session = Session.fromJSON(jsonData);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('Test');
    expect(session.getVar('key')).toBe('value');
    expect(session.debug).toBe(false);
  });

  it('should handle invalid JSON gracefully in Session.fromJSON()', () => {
    // Test error handling for invalid JSON
    expect(() =>
      Session.fromJSON({
        messages: 'not an array',
        context: { key: 'value' },
      }),
    ).toThrow('Invalid session JSON: messages must be an array');

    expect(() =>
      Session.fromJSON({
        messages: [],
        context: 'not an object',
      }),
    ).toThrow('Invalid session JSON: context must be an object');
  });

  it('should provide consistent API with proper type inference', () => {
    // Test type inference works correctly
    const session = Session.withVars({
      count: 42,
      name: 'test',
      settings: { theme: 'dark' },
    });

    // These should be properly typed
    expect(session.getVar('count')).toBe(42);
    expect(session.getVar('name')).toBe('test');
    expect(session.getVar('settings')).toEqual({ theme: 'dark' });
  });
});

describe('Session New API - Gradual Typing', () => {
  it('should create session with vars type only', () => {
    type UserContext = {
      userId: string;
      role: 'admin' | 'user';
      settings: { theme: string };
    };

    const session = Session.withVarsType<UserContext>().create({
      vars: {
        userId: '123',
        role: 'admin',
        settings: { theme: 'dark' },
      },
    });

    expect(session.getVar('userId')).toBe('123');
    expect(session.getVar('role')).toBe('admin');
    expect(session.getVar('settings')).toEqual({ theme: 'dark' });
  });

  it('should create session with attrs type only', () => {
    type MessageMeta = {
      role: string;
      hidden: boolean;
      priority: number;
    };

    const session = Session.withAttrsType<MessageMeta>().create();

    expect(session.messages).toHaveLength(0);
    expect(session.varsSize).toBe(0);
  });

  it('should create session with both vars and attrs types', () => {
    type UserContext = {
      userId: string;
      role: 'admin' | 'user';
    };

    type MessageMeta = {
      role: string;
      hidden: boolean;
    };

    const session = Session.withVarsType<UserContext>()
      .withAttrsType<MessageMeta>()
      .create({
        vars: {
          userId: '123',
          role: 'admin',
        },
      });

    expect(session.getVar('userId')).toBe('123');
    expect(session.getVar('role')).toBe('admin');
    expect(session.messages).toHaveLength(0);
  });

  it('should chain attrs type to existing vars session', () => {
    type MessageMeta = {
      role: string;
      hidden: boolean;
    };

    const session = Session.withVars({
      userId: '123',
      name: 'John',
    }).withAttrsType<MessageMeta>();

    expect(session.getVar('userId')).toBe('123');
    expect(session.getVar('name')).toBe('John');
    expect(session.messages).toHaveLength(0);
  });

  it('should create empty session with types', () => {
    type UserContext = { userId: string };
    type MessageMeta = { role: string };

    const session = Session.withVarsType<UserContext>()
      .withAttrsType<MessageMeta>()
      .empty();

    expect(session.messages).toHaveLength(0);
    expect(session.varsSize).toBe(0);
  });

  it('should create debug session with types', () => {
    type UserContext = { userId: string; debug: boolean };

    const session = Session.withVarsType<UserContext>().debug({
      vars: {
        userId: '123',
        debug: true,
      },
    });

    expect(session.debug).toBe(true);
    expect(session.getVar('userId')).toBe('123');
    expect(session.getVar('debug')).toBe(true);
  });

  it('should support mixed chaining starting with attrs', () => {
    type UserContext = { userId: string; role: string };
    type MessageMeta = { priority: number };

    const session = Session.withAttrsType<MessageMeta>()
      .withVarsType<UserContext>()
      .create({
        vars: {
          userId: '123',
          role: 'admin',
        },
      });

    expect(session.getVar('userId')).toBe('123');
    expect(session.getVar('role')).toBe('admin');
  });

  it('should allow adding attrs type to existing session instance', () => {
    type MessageMeta = { role: string; hidden: boolean };

    const originalSession = Session.create({
      vars: { userId: '123', name: 'John' },
    });

    const typedSession = originalSession.withAttrsType<MessageMeta>();

    // Should preserve existing data
    expect(typedSession.getVar('userId')).toBe('123');
    expect(typedSession.getVar('name')).toBe('John');
    expect(typedSession.messages).toHaveLength(0);

    // Original session should be unchanged
    expect(originalSession.getVar('userId')).toBe('123');
    expect(originalSession.getVar('name')).toBe('John');
  });
});
