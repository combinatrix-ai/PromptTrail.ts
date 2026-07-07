import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Message } from '../../message';
import { createSession, Session, SessionBuilder } from '../../session';

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
    expect(session.version).toBe(0);
  });

  it('should add messages immutably', () => {
    const session = createSession();
    const newMessage = createUserMessage('Test message');
    const newSession = session.addMessage(newMessage);

    expect(session.messages).toHaveLength(0);
    expect(session.version).toBe(0);
    expect(newSession.messages).toHaveLength(1);
    expect(newSession.messages[0].content).toBe('Test message');
    expect(newSession.version).toBe(1);
  });

  it('should update vars immutably', () => {
    type TestVars = Record<string, unknown> & {
      initial: boolean;
      added?: string;
    };

    const session = createSession<TestVars>({
      context: { initial: true },
    });
    const newSession = session.withVars({ added: 'value' });

    expect(session.getVar('initial')).toBe(true);
    expect(session.getVar('added')).toBeUndefined();
    expect(newSession.getVar('initial')).toBe(true);
    expect(newSession.getVar('added')).toBe('value');
    expect(session.version).toBe(0);
    expect(newSession.version).toBe(1);
  });

  it('should advance version monotonically for message and vars changes', () => {
    const session = createSession({
      messages: [createUserMessage('Initial')],
      context: { count: 0 },
    });
    const withMessage = session.addMessage(createUserMessage('Next'));
    const withVar = withMessage.withVar('count', 1);
    const withVars = withVar.withVars({ done: true });

    expect(session.version).toBe(0);
    expect(withMessage.version).toBe(1);
    expect(withVar.version).toBe(2);
    expect(withVars.version).toBe(3);
  });

  it('reads the latest structured payload typed by its schema', () => {
    const choiceSchema = z.object({
      reply: z.string(),
      choices: z.array(z.object({ id: z.string(), label: z.string() })),
    });
    const payload = {
      reply: 'Pick one.',
      choices: [{ id: 'a', label: 'Option A' }],
    };
    const session = createSession({
      messages: [
        {
          type: 'assistant',
          content: ' ',
          structuredContent: payload,
        },
        createUserMessage('a'),
      ],
    });

    const parsed = session.getStructured(choiceSchema);
    expect(parsed).toEqual(payload);
    // Typed: the inference flows from the schema, not from a cast.
    parsed?.choices[0].id satisfies string | undefined;

    expect(createSession({}).getStructured(choiceSchema)).toBeUndefined();
    expect(() =>
      session.getStructured(z.object({ totally: z.number() })),
    ).toThrow(/getStructured schema mismatch/);
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

  it('should detect pending assistant tool calls on the latest message', () => {
    const session = createSession()
      .addMessage({
        type: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { id: '1' } }],
      })
      .addMessage({
        type: 'tool_result',
        content: 'done',
        toolCallId: 'call-1',
      });

    expect(createSession().hasToolCalls()).toBe(false);
    expect(
      createSession()
        .addMessage({
          type: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { id: '1' } }],
        })
        .hasToolCalls(),
    ).toBe(true);
    expect(session.hasToolCalls()).toBe(false);
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
    expect(parsedJson).toHaveProperty('version', 0);
    expect(parsedJson.context).toEqual(context);
    // With plain objects, we can directly compare
    expect(parsedJson.context).toMatchObject(context);
    expect(parsedJson.messages).toEqual(session.messages);

    // Explicitly type the session to restore type information
    const sessionFromJson = createSession<{ key: string }>(parsedJson);
    expect(sessionFromJson.messages).toEqual(session.messages);
    expect(sessionFromJson.vars).toMatchObject(session.vars);
    expect(sessionFromJson.print).toEqual(session.print);
    expect(sessionFromJson.getVar('key')).toEqual('value');
    // @ts-expect-error - Testing non-existent key
    expect(sessionFromJson.getVar('nonexistent')).toBeUndefined();
  });

  it('should omit inline content part bytes from immutable sessions', () => {
    const session = createSession({
      messages: [
        {
          type: 'user',
          content: 'Inspect this.',
          contentParts: [
            { kind: 'text', text: 'Inspect this.' },
            {
              kind: 'image',
              mimeType: 'image/png',
              filename: 'chart.png',
              source: { type: 'bytes', data: new Uint8Array([1, 2, 3]) },
            },
          ],
        },
      ],
    });

    const expectedContentParts = [
      { kind: 'text', text: 'Inspect this.' },
      {
        kind: 'image',
        mimeType: 'image/png',
        filename: 'chart.png',
        source: {
          type: 'uri',
          uri: 'prompttrail://omitted-bytes/chart.png',
        },
      },
    ];

    expect(session.messages[0].contentParts).toEqual(expectedContentParts);
    expect(
      JSON.parse(JSON.stringify(session)).messages[0].contentParts,
    ).toEqual(expectedContentParts);
  });

  it('should create session with type inference', () => {
    type TestVars = Record<string, unknown> & {
      userId: number;
      settings: {
        theme: string;
      };
    };

    const metadata: TestVars = {
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

describe('Session Namespace', () => {
  it('should create empty session using Session.create()', () => {
    const session = Session.create();
    expect(session.messages).toHaveLength(0);
    expect(session.varsSize).toBe(0);
    expect(session.print).toBe(false);
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
    expect(session.print).toBe(false);
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
    expect(session.print).toBe(true);
    expect(session.getVar('debug')).toBe(true);
  });

  it('should deserialize from JSON using Session.fromJSON()', () => {
    const original = Session.create({
      messages: [createSystemMessage('Test')],
      vars: { key: 'value' },
      print: false,
    }).withVar('updated', true);
    const jsonData = original.toJSON();

    const session = Session.fromJSON(jsonData);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('Test');
    expect(session.getVar('key')).toBe('value');
    expect(session.getVar('updated')).toBe(true);
    expect(session.print).toBe(false);
    expect(session.version).toBe(original.version);
  });

  it('should round-trip current JSON byte-identically', () => {
    const original = Session.create({
      messages: [
        {
          type: 'tool_result',
          content: 'done',
          toolCallId: 'call-1',
          attrs: { provider: 'current' },
        },
      ],
      vars: { key: 'value' },
      print: true,
    }).withVar('updated', true);
    const jsonData = original.toJSON();
    const revived = Session.fromJSON(jsonData);

    expect(JSON.stringify(revived.toJSON())).toBe(JSON.stringify(jsonData));
  });

  it('should promote legacy attrs toolCallId when deserializing tool results', () => {
    const session = Session.fromJSON({
      messages: [
        {
          type: 'tool_result',
          content: 'done',
          attrs: { toolCallId: 'call-1', provider: 'legacy' },
        },
      ],
      context: {},
    });

    const message = session.getLastMessage();
    expect(message).toMatchObject({
      type: 'tool_result',
      content: 'done',
      toolCallId: 'call-1',
      attrs: { toolCallId: 'call-1', provider: 'legacy' },
    });
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

    expect(() =>
      Session.fromJSON({
        messages: [],
        version: -1,
      }),
    ).toThrow('Invalid session JSON: version must be a non-negative integer');
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

describe('Session New API - Vars Typing', () => {
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

  it('should create empty session with vars type', () => {
    type UserContext = {
      userId: string;
      role: 'admin' | 'user';
    };

    const session = Session.withVarsType<UserContext>().empty();

    expect(session.messages).toHaveLength(0);
    expect(session.varsSize).toBe(0);
  });

  it('should infer vars from existing vars session', () => {
    const session = Session.withVars({
      userId: '123',
      name: 'John',
    });

    expect(session.getVar('userId')).toBe('123');
    expect(session.getVar('name')).toBe('John');
    expect(session.messages).toHaveLength(0);
  });

  it('should create empty session with types', () => {
    type UserContext = { userId: string };

    const session = Session.withVarsType<UserContext>().empty();

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

    expect(session.print).toBe(true);
    expect(session.getVar('userId')).toBe('123');
    expect(session.getVar('debug')).toBe(true);
  });

  it('should support chaining vars type on a builder', () => {
    type UserContext = { userId: string; role: string };

    const session = new SessionBuilder().withVarsType<UserContext>().create({
      vars: {
        userId: '123',
        role: 'admin',
      },
    });

    expect(session.getVar('userId')).toBe('123');
    expect(session.getVar('role')).toBe('admin');
  });
});
