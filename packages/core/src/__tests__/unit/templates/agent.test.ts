import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../../../session';
import { createGenerateOptions } from '../../../generate_options';
import { createContext } from '../../../taggedRecord';
import { generateText } from '../../../generate';
import { Source } from '../../../content_source';
import {
  Subroutine,
  Sequence,
  Loop,
  System,
  User,
  Assistant,
  Agent,
} from '../../../templates';
import type { Session } from '../../../session';

// Mock the generate module
vi.mock('../../../generate', () => ({
  generateText: vi.fn(),
}));

describe('Agent', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Set up default mock for generateText
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'Mock response',
      metadata: createContext(),
    });
  });

  // Original functionality tests

  it('should support addXXXX methods', async () => {
    const sequence = new Agent()
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
    const sequence = new Agent()
      .addSystem('You are a helpful assistant.')
      .addUser('Hello')
      .addConditional(
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

    const sequence2 = new Agent()
      .addSystem('You are a helpful assistant.')
      .addUser('Goodbye')
      .addConditional(
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

    const sequence = new Agent()
      .addSystem('You are a helpful assistant.')
      .addUser('Start the loop')
      .addLoop(
        // Use addLoop directly
        new User('This is iteration message'),
        (session) => {
          counter++;
          // Exit condition should be true *after* the 3rd iteration completes
          // The check runs *before* the body, so check if counter will exceed 3 *after* incrementing
          return counter <= 3;
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

    const bodyTemplate = new Agent().addUser('This is iteration message');

    const sequence = new Agent()
      .addSystem('You are a helpful assistant.')
      .addUser('Start the loop')
      .addLoop(bodyTemplate, (session) => {
        // Use addLoop
        counter++;
        // Exit condition should be true *after* the 3rd iteration completes
        return counter <= 3;
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
    const nestedSequence = new Agent()
      .addUser('Nested message 1')
      .addUser('Nested message 2');

    const mainSequence = new Agent()
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
    const innerLoopBody = new Agent().addUser('Inner loop message');

    // Define the body of the outer loop, which includes the inner loop
    const outerLoopBody = new Agent()
      .addUser('Outer loop start')
      .addLoop(innerLoopBody, (session) => {
        // Inner loop definition
        innerCounter++;
        // Exit inner loop when counter *exceeds* 2 (after 2 iterations)
        const shouldLoopInner = innerCounter <= 2;
        // Reset logic removed from here
        return shouldLoopInner;
      })
      .addUser('Outer loop end');

    // Define the main sequence containing the outer loop
    const mainSequence = new Agent()
      .addSystem('You are a helpful assistant.')
      .addLoop(outerLoopBody, (session) => {
        // Outer loop definition
        outerCounter++;
        // Reset inner counter *before* the outer loop body executes for this iteration
        innerCounter = 0;
        // Exit outer loop when counter *exceeds* 2 (after 2 iterations)
        return outerCounter <= 2;
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
});
