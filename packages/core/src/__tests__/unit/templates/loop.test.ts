import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../../../session';
import { StaticListSource } from '../../../content_source';
import { createMetadata } from '../../../metadata';
import { generateText } from '../../../generate';
import { Sequence } from '../../../templates/sequence';
import { LoopTemplate } from '../../../templates/loop';
import { UserTemplate } from '../../../templates/user';
import type { Session } from '../../../types';
import { SystemTemplate } from '../../../templates/system';

// Mock the generate module
vi.mock('../../../generate', () => ({
  generateText: vi.fn(),
}));

describe('Loop Template', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Set up default mock for generateText
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'Mock response',
      metadata: createMetadata(),
    });
  });

  it('should handle a simple loop', async () => {
    // Create a counter for the loop condition
    let counter = 0;

    // Create the loop condition function
    const exitCondition = (session: Session) => {
      counter++;
      return counter >= 3; // Exit after 3 iterations
    };

    // Create a simple body template that adds a user message
    const bodyTemplate = new UserTemplate('Iteration message');

    // Create the loop template
    const loopTemplate = new LoopTemplate({
      bodyTemplate,
      exitCondition,
      maxIterations: 10,
    });

    // Execute the template and verify the result
    const session = await loopTemplate.execute(createSession());

    // Should have executed the body template 3 times
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('user');
    expect(messages[0].content).toBe('Iteration message');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Iteration message');
    expect(messages[2].type).toBe('user');
    expect(messages[2].content).toBe('Iteration message');
  });

  it('should handle a nested loop', async () => {
    // Create counters for the outer and inner loops
    let outerCounter = 0;
    let innerCounter = 0;

    // Create the inner loop template
    const innerLoopTemplate = new LoopTemplate({
      bodyTemplate: new UserTemplate('Inner iteration'),
      exitCondition: (session: Session) => {
        innerCounter++;
        return innerCounter % 2 === 0; // Exit after 2 inner iterations for each outer iteration
      },
    });

    // Create the outer loop template
    const outerLoopTemplate = new LoopTemplate({
      bodyTemplate: new Sequence()
        .add(new UserTemplate('Outer iteration'))
        .add(innerLoopTemplate),
      exitCondition: (session: Session) => {
        outerCounter++;
        return outerCounter >= 2; // Exit after 2 outer iterations
      },
    });

    // Execute the template and verify the result
    const session = await outerLoopTemplate.execute(createSession());

    // Should have executed:
    // 1. "Outer iteration"
    // 2. "Inner iteration"
    // 3. "Inner iteration"
    // 4. "Outer iteration"
    // 5. "Inner iteration"
    // 6. "Inner iteration"
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(6);
    expect(messages[0].content).toBe('Outer iteration');
    expect(messages[1].content).toBe('Inner iteration');
    expect(messages[2].content).toBe('Inner iteration');
    expect(messages[3].content).toBe('Outer iteration');
    expect(messages[4].content).toBe('Inner iteration');
    expect(messages[5].content).toBe('Inner iteration');
  });

  it('should be error if exitCondition is not provided', async () => {
    // Create a loop template without an exit condition
    expect(() => {
      // @ts-ignore - Intentionally missing required property for test
      new LoopTemplate({
        bodyTemplate: new UserTemplate('Test'),
      });
    }).toThrow();
  });

  it('should handle addXXX methods', async () => {
    // Create a counter for the loop condition
    let counter = 0;

    // Create the loop condition function
    const exitCondition = (session: Session) => {
      counter++;
      return counter >= 2; // Exit after 2 iterations
    };

    // Define the body template as a Sequence using addXXX methods
    const bodySequence = new Sequence()
      .addSystem('System message')
      .addUser('User message')
      .addAssistant('Assistant message');

    // Create the loop template correctly
    const loopTemplate = new LoopTemplate({
      exitCondition,
      bodyTemplate: bodySequence, // Pass the defined sequence here
    });

    // Execute the template and verify the result
    const session = await loopTemplate.execute(createSession());

    // Should have executed the body template 2 times
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(6); // 3 messages × 2 iterations

    // First iteration
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('System message');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('User message');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('Assistant message');

    // Second iteration
    expect(messages[3].type).toBe('system');
    expect(messages[3].content).toBe('System message');
    expect(messages[4].type).toBe('user');
    expect(messages[4].content).toBe('User message');
    expect(messages[5].type).toBe('assistant');
    expect(messages[5].content).toBe('Assistant message');
  });

  it('should respect maxIterations limit', async () => {
    // Create a condition that would never exit on its own
    const neverExitCondition = () => false;

    // Create a loop template with a low maxIterations value
    const loopTemplate = new LoopTemplate({
      bodyTemplate: new UserTemplate('This would loop forever'),
      exitCondition: neverExitCondition,
      maxIterations: 5,
    });

    // Mock console.warn to check for warnings
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Execute the template
    const session = await loopTemplate.execute(createSession());

    // Should have executed the body template exactly 5 times (maxIterations)
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(5);

    // Should have logged a warning about reaching maxIterations
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('LoopTemplate reached maximum iterations (5)'),
    );

    // Restore console.warn
    warnSpy.mockRestore();
  });

  it('should work with StaticListSource for changing content', async () => {
    // Create a list of messages for the StaticListSource
    const messageList = ['First message', 'Second message', 'Third message'];

    // Create a StaticListSource
    const listSource = new StaticListSource(messageList);

    // Create a counter for the loop condition
    let counter = 0;

    // Create the loop template
    const loopTemplate = new LoopTemplate({
      bodyTemplate: new UserTemplate(listSource),
      exitCondition: (session: Session) => {
        counter++;
        return counter >= 3; // Exit after 3 iterations
      },
    });

    // Execute the template and verify the result
    const session = await loopTemplate.execute(createSession());

    // Should have used all three messages from the StaticListSource
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('First message');
    expect(messages[1].content).toBe('Second message');
    expect(messages[2].content).toBe('Third message');
  });

  it('should update and use session metadata in the exit condition', async () => {
    // Create the loop template with a metadata-based exit condition
    const loopTemplate = new LoopTemplate({
      bodyTemplate: new Sequence()
        .add(new UserTemplate('Adding to counter'))
        .addTransform((session) => {
          // Get the current counter value, default to 0, ensure it's a number
          const counter =
            (session.metadata.get('counter') as number | undefined) ?? 0;
          // Increment the counter
          return session.updateMetadata({ counter: counter + 1 });
        }),
      exitCondition: (session: Session) => {
        // Exit when counter reaches 3
        // Get counter, default to 0, ensure it's a number before comparing
        return (
          ((session.metadata.get('counter') as number | undefined) ?? 0) >= 3
        );
      },
    });

    // Execute the template and verify the result
    const session = await loopTemplate.execute(createSession());

    // Should have executed 3 iterations (since counter starts at undefined/0)
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('Adding to counter');
    expect(messages[1].content).toBe('Adding to counter');
    expect(messages[2].content).toBe('Adding to counter');

    // Verify the final counter value
    expect(session.metadata.get('counter')).toBe(3);
  });

  it('should support if statements inside loop templates', async () => {
    // Create a counter for tracking iterations
    let counter = 0;

    // Create the loop template with a conditional branch
    const loopTemplate = new LoopTemplate({
      bodyTemplate: new Sequence().add(new UserTemplate('User input')).addIf(
        // Condition based on iteration count
        () => counter % 2 === 0, // True on even iterations
        new SystemTemplate('This is an even iteration'),
        new SystemTemplate('This is an odd iteration'),
      ),
      exitCondition: () => {
        counter++;
        return counter >= 3; // Exit after 3 iterations
      },
    });

    // Execute the template and verify the result
    const session = await loopTemplate.execute(createSession());

    // Should have 6 messages: 3 user inputs + 3 conditional system messages
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(6);

    // Verify the pattern (User, System) × 3
    expect(messages[0].type).toBe('user');
    expect(messages[0].content).toBe('User input');
    expect(messages[1].type).toBe('system');
    expect(messages[1].content).toBe('This is an even iteration'); // 0 is even

    expect(messages[2].type).toBe('user');
    expect(messages[2].content).toBe('User input');
    expect(messages[3].type).toBe('system');
    expect(messages[3].content).toBe('This is an odd iteration'); // 1 is odd

    expect(messages[4].type).toBe('user');
    expect(messages[4].content).toBe('User input');
    expect(messages[5].type).toBe('system');
    expect(messages[5].content).toBe('This is an even iteration'); // 2 is even
  });
});
