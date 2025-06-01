import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../../../session';
import { Agent, Assistant, User } from '../../../templates';

describe('Agent', () => {
  beforeEach(() => {
    // No mocks needed for these tests
  });

  // Original functionality tests

  it('should support short methods', async () => {
    const sequence = Agent.create()
      .system('You are a helpful assistant.')
      .user('Hello, who are you?')
      .assistant('I am an AI assistant.');

    const session = await sequence.execute();

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('You are a helpful assistant.');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Hello, who are you?');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('I am an AI assistant.');
  });

  it('should support conditional method', async () => {
    const sequence = Agent.create()
      .system('You are a helpful assistant.')
      .user('Hello')
      .conditional(
        (session) => session.getLastMessage()?.content === 'Hello',
        (agent) => agent.assistant('Hello there!'),
        (agent) => agent.assistant('I did not understand.'),
      );

    const session = await sequence.execute();

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Hello');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('Hello there!');

    const sequence2 = Agent.create()
      .system('You are a helpful assistant.')
      .user('Goodbye')
      .conditional(
        (session) => session.getLastMessage()?.content === 'Hello',
        (agent) => agent.assistant('Hello there!'),
        (agent) => agent.assistant('I did not understand.'),
      );

    const session2 = await sequence2.execute();
    const messages2 = Array.from(session2.messages);
    expect(messages2[2].content).toBe('I did not understand.');
  });

  it('should support loop method with function builder', async () => {
    let counter = 0;

    const sequence = Agent.create()
      .system('You are a helpful assistant.')
      .user('Start the loop')
      .loop(
        // Use function-based loop
        (agent) => agent.user('This is iteration message'),
        (session) => {
          counter++;
          // Exit condition should be true *after* the 3rd iteration completes
          // The check runs *before* the body, so check if counter will exceed 3 *after* incrementing
          return counter <= 3;
        },
      );

    const session = await sequence.execute();

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

  // This test previously used template.loopIf(), now uses function-based loop
  it('should support loop method with function builder (alternative)', async () => {
    let counter = 0;

    const sequence = Agent.create()
      .system('You are a helpful assistant.')
      .user('Start the loop')
      .loop(
        (agent) => agent.user('This is iteration message'),
        (session) => {
          // Use function-based loop
          counter++;
          // Exit condition should be true *after* the 3rd iteration completes
          return counter <= 3;
        },
      );

    const session = await sequence.execute();

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
    const nestedSequence = Agent.create()
      .user('Nested message 1')
      .user('Nested message 2');

    const mainSequence = Agent.create()
      .system('You are a helpful assistant.')
      .add(nestedSequence)
      .user('Final message');

    const session = await mainSequence.execute();

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

  // Rewritten nested loop test using function-based loops
  it('should support nested loops using function-based builders', async () => {
    let outerCounter = 0;
    let innerCounter = 0;

    // Define the main sequence containing nested loops
    const mainSequence = Agent.create()
      .system('You are a helpful assistant.')
      .loop(
        (agent) =>
          agent
            .user('Outer loop start')
            .loop(
              (innerAgent) => innerAgent.user('Inner loop message'),
              (session) => {
                // Inner loop definition
                innerCounter++;
                // Exit inner loop when counter *exceeds* 2 (after 2 iterations)
                const shouldLoopInner = innerCounter <= 2;
                // Reset logic removed from here
                return shouldLoopInner;
              },
            )
            .user('Outer loop end'),
        (session) => {
          // Outer loop definition
          outerCounter++;
          // Reset inner counter *before* the outer loop body executes for this iteration
          innerCounter = 0;
          // Exit outer loop when counter *exceeds* 2 (after 2 iterations)
          return outerCounter <= 2;
        },
      )
      .user('All done');

    const session = await mainSequence.execute();

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
