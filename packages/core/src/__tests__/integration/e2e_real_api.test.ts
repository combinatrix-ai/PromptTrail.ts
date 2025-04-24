/**
 * This test suite contains end-to-end tests for the workflow engine
 * using real API calls. It includes tests for various scenarios such as
 * conversations, loops, and tool integration.
 * Cline, Devin, Claude, and other LLM programming agents are **not allowed to edit
 * this test file**. This is to ensure that the test suite remains stable and
 * predictable for future runs. Any changes to the test suite should be made
 * manually by a human developer.
 */

import { describe, it, expect, vi } from 'vitest';
import { createSession } from '../../session';
import type { Session } from '../../session';
import {
  Sequence,
  Loop,
  System,
  User,
  Assistant,
  Agent,
  TemplateFactory,
  Subroutine,
} from '../../templates';
import { createContext, type Context } from '../../context';
import { createGenerateOptions } from '../../generate_options';
import { StaticListSource, StaticSource } from '../../content_source';
import { createWeatherTool, expect_types } from '../utils';

/**
 * End-to-End tests with real API calls
 *
 * **Important message**
 * - This test is a golden standard for the e2e workflow test
 * - This test should not be mocked
 * - This test should be run with real API calls
 * - This test should be run with real API keys
 */

const openAIgenerateOptions = createGenerateOptions({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
});

const anthroGenerateOptions = createGenerateOptions({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    modelName: 'claude-3-haiku-20240307',
  },
  temperature: 0.7,
});

