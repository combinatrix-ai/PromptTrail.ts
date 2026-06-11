import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from '../../../generate';
import { Session } from '../../../session';
import { Source } from '../../../source';
import { Attrs, Vars } from '../../../session';
import {
  Agent,
  Assistant,
  Loop,
  Subroutine,
  System,
  Transform,
  User,
} from '../../../templates';

// Mock the generate module
vi.mock('../../../generate', () => ({
  generateText: vi.fn(),
}));

describe('SubroutineTemplate', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Set up default mock for generateText
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'Mock response',
    });
  });

  // Original functionality tests

  it('should execute a simple subroutine and merge results by default', async () => {
    // Create a subroutine template with a simple sequence
    const subroutine = new Subroutine(
      Agent.create('subroutine-template')
        .system('You are a helpful assistant.')
        .user('What is your name?')
        .assistant('I am an AI assistant.'),
    );

    // Execute the subroutine
    const session = await subroutine.execute();

    // Verify the messages were added
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('You are a helpful assistant.');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('What is your name?');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('I am an AI assistant.');
  });

  it('should keep parent context by default', async () => {
    // Create a subroutine that updates context
    const subroutine = new Subroutine(
      Agent.create('subroutine-template')
        .user('Extract information')
        .assistant('Information extracted')
        .transform((session: Session<any>) => {
          return session.withVars({
            extractedData: { name: 'Alice', age: 30 },
          }) as Session<any>;
        }),
    );

    // Execute the subroutine
    const session = await subroutine.execute();

    // Verify subroutine vars were isolated from the parent result.
    expect(session.getVar('extractedData')).toBeUndefined();
  });

  it('should support custom squash projections for messages', async () => {
    const hideMessagesSubroutine = new Subroutine(
      Agent.create('subroutine-template')
        .system('Internal system message')
        .user('Internal user message')
        .assistant('Internal assistant message'),
      { squash: (parent) => parent },
    );

    // Execute the subroutine
    const hideMessagesSession = await hideMessagesSubroutine.execute();

    // Verify no messages were retained by the custom squash.
    const hideMessages = Array.from(hideMessagesSession.messages);
    expect(hideMessages).toHaveLength(0); // Parent session was empty

    const showMessagesSubroutine = new Subroutine(
      Agent.create('subroutine-template')
        .system('Visible system message')
        .user('Visible user message')
        .assistant('Visible assistant message'),
    );

    // Execute the subroutine
    const showMessagesSession = await showMessagesSubroutine.execute();

    // Verify messages were retained by default.
    const showMessages = Array.from(showMessagesSession.messages);
    expect(showMessages).toHaveLength(3);
  });

  it('should isolate parent session context by default', async () => {
    type SharedContext = Vars<{ userName: string }>;
    // Create a parent session with context
    const parentSession = Session.create<SharedContext, Attrs>().withVars({
      userName: 'Bob',
    });

    // Add a message to the parent session
    const sessionWithMessage = parentSession.addMessage({
      type: 'system',
      content: 'Parent system message',
    });

    // Create a subroutine that tries to use parent context.
    const subroutine = new Subroutine<Attrs, SharedContext>(
      Agent.create<SharedContext>('subroutine-template')
        .user(
          new (class extends Source<string> {
            async getContent(session: Session<SharedContext>) {
              return `Hello, ${session.getVar('userName')}!`;
            }
          })(),
        )
        .assistant('Nice to meet you!'),
    );

    // Execute the subroutine with the parent session
    const resultSession = await subroutine.execute(sessionWithMessage);

    // Verify the messages (parent + new)
    const messages = Array.from(resultSession.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('Parent system message');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Hello, undefined!');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('Nice to meet you!');
    // Verify parent context is still there in the parent result.
    expect(resultSession.getVar('userName')).toBe('Bob');
  });

  it('should allow transformers within the subroutine template', async () => {
    // Mock a more complex response with data to extract
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'The weather in Tokyo is 25°C and sunny.',
    });

    // Create a subroutine with a transformer *inside* the Sequence
    const subroutine = new Subroutine(
      Agent.create('subroutine-template')
        .user('What is the weather in Tokyo?')
        .assistant(Source.llm())
        .transform((session: Session<any>) => {
          const lasMessage = session.getLastMessage();
          const content = lasMessage?.content || '';
          const tempMatch = content.match(/(\d+)°C/);
          const temperature = tempMatch ? parseInt(tempMatch[1]) : null;
          const weatherMatch = content.match(/(sunny|cloudy|rainy|snowy)/i);
          const weatherCondition = weatherMatch
            ? weatherMatch[1].toLowerCase()
            : null;
          return session.withVars({
            weatherData: {
              location: 'Tokyo',
              temperature,
              condition: weatherCondition,
            },
          }) as Session<any>;
        }),
    );

    // Execute the subroutine
    const session = await subroutine.execute();

    // Verify the messages
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(2); // User, Assistant

    // Verify the extracted context stayed isolated from the parent result.
    const weatherData = session.getVar('weatherData') as any;
    expect(weatherData).toBeUndefined();
  });

  it('should handle nested subroutines (original style)', async () => {
    // Create an inner subroutine
    const innerSubroutine = new Subroutine(
      Agent.create('subroutine-template')
        .user('Inner subroutine question')
        .assistant('Inner subroutine answer')
        .transform((session: Session<any>) => {
          return session.withVars({
            inner: 'completed',
          }) as Session<any>;
        }),
    );

    // Create an outer subroutine that includes the inner one
    const outerSubroutine = new Subroutine(
      Agent.create('subroutine-template')
        .user('Outer subroutine start')
        .add(innerSubroutine) // Nest the subroutine
        .user('Outer subroutine end')
        .transform((session: Session<any>) => {
          return session.withVars({
            outer: 'completed',
          }) as Session<any>;
        }),
    );

    // Execute the nested subroutines
    const session = await outerSubroutine.execute();

    // Verify the messages (all should be retained by default)
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect(messages[0].content).toBe('Outer subroutine start');
    expect(messages[1].content).toBe('Inner subroutine question');
    expect(messages[2].content).toBe('Inner subroutine answer');
    expect(messages[3].content).toBe('Outer subroutine end');

    // Verify subroutine context remains isolated by default.
    expect(session.getVar('inner')).toBeUndefined();
    expect(session.getVar('outer')).toBeUndefined();
  });

  it('should support explicit init and squash projections', async () => {
    // Use Session<any> for parent to allow checking dynamic keys later if needed
    const parentSession = Session.create().withVars({
      parentData: 'visible',
    });

    const isolatedSubroutine = new Subroutine<any, any>(
      Agent.create('subroutine-template')
        .user('Testing isolated context')
        .transform((session: Session<any>) => {
          // Try to access parent context (should be undefined due to isolated context)
          const parentData = session.getVar('parentData');
          // Set new context in the isolated context
          return session.withVars({
            isolatedData: 'not visible to parent',
            parentDataVisible: parentData !== undefined, // This will be false
          }) as Session<any>;
        }),
    );

    // Execute the subroutine
    const resultSession = await isolatedSubroutine.execute(parentSession);

    // Verify the parent session received the user message by default.
    const messages = Array.from(resultSession.messages);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Testing isolated context');

    // The isolatedData should NOT be available in the result due to isolated context
    expect(resultSession.getVar('isolatedData')).toBeUndefined();

    // The parentDataVisible context (set inside isolated context) should also NOT be merged back
    expect(resultSession.getVar('parentDataVisible')).toBeUndefined();

    // Parent context should remain unchanged
    expect(resultSession.getVar('parentData')).toBe('visible');

    // --- Test explicit parent context projection ---
    const sharedSubroutine = new Subroutine<any, any>(
      Agent.create('subroutine-template')
        .user('Testing shared context')
        .transform((session: Session<any>) => {
          // Try to access parent context (should be visible via default initWith)
          const parentData = session.getVar('parentData');
          // Set new context in the shared context
          return session.withVars({
            sharedData: 'visible to parent',
            parentDataVisible: parentData !== undefined, // This will be true
          }) as Session<any>;
        }),
      {
        init: (parent) => Session.create({ vars: parent.getVarsObject() }),
        squash: (parent, subroutine) =>
          parent.withVars(subroutine.getVarsObject()),
      },
    );

    // Execute the subroutine
    const sharedResultSession = await sharedSubroutine.execute(parentSession);

    // The sharedData should be available in the result via explicit squash.
    expect(sharedResultSession.getVar('sharedData')).toBe('visible to parent');

    // The parentDataVisible should be true and merged back.
    expect(sharedResultSession.getVar('parentDataVisible')).toBe(true);

    // Parent context should still be there
    expect(sharedResultSession.getVar('parentData')).toBe('visible');
  });

  it('should use the init function when provided', async () => {
    const customInit = vi
      .fn()
      .mockImplementation((parentSession: Session<any>) => {
        // Create a new session with the context values we need
        return Session.create({
          vars: {
            userName: parentSession.getVar('userName'),
            customInit: true,
          },
        });
      });

    // Create a parent session with various context
    const parentSession = Session.create()
      .withVars({ userName: 'Charlie' })
      .withVars({ sensitiveData: 'should not be copied' });

    const subroutine = new Subroutine(
      Agent.create('subroutine-template').user(
        new (class extends Source<string> {
          async getContent(session: Session) {
            const userName = session.getVar('userName');
            const customInit = session.getVar('customInit');
            const sensitiveData = session.getVar('sensitiveData');
            return `User: ${userName}, Custom: ${customInit}, Sensitive: ${
              sensitiveData === undefined ? 'protected' : 'exposed'
            }`;
          }
        })(),
      ),
      { init: customInit },
    );

    // Execute the subroutine
    const resultSession = await subroutine.execute(parentSession);

    expect(customInit).toHaveBeenCalledWith(parentSession);

    // Verify the message reflects the custom session initialization
    const messages = Array.from(resultSession.messages);
    expect(messages).toHaveLength(1); // Only the addUser message from subroutine
    expect(messages[0].content).toBe(
      'User: Charlie, Custom: true, Sensitive: protected',
    );
    // Verify parent context was preserved but subroutine init vars were isolated.
    expect(resultSession.getVar('userName')).toBe('Charlie');
    expect(resultSession.getVar('customInit')).toBeUndefined();
    expect(resultSession.getVar('sensitiveData')).toBe('should not be copied');
  });

  it('should use the squash function when provided', async () => {
    // Create a parent session with nested context
    let parentSession = Session.create().withVars({
      user: { name: 'Dave', age: 30 },
    });
    parentSession = parentSession.withVars({
      preferences: { theme: 'dark' },
    });

    const customSquash = vi
      .fn()
      .mockImplementation((parent: Session<any>, subroutine: Session<any>) => {
        // Start with a clone of the parent's context object
        const mergedMetadataObject = { ...parent.getVarsObject() };

        const subroutineMeta = subroutine.getVarsObject();

        // Deep merge 'user' object
        if (subroutineMeta.user && typeof subroutineMeta.user === 'object') {
          const currentUser = mergedMetadataObject.user || {};
          // Ensure name from parent is kept if not overwritten by subroutine
          mergedMetadataObject.user = {
            ...currentUser,
            ...subroutineMeta.user,
          };
        }

        // Simple overwrite for 'preferences'
        if (subroutineMeta.preferences) {
          mergedMetadataObject.preferences = subroutineMeta.preferences;
        }

        // Add/overwrite any other keys from subroutine
        for (const key in subroutineMeta) {
          if (
            key !== 'user' &&
            key !== 'preferences' &&
            Object.prototype.hasOwnProperty.call(subroutineMeta, key)
          ) {
            mergedMetadataObject[key] = subroutineMeta[key];
          }
        }

        // Create final session - use merged context object
        let finalSession = Session.create({ vars: mergedMetadataObject });
        // Add parent messages (as per this test's custom logic)
        parent.messages.forEach(
          (msg) => (finalSession = finalSession.addMessage(msg)),
        );

        return finalSession;
      });

    const subroutine = new Subroutine(
      Agent.create('subroutine-template')
        .user('Updating user profile')
        .transform((session: Session) => {
          // This context will be processed by squashWith
          return session.withVars({
            user: { age: 31, occupation: 'Engineer' }, // Update age, add occupation
            preferences: { notifications: true }, // Overwrite preferences
            status: 'updated', // Add new key
          }) as Session;
        }),
      { squash: customSquash },
    );

    // Execute the subroutine
    const resultSession = await subroutine.execute(parentSession);

    expect(customSquash).toHaveBeenCalled();

    // Verify the messages (only parent messages kept by this squashWith)
    const messages = Array.from(resultSession.messages);
    expect(messages).toHaveLength(0); // Parent session started empty

    // Verify the deep-merged context according to custom logic
    const user = resultSession.getVar('user');
    expect(user).toEqual({ name: 'Dave', age: 31, occupation: 'Engineer' });

    const preferences = resultSession.getVar('preferences');
    expect(preferences).toEqual({ notifications: true }); // Overwritten

    expect(resultSession.getVar('status')).toBe('updated');
  });

  // New functionality tests for list of templates and method chaining

  it('should support adding multiple templates via method chaining', async () => {
    // Create a subroutine template with method chaining
    const subroutine = Agent.create('subroutine-template')
      .system('You are a helpful assistant.')
      .user('What is your name?')
      .assistant('I am an AI assistant.');

    // Execute the subroutine
    const session = await subroutine.execute();

    // Verify the messages were added
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('You are a helpful assistant.');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('What is your name?');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('I am an AI assistant.');
  });

  it('should support adding templates via constructor array', async () => {
    // Create a subroutine template with constructor array
    const subroutine = new Subroutine([
      new System('You are a helpful assistant.'),
      new User('What is your name?'),
      new Assistant('I am an AI assistant.'),
    ]);

    // Execute the subroutine
    const session = await subroutine.execute();

    // Verify the messages were added
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('You are a helpful assistant.');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('What is your name?');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('I am an AI assistant.');
  });

  it('should support nested subroutines with method chaining', async () => {
    // Create an inner subroutine with method chaining
    const innerSubroutine = new Subroutine(
      Agent.create('subroutine-template')
        .user('Inner subroutine question')
        .assistant('Inner subroutine answer')
        .transform((session: Session<any>) => {
          return session.withVars({ inner: 'completed' });
        }),
    );

    // Create an outer subroutine that includes the inner one via method chaining
    const outerSubroutine = new Subroutine(
      Agent.create('subroutine-template')
        .user('Outer subroutine start')
        .add(innerSubroutine) // Nest the subroutine
        .user('Outer subroutine end')
        .transform((session: Session<any>) => {
          return session.withVars({ outer: 'completed' });
        }),
    );
    // Execute the nested subroutines
    const session = await outerSubroutine.execute();

    // Verify the messages (all should be retained by default)
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect(messages[0].content).toBe('Outer subroutine start');
    expect(messages[1].content).toBe('Inner subroutine question');
    expect(messages[2].content).toBe('Inner subroutine answer');
    expect(messages[3].content).toBe('Outer subroutine end');

    // Verify subroutine context remains isolated by default.
    expect(session.getVar('inner')).toBeUndefined();
    expect(session.getVar('outer')).toBeUndefined();
  });

  it('should support adding subroutines to LinearTemplate (Sequence)', async () => {
    // Create a subroutine
    const nestedSubroutine = new Subroutine(
      Agent.create('subroutine-template')
        .user('Message from nested subroutine')
        .assistant('Response from nested subroutine'),
    );

    // Create a sequence that includes the subroutine
    const sequence = Agent.create('subroutine-template')
      .system('Main sequence system message')
      .add(nestedSubroutine) // Add the subroutine
      .user('Message after nested subroutine');

    // Execute the sequence
    const session = await sequence.execute();

    // Verify the messages from both the sequence and the subroutine are present
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect(messages[0].content).toBe('Main sequence system message');
    expect(messages[1].content).toBe('Message from nested subroutine');
    expect(messages[2].content).toBe('Response from nested subroutine');
    expect(messages[3].content).toBe('Message after nested subroutine');
  });

  it('should support adding subroutines to LoopTemplate', async () => {
    // Create a subroutine to be used in the loop body
    const loopSubroutine = new Subroutine(
      Agent.create('subroutine-template')
        .user('Message from loop subroutine')
        .transform((session: Session<any>) => {
          return session.withVars({
            // count at the end of agent is 1, 2, 3...
            count: session.getVar('count', 0) + 1,
          });
        }),
      {
        init: (parent) =>
          Session.create({ vars: parent.getVarsObject() as any }),
        squash: (parent, subroutine) => {
          let next = parent.withVars(subroutine.getVarsObject());
          for (const message of subroutine.messages) {
            next = next.addMessage(message);
          }
          return next;
        },
      },
    );

    // Create a loop template that includes the subroutine in its body
    const loopTemplate = new Loop({
      bodyTemplate: loopSubroutine, // Use the subroutine as the body
      loopIf: (session: Session<any>) => {
        // Loop if count is 0, 1, or 2
        return (session.getVar('count') || 0) < 2; // Exit when count reaches 2 or more
      },
    });

    // Execute the loop, starting context count at 0
    const session = await loopTemplate.execute(
      Session.create({ vars: { count: 0 } }),
    );

    // Should have executed the loop body (subroutine) 2 times (exit condition counter >= 2)
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(2); // 1 message from subroutine * 2 iterations
    expect(messages[0].content).toBe('Message from loop subroutine');

    // Verify the count was incremented to 2 (executed twice)
    expect(session.getVar('count')).toBe(2);
  });

  it('should work with direct loop implementation', async () => {
    interface CounterContext extends Vars {
      count: number;
    }

    const counterTemplate = new Transform(
      (session: Session<CounterContext>) => {
        const currentCount = session.getVar('count', 0);
        return session.withVars({ count: currentCount + 1 });
      },
    );

    const loop = new Loop({
      bodyTemplate: counterTemplate,
      loopIf: (session: Session<CounterContext>) => {
        // Loop if count is 0, 1, or 2
        return (session.getVar('count') || 0) < 3; // Exit when count reaches 3 or more
      },
    });

    const initialSession = Session.create<CounterContext, Attrs>();
    const session = await loop.execute(initialSession);

    // Verify the count was incremented to 3
    expect(session.getVar('count')).toBe(3);
  });

  it('should handle empty templates list gracefully', async () => {
    // Create a subroutine with an empty list of templates
    const subroutine = new Subroutine([]);

    // Execute the subroutine
    const session = await subroutine.execute();

    // Verify no messages were added
    expect(session.messages).toHaveLength(0);
  });
});
