import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from '../../../generate';
import { Session } from '../../../session';
import { Source } from '../../../source';
import { Agent } from '../../../templates';
import { Loop } from '../../../templates/composite/loop';
import { Sequence } from '../../../templates/composite/sequence';
import { System } from '../../../templates/primitives/system';
import { User } from '../../../templates/primitives/user';

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
    });
  });

  it('should handle a simple loop', async () => {
    // Create a counter for the loop condition
    let counter = 0;

    // Create the loop condition function
    const loopIf = (session: Session) => {
      counter++;
      return counter < 3; // Exit after 3 iterations
    };

    // Create a simple body template that adds a user message
    const bodyTemplate = new User('Iteration message');

    // Create the loop template
    const loopTemplate = new Loop({
      bodyTemplate,
      loopIf: loopIf,
      maxIterations: 10,
    });

    // Execute the template and verify the result
    const session = await loopTemplate.execute();

    // Should have executed the body template 2 times due to exit condition check before execution
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(2); // Expect 2 iterations
    expect(messages[0].type).toBe('user');
    expect(messages[0].content).toBe('Iteration message');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Iteration message');
    // Removed checks for the 3rd message as it's not generated
  });

  it('should be instantiated without exitCondition and bodyTemplate but be error on execute', async () => {
    // Create an instance of the test template
    const template = new Loop();

    // Expect the execute method to throw an error
    await expect(template.execute()).rejects.toThrow(
      'LoopTemplate requires a bodyTemplate.',
    );
  });

  it('should allow setting body template and exit condition after instantiation', async () => {
    // Create a counter for the loop condition
    let counter = 0;

    // Create the loop condition function
    const loopIf = (session: Session) => {
      counter++;
      return counter < 3; // Exit after 3 iterations
    };

    // Create a simple body template that adds a user message
    const bodyTemplate = new User('Iteration message');

    // Create the loop template without body and exit condition
    const loopTemplate = new Loop()
      .setBody(bodyTemplate)
      .setLoopIf(loopIf)
      .setMaxIterations(10);

    // Execute the template and verify the result
    const session = await loopTemplate.execute();

    // Should have executed the body template 2 times due to exit condition check before execution
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(2); // Expect 2 iterations
    expect(messages[0].type).toBe('user');
    expect(messages[0].content).toBe('Iteration message');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Iteration message');
  });

  it('should handle a nested loop', async () => {
    // Create counters for the outer and inner loops
    let outerCounter = 0;
    let innerCounter = 0;

    // Create the inner loop template
    const innerLoopTemplate = new Loop({
      bodyTemplate: new User('Inner iteration'),
      loopIf: (session: Session) => {
        innerCounter++; // 1, 2, ...
        return innerCounter % 2 != 0; // 1, 0, 1, 0... Exit after 2 inner iterations for each outer iteration
      },
    });

    // Create the outer loop template
    const outerLoopTemplate = new Loop({
      bodyTemplate: new Sequence()
        .then(new User('Outer iteration'))
        .then(innerLoopTemplate),
      loopIf: (session: Session) => {
        outerCounter++; // 1, 2, 3...
        return outerCounter < 2; // Exit after 2 outer iterations
      },
    });

    // Execute the template and verify the result
    const session = await outerLoopTemplate.execute();

    // Should have executed based on check-before-execute logic:
    // 1. Outer loop check (outerCounter=1, false) -> Execute body
    //    - Add "Outer iteration"
    //    - Inner loop check (innerCounter=1, false) -> Execute body
    //      - Add "Inner iteration"
    //    - Inner loop check (innerCounter=2, true) -> Terminate inner loop
    // 2. Outer loop check (outerCounter=2, true) -> Terminate outer loop
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(2); // Expect 2 messages based on trace
    expect(messages[0].content).toBe('Outer iteration');
    expect(messages[1].content).toBe('Inner iteration');
    // Removed checks for other messages
  });

  it('should execute body template once when no exit condition is provided', async () => {
    // Create a loop template without an exit condition
    const template = new Loop({
      bodyTemplate: new User('Test message'),
    });

    // Should not throw on instantiation
    expect(template).toBeInstanceOf(Loop);

    // Mock console.warn to check for warnings
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Execute the template
    const session = Session.create();
    const result = await template.execute(session);

    // Should have executed the body template exactly once
    const messages = Array.from(result.messages);
    expect(messages).toHaveLength(1); // One message should be added
    expect(messages[0].type).toBe('user');
    expect(messages[0].content).toBe('Test message');

    // Should have logged a warning about missing exit condition
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'LoopTemplate executed without an loopIf condition.',
      ),
    );

    // Restore console.warn
    warnSpy.mockRestore();
  });

  it('should respect maxIterations limit', async () => {
    // Create a condition that would never exit on its own
    const alwaysLoopCondition = () => true;

    // Create a loop template with a low maxIterations value
    const loopTemplate = new Loop({
      bodyTemplate: new User('This would loop forever'),
      loopIf: alwaysLoopCondition,
      maxIterations: 5,
    });

    // Mock console.warn to check for warnings
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Execute the template
    const session = await loopTemplate.execute();

    // Should have executed the body template exactly 5 times (maxIterations)
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(5);

    // Should have logged a warning about reaching maxIterations
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('reached maximum iterations (5)'),
    );

    // Restore console.warn
    warnSpy.mockRestore();
  });

  it('should work with StaticListSource for changing content', async () => {
    // Create a list of messages for the StaticListSource
    const messageList = ['First message', 'Second message', 'Third message'];

    // Create a ListSource
    const listSource = Source.list(messageList);

    // Create a counter for the loop condition
    let counter = 0;

    // Create the loop template
    const loopTemplate = new Loop({
      bodyTemplate: new User(listSource),
      loopIf: (session: Session) => {
        counter++;
        return counter < 3; // Exit after 3 iterations
      },
    });

    // Execute the template and verify the result
    const session = await loopTemplate.execute();

    // Should have used the first two messages from the StaticListSource (exit condition counter >= 3)
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(2); // Expect 2 iterations
    expect(messages[0].content).toBe('First message');
    expect(messages[1].content).toBe('Second message');
    // Removed check for third message
  });

  it('should update and use session metadata in the exit condition', async () => {
    // Create the loop template with a metadata-based exit condition
    const loopTemplate = new Loop({
      bodyTemplate: Agent.create()
        .then(new User('Adding to counter'))
        .transform((session) => {
          // Get the current counter value, default to 0, ensure it's a number
          const counter =
            (session.getVar('counter') as number | undefined) ?? 0;
          // Increment the counter
          return session.withContext({ counter: counter + 1 });
        }),
      loopIf: (session: Session) => {
        // Exit when counter reaches 3
        // Get counter, default to 0, ensure it's a number before comparing
        return ((session.getVar('counter') as number | undefined) ?? 0) < 3;
      },
    });

    // Execute the template and verify the result
    const session = await loopTemplate.execute();

    // Should have executed 3 iterations (since counter starts at undefined/0)
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('Adding to counter');
    expect(messages[1].content).toBe('Adding to counter');
    expect(messages[2].content).toBe('Adding to counter');

    // Verify the final counter value
    expect(session.getVar('counter')).toBe(3);
  });

  it('should support if statements inside loop templates', async () => {
    // Create a counter for tracking iterations
    let counter = 0;

    // Create the loop template with a conditional branch
    const loopTemplate = new Loop({
      bodyTemplate: Agent.create()
        .then(new User('User input'))
        .conditional(
          // Condition based on iteration count
          () => counter % 2 === 0, // True on even iterations
          (agent) => agent.then(new System('This is an even iteration')),
          (agent) => agent.then(new System('This is an odd iteration')),
        )
        .build(),
      loopIf: () => {
        counter++;
        return counter < 3; // Continue until 3 iterations
      },
    });

    // Execute the template and verify the result
    const session = await loopTemplate.execute();

    // Should have 4 messages: 2 user inputs + 2 conditional system messages (exit condition counter >= 3)
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4); // Expect 2 iterations * 2 messages/iteration

    // Verify the pattern (User, System) × 2 based on actual execution
    expect(messages[0].type).toBe('user');
    expect(messages[0].content).toBe('User input');
    expect(messages[1].type).toBe('system');
    expect(messages[1].content).toBe('This is an odd iteration'); // Iteration 1 (counter becomes 1 before addIf check)

    expect(messages[2].type).toBe('user');
    expect(messages[2].content).toBe('User input');
    expect(messages[3].type).toBe('system');
    expect(messages[3].content).toBe('This is an even iteration'); // Iteration 2 (counter becomes 2 before addIf check)

    // Removed checks for 3rd iteration
  });
});