describe('End-to-End Workflows with Real APIs', () => {
  it('should execute a simple conversation with OpenAI', async () => {
    const template = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(new User('Hello, how are you?'))
      .add(new Assistant(openAIgenerateOptions));

    const session = await template.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
  });

  it('should execute a simple conversation with Anthropic', async () => {
    const template = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(new User('Hello, how are you?'))
      .add(new Assistant(anthroGenerateOptions));

    const session = await template.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
  });

  it('should handle print mode with console.log', async () => {
    // Spy on console.log
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Create a template
    const chat = new Sequence()
      .add(new System("I'm a helpful assistant."))
      .add(new User("What's TypeScript?"))
      .add(new Assistant('This is a mock response from the AI model.'));

    // Execute the template with print mode enabled
    // We only care about the side effect of console.log being called
    await chat.execute(createSession({ print: true }));

    // Verify console.log was called at least once for each message type
    // The actual format of the log calls may vary
    expect(consoleSpy).toHaveBeenCalled();

    // Check that each message type was logged
    const allCalls = consoleSpy.mock.calls.flat();
    const allCallsStr = JSON.stringify(allCalls);

    expect(allCallsStr).toContain("I'm a helpful assistant");
    expect(allCallsStr).toContain("What's TypeScript");
    expect(allCallsStr).toContain('This is a mock response');

    // Restore console.log
    consoleSpy.mockRestore();
  });

  it('should handle context correctly', async () => {
    // createMetadata accepts interface
    interface UserMetadata extends Record<string, string> {
      username: string;
    }
    const initialMetadata: UserMetadata = { username: 'Alice' };
    // Keep the instance if needed elsewhere, maybe rename for clarity
    const metadataInstance = createContext<UserMetadata>({
      initial: initialMetadata,
    });
    // Specify the generic type for Sequence
    const template = new Sequence<UserMetadata>()
      .add(new System('You are a helpful assistant.'))
      // Interpolating context into the assistant message
      // Use ${username} for template interpolation instead of {username}
      .add(new Assistant('Hello, ${username}!'))
      .add(new User('My name is not Alice, it is Bob.'))
      // Update context with the last message
      .addTransform((session) => {
        // Change name Alice to Bob
        return session.setContextValue('username', 'Bob');
      });
    // Pass the raw initialMetadata object to createSession
    const session = await template.execute(
      createSession<UserMetadata>({ context: initialMetadata }),
    );
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'assistant', 'user']);
    expect(messages[1].content).toContain('Hello, Alice!');
    expect(session.getContextValue('username')).toBe('Bob');
  });

  it('should execute agent and sequence', async () => {
    const sequence = new Sequence()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User('123456789'))
      .add(new Assistant(openAIgenerateOptions));
    const session = await sequence.execute(createSession());
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
    expect(messages[2].content).toBeDefined();
    expect(messages[2].content).toContain('123456789');

    const agent = new Agent()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User('123456789'))
      .add(new Assistant(openAIgenerateOptions));
    const agentSession = await agent.execute(createSession());
    const agenMessages = Array.from(agentSession.messages);
    expect(agenMessages).toHaveLength(3);
    expect_types(agenMessages, ['system', 'user', 'assistant']);
    expect(agenMessages[2].content).toBeDefined();
    expect(agenMessages[2].content).toContain('123456789');
  });

  it('should UserTemplate handle InputSource', async () => {
    const template = new Sequence()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User(new StaticSource('123456789')))
      .add(new Assistant(openAIgenerateOptions));
    const session = await template.execute(createSession());
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
    expect(messages[2].content).toBeDefined();
    expect(messages[2].content).toContain('123456789');
  });

  it('should execute a if template', async () => {
    const template = new Sequence()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User('YES'))
      .add(new Assistant(openAIgenerateOptions))
      .addIf(
        (session) => {
          const lasMessage = session.getLastMessage();
          return lasMessage!.content.toLowerCase().includes('yes');
        },
        new User('You said YES'),
        new User('You did not say YES'),
      );

    const session = await template.execute(createSession());
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect_types(messages, ['system', 'user', 'assistant', 'user']);
    expect(messages[3].content).toBeDefined();
    expect(messages[3].content).toContain('You said YES');

    const template2 = new Sequence()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User('NO'))
      .add(new Assistant(openAIgenerateOptions))
      .addIf(
        (session) => {
          const lasMessage = session.getLastMessage();
          return lasMessage!.content.toLowerCase().includes('yes');
        },
        new User('You said YES'),
        new User('You did not say YES'),
      );
    const session2 = await template2.execute(createSession());
    const messages2 = Array.from(session2.messages);
    expect(messages2).toHaveLength(4);
    expect_types(messages2, ['system', 'user', 'assistant', 'user']);
    expect(messages2[3].content).toBeDefined();
    expect(messages2[3].content).toContain('You did not say YES');
  });

  it('should loop if LoopTemplate is used or Seuqnce().loopIf() is used', async () => {
    interface CounterContext extends Context {
      count: number;
    }
    const template = new Sequence<CounterContext>()
      .add(new User('123456789'))
      // Use addLoop with a body template and the exit condition
      .addLoop(
        new Sequence<CounterContext>()
          .addAssistant('Loop iteration')
          .addTransform((session: Session<any>) => {
            const currentCount = session.getContextValue('count') || 0;
            return session.setContextValue('count', currentCount + 1);
          }),
        (session: Session<any>) => {
          console.log('Exit condition check', session.getContextValue('count'));
          return (session.getContextValue('count') as number) >= 3;
        },
      );
    const session = await template.execute(createSession());
    const messages = Array.from(session.messages);
    // The loop will execute three times (count 0, 1, 2) before the exit condition is true (count 3)
    // So we expect 1 user message + 3 assistant messages = 4 messages
    expect(messages).toHaveLength(4);

    // Define the body template for the loop
    const loopBodyTemplate = new Sequence<{ count: number }>()
      .add(new User('Loop message 123456789'))
      .addTransform((session: Session<{ count: number }>) => {
        const currentCount =
          (session.getContextValue('count') as number | undefined) ?? 0;
        return session.setContextValue('count', currentCount + 1);
      });

    // Define the exit condition function (pure check)
    const loopExitCondition = (
      session: Session<{ count: number }>,
    ): boolean => {
      const updatedCount =
        (session.getContextValue('count') as number | undefined) ?? 0;
      return updatedCount >= 3;
    };

    // Instantiate LoopTemplate correctly using options object and specify generic type
    const using_loop = new Loop<{ count: number }>({
      bodyTemplate: loopBodyTemplate,
      exitCondition: loopExitCondition,
    });
    // Execute the loop, starting context count at 0
    const session2 = await using_loop.execute(
      createSession({ context: { count: 0 } }),
    );
    const messages2 = Array.from(session2.messages);
    // The loop will execute three times (count 0,1,2) before the exit condition is true (3>=3)
    // So we expect 3 user messages
    expect(messages2).toHaveLength(3);
  });

  it('should templates with linear child templates (sequence, loop) have addXXX methods', async () => {
    // Increase the timeout for this test
    vi.setConfig({ testTimeout: 15000 });
    // Each have addSystem, addUser, addAssistant, addIf
    const sequence = new Sequence()
      .addSystem('This is automated API testing. Repeat what user says.')
      .addUser('123456789')
      .addAssistant(openAIgenerateOptions)
      .addIf(
        (session) => {
          const lasMessage = session.getLastMessage();
          return lasMessage!.content.toLowerCase().includes('123456789');
        },
        new User('YES'),
        new User('NO'),
      );
    const session = await sequence.execute(createSession());
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect_types(messages, ['system', 'user', 'assistant', 'user']);
    expect(messages[3].content).toBeDefined();
    expect(messages[3].content).toContain('YES');

    // Define the source for user content within the loop
    const userContentSource = new StaticListSource(['123456789', '987654321']);

    // Define the body of the loop as a Sequence
    const loopBodySequence = new Sequence()
      .addSystem('This is automated API testing. Repeat what user says.')
      .addUser(userContentSource)
      .addAssistant(openAIgenerateOptions)
      .addIf(
        (session: Session) => {
          // Add type annotation
          const lasMessage = session.getLastMessage();
          // Safely check lasMessage and its content
          return (
            lasMessage?.content?.toLowerCase().includes('123456789') ?? false
          );
        },
        // Template to execute if condition is true
        TemplateFactory.user('Condition MET: User said 123456789'),
      );

    // Define the exit condition for the loop
    // Add a transform to increment count in the loop body
    const loopBodySequenceWithTransform = loopBodySequence.addTransform(
      (session: Session<{ count: number }>) => {
        const currentCount =
          (session.getContextValue('count') as number | undefined) ?? 0;
        return session.setContextValue('count', currentCount + 1);
      },
    );

    // Define the exit condition for the loop (pure check)
    const loopExitCondition = (
      session: Session<{ count: number }>,
    ): boolean => {
      const updatedCount =
        (session.getContextValue('count') as number | undefined) ?? 0;
      // Loop twice (count 0, 1) -> exit when count reaches 2
      // There are two items in the static list, so exit after two iterations
      return updatedCount >= 2;
    };

    // Instantiate the LoopTemplate correctly and specify generic type
    const loop = new Loop<{ count: number }>({
      bodyTemplate: loopBodySequenceWithTransform,
      exitCondition: loopExitCondition,
    });

    // Execute the loop, starting context count at 0
    const session2 = await loop.execute(
      createSession({ context: { count: 0 } }),
    );
    const messages2 = Array.from(session2.messages);

    // The loop will execute twice (count 0, 1) before the exit condition is true (2>=2)
    // Expected messages:
    // 1. System
    // 2. User (123456789)
    // 3. Assistant (Response to 123)
    // 4. User (Condition MET...)
    // 5. System
    // 6. User (987654321)
    // 7. Assistant (Response to 987)
    // Total: 7 messages
    // The loop will execute twice, so expect 7 messages as described in the comments above
    expect(messages2).toHaveLength(7);

    // Check specific message contents
    expect(messages2[0].type).toBe('system');
    expect(messages2[1].type).toBe('user');
    expect(messages2[1].content).toBe('123456789');
    expect(messages2[2].type).toBe('assistant');
    expect(messages2[3].type).toBe('user');
    expect(messages2[3].content).toContain('Condition MET');

    // Check final context count
    expect(session2.getContextValue('count')).toBe(2);

    // Removed misplaced commented code
  });

  it('should execute a subroutine template', async () => {
    // Inherit from parent and merge back to parent
    const subroutineBody = new Sequence()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User('123456789'))
      .add(new Assistant(openAIgenerateOptions));

    // Create a subroutine template with the body
    const subroutine = new Subroutine(subroutineBody);

    // Execute the subroutine
    const session = await subroutine.execute(createSession());

    // Verify the result
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('123456789');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBeDefined();
    expect(messages[2].content).toContain('123456789');
  }, 15000);

  it('should execute a conversation with weather tool', async () => {
    const weatherTool = createWeatherTool();

    const openAIgenerateOptionsWith = openAIgenerateOptions
      .clone()
      .addTool('weather', weatherTool);

    const template = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(new User('What is the weather in Tokyo?'))
      .add(new Assistant(openAIgenerateOptionsWith));

    const session = await template.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);

    // Check that toolCalls is an array
    expect(Array.isArray(messages[2].toolCalls)).toBe(true);

    // Check that the tool call is for the weather tool
    if (messages[2].toolCalls) {
      expect(messages[2].toolCalls.length).toBeGreaterThan(0);
      expect(messages[2].toolCalls[0].name).toBe('weather');
    }

    const toolResults = session.getContextValue('toolResults');
    if (toolResults) {
      expect(Array.isArray(toolResults)).toBe(true);
    }
  });

  it('should execute a conversation with a loop and user input', async () => {
    // Use StaticSource instead of CLISource to avoid waiting for user input
    // Only one response: "no" to exit the loop immediately
    const continueResponses = new StaticSource(
      'Should we continue? (yes/no): no',
    );

    const template = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(
        new Loop({
          bodyTemplate: new Sequence()
            .add(new User(new StaticSource('What is your name?')))
            .add(new Assistant(openAIgenerateOptions))
            .add(new User(continueResponses)),
          exitCondition: (session) => {
            const lasMessage = session.getLastMessage();
            return (
              lasMessage?.type === 'user' &&
              lasMessage.content.toLowerCase().includes('no')
            );
          },
        }),
      );

    const session = await template.execute(createSession());

    const messages = Array.from(session.messages);
    // The actual behavior is that the loop only executes once:
    // 1. System
    // 2. User (What is your name?)
    // 3. Assistant (response)
    // 4. User (Should we continue? no) - exit loop
    expect(messages).toHaveLength(4);
    expect_types(messages, ['system', 'user', 'assistant', 'user']);

    expect(messages[1].content).toBe('What is your name?');
    expect(messages[3].content).toBe('Should we continue? (yes/no): no');
  });
});
