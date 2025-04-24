import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Assistant } from '../../../templates/assistant';
import { createSession } from '../../../session';
import type { Session } from '../../../session';
import { createGenerateOptions } from '../../../generate_options';
import { createContext } from '../../../context';
import { generateText } from '../../../generate';
import { expect_messages } from '../../utils';
import { Sequence } from '../../../templates/sequence';
import { System } from '../../../templates/system';
import { User } from '../../../templates/user';

// Mock the generate module directly. Vitest replaces the actual generateText export with a mock.
vi.mock('../../../generate');

describe('Sequence Template', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Set up default mock using vi.mocked() on the imported function name
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'Mock response',
      metadata: createContext(),
    });
  });

  it('should execute simple linear sequence', async () => {
    const sequence = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(new User('Hello, who are you?'))
      .add(new Assistant('I am an AI assistant.'));

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_messages(messages, [
      { type: 'system', content: 'You are a helpful assistant.' },
      { type: 'user', content: 'Hello, who are you?' },
      { type: 'assistant', content: 'I am an AI assistant.' },
    ]);
  });

  it('should create a sequence with constructor arguments', async () => {
    const systemTemplate = new System('You are a helpful assistant.');
    const userTemplate = new User('Hello, who are you?');
    const assistantTemplate = new Assistant('I am an AI assistant.');

    const sequence = new Sequence([
      systemTemplate,
      userTemplate,
      assistantTemplate,
    ]);

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
  });

  it('should support addXXXX methods', async () => {
    const sequence = new Sequence()
      .addSystem('You are a helpful assistant.')
      .addUser('Hello, who are you?')
      .addAssistant('I am an AI assistant.');

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('You are a helpful assistant.');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Hello, who are you?');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('I am an AI assistant.');
  });

  it('should support addIf method', async () => {
    const sequence = new Sequence()
      .addSystem('You are a helpful assistant.')
      .addUser('Hello')
      .addIf(
        (session) => session.getLastMessage()?.content === 'Hello',
        new Assistant('Hello there!'),
        new Assistant('I did not understand.'),
      );

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Hello');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('Hello there!');

    const sequence2 = new Sequence()
      .addSystem('You are a helpful assistant.')
      .addUser('Goodbye')
      .addIf(
        (session) => session.getLastMessage()?.content === 'Hello',
        new Assistant('Hello there!'),
        new Assistant('I did not understand.'),
      );

    const session2 = await sequence2.execute(createSession());
    const messages2 = Array.from(session2.messages);
    expect(messages2[2].content).toBe('I did not understand.');
  });

  it('should support addLoop method (formerly loopIf construction)', async () => {
    let counter = 0;

    const sequence = new Sequence()
      .addSystem('You are a helpful assistant.')
      .addUser('Start the loop')
      .addLoop(
        // Use addLoop directly
        new User('This is iteration message'),
        (session) => {
          counter++;
          // Exit condition should be true *after* the 3rd iteration completes
          // The check runs *before* the body, so check if counter will exceed 3 *after* incrementing
          return counter > 3;
        },
      );

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(5); // 2 initial messages + 3 loop iterations
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Start the loop');
    expect(messages[2].type).toBe('user');
    expect(messages[2].content).toBe('This is iteration message');
    expect(messages[3].type).toBe('user');
    expect(messages[3].content).toBe('This is iteration message');
    expect(messages[4].type).toBe('user');
    expect(messages[4].content).toBe('This is iteration message');
  });

  // This test previously used template.loopIf(), now adapted for addLoop
  it('should support addLoop method (formerly loopIf() method)', async () => {
    let counter = 0;

    const bodyTemplate = new Sequence().addUser('This is iteration message');

    const sequence = new Sequence()
      .addSystem('You are a helpful assistant.')
      .addUser('Start the loop')
      .addLoop(bodyTemplate, (session) => {
        // Use addLoop
        counter++;
        // Exit condition should be true *after* the 3rd iteration completes
        return counter > 3;
      });

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(5); // 2 initial messages + 3 loop iterations
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Start the loop');
    expect(messages[2].type).toBe('user');
    expect(messages[2].content).toBe('This is iteration message');
    expect(messages[3].type).toBe('user');
    expect(messages[3].content).toBe('This is iteration message');
    expect(messages[4].type).toBe('user');
    expect(messages[4].content).toBe('This is iteration message');
  });

  it('should support nested linear sequences', async () => {
    const nestedSequence = new Sequence()
      .addUser('Nested message 1')
      .addUser('Nested message 2');

    const mainSequence = new Sequence()
      .addSystem('You are a helpful assistant.')
      .add(nestedSequence)
      .addUser('Final message');

    const session = await mainSequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('You are a helpful assistant.');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Nested message 1');
    expect(messages[2].type).toBe('user');
    expect(messages[2].content).toBe('Nested message 2');
    expect(messages[3].type).toBe('user');
    expect(messages[3].content).toBe('Final message');
  });

  // Rewritten nested loop test using addLoop
  it('should support nested loops using addLoop', async () => {
    let outerCounter = 0;
    let innerCounter = 0;

    // Define the body of the inner loop
    const innerLoopBody = new Sequence().addUser('Inner loop message');

    // Define the body of the outer loop, which includes the inner loop
    const outerLoopBody = new Sequence()
      .addUser('Outer loop start')
      .addLoop(innerLoopBody, (session) => {
        // Inner loop definition
        innerCounter++;
        // Exit inner loop when counter *exceeds* 2 (after 2 iterations)
        const shouldExitInner = innerCounter > 2;
        // Reset logic removed from here
        return shouldExitInner;
      })
      .addUser('Outer loop end');

    // Define the main sequence containing the outer loop
    const mainSequence = new Sequence()
      .addSystem('You are a helpful assistant.')
      .addLoop(outerLoopBody, (session) => {
        // Outer loop definition
        outerCounter++;
        // Reset inner counter *before* the outer loop body executes for this iteration
        innerCounter = 0;
        // Exit outer loop when counter *exceeds* 2 (after 2 iterations)
        return outerCounter > 2;
      })
      .addUser('All done');

    const session = await mainSequence.execute(createSession());

    // Expected messages: System, (Outer Start, Inner, Inner, Outer End) x 2, All Done
    // Total: 1 + (1 + 2 + 1) * 2 + 1 = 1 + 8 + 1 = 10 messages
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(10);
    expect(messages[0].type).toBe('system');

    // First outer iteration (messages 1-4)
    expect(messages[1].content).toBe('Outer loop start');
    expect(messages[2].content).toBe('Inner loop message');
    expect(messages[3].content).toBe('Inner loop message');
    expect(messages[4].content).toBe('Outer loop end');

    // Second outer iteration (messages 5-8)
    expect(messages[5].content).toBe('Outer loop start');
    expect(messages[6].content).toBe('Inner loop message');
    expect(messages[7].content).toBe('Inner loop message');
    expect(messages[8].content).toBe('Outer loop end');

    // Final message
    expect(messages[9].type).toBe('user');
    expect(messages[9].content).toBe('All done');
  });

  it('should support default ContentSource for UserTemplate', async () => {
    const sequence = new Sequence()
      .addSystem('You are a helpful assistant.')
      .addUser('Default user message');

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Default user message');
  });

  it('should support default ContentSource for AssistantTemplate', async () => {
    // Mock the generateText function using vi.mocked()
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'I am the assistant response',
      metadata: createContext(),
    });

    const options = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4',
      },
    });

    const sequence = new Sequence()
      .addSystem('You are a helpful assistant.')
      .addUser('Hello, assistant')
      .addAssistant(options);

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('I am the assistant response');

    // Verify the generateText was called using vi.mocked()
    expect(vi.mocked(generateText)).toHaveBeenCalledWith(
      expect.anything(), // Session object
      expect.objectContaining({
        // GenerateOptions object
        provider: expect.objectContaining({
          type: 'openai',
          modelName: 'gpt-4',
        }),
      }),
    );
  });

  it('should support addTransform method', async () => {
    const sequence = new Sequence()
      .addSystem('You are a helpful assistant.')
      .addUser('Hello, my name is Alice')
      .addTransform((session) => {
        const message = session.getLastMessage()?.content || '';
        const nameMatch = message.match(/my name is (\w+)/i);
        const name = nameMatch ? nameMatch[1] : 'unknown';
        // Cast the result to satisfy TTransformFunction type
        return session.updateContext({ userName: name }) as unknown as Session<
          Record<string, unknown>
        >;
      })
      .addUser('Nice to meet you, ${userName}');

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_messages(messages, [
      { type: 'system', content: 'You are a helpful assistant.' },
      { type: 'user', content: 'Hello, my name is Alice' },
      { type: 'user', content: 'Nice to meet you, Alice' },
    ]);

    expect(session.getContextValue('userName')).toBe('Alice');
  });

  it('should execute an empty sequence without errors', async () => {
    const emptySequence = new Sequence();

    const session = await emptySequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(0);
  });

  it('should maintain session state across nested sequences', async () => {
    const sequence1 = new Sequence()
      .addUser('First message')
      .addTransform((session) => {
        // Cast the result to satisfy TTransformFunction type
        return session.updateContext({ counter: 1 }) as unknown as Session<
          Record<string, unknown>
        >;
      });

    const sequence2 = new Sequence()
      .addUser('Second message')
      .addTransform((session) => {
        // Ensure counter is treated as a number
        const counter = Number(session.getContextValue('counter') || 0);
        // Cast the result to satisfy TTransformFunction type
        return session.updateContext({
          counter: counter + 1,
        }) as unknown as Session<Record<string, unknown>>;
      });

    const mainSequence = new Sequence()
      .add(sequence1)
      .add(sequence2)
      // Note: Template interpolation uses `${metadataKey}` syntax
      .addUser('Counter value: ${counter}');

    const session = await mainSequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_messages(messages, [
      { type: 'user', content: 'First message' },
      { type: 'user', content: 'Second message' },
      { type: 'user', content: 'Counter value: 2' }, // Interpolated value
    ]);

    expect(session.getContextValue('counter')).toBe(2);
  });
});
