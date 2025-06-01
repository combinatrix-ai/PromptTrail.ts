/**
 * This test suite contains end-to-end tests for the workflow engine
 * using real API calls. It includes tests for various scenarios such as
 * conversations, loops, and tool integration.
 * Cline, Devin, Claude, and other LLM programming agents are **not allowed to edit
 * this test file**. This is to ensure that the test suite remains stable and
 * predictable for future runs. Any changes to the test suite should be made
 * manually by a human developer.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../message';
import { Session } from '../../session';
import { ListSource, LiteralSource, Source } from '../../source';
import { Attrs, Vars } from "../../session"
import {
  Agent,
  Assistant,
  Conditional,
  Loop,
  Sequence,
  Subroutine,
  System,
  Transform,
  User,
} from '../../templates';
import { createWeatherTool, expect_types } from '../utils';

// Set up debug evnironment variable to set maxIterations

/**
 * End-to-End tests with real API calls
 *
 * **Important message**
 * - This test is a golden standard for the e2e workflow test
 * - This test should not be mocked
 * - This test should be run with real API calls
 * - This test should be run with real API keys
 */

const openAILLMSource = Source.llm()
  .openai()
  .model('gpt-4o-mini')
  .temperature(0.7);

const anthropicLLMSource = Source.llm()
  .anthropic()
  .model('claude-3-5-haiku-latest')
  .temperature(0.7);

describe('End-to-End Workflows with Real APIs', () => {
  it('should execute a simple conversation with OpenAI', async () => {
    const template = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(new User('Hello, how are you?'))
      .add(new Assistant(openAILLMSource));

    const session = await template.execute();

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
  });

  it('should execute a simple conversation with Anthropic', async () => {
    const template = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(new User('Hello, how are you?'))
      .add(new Assistant(anthropicLLMSource));

    const session = await template.execute();

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
    await chat.execute(Session.create({ print: true }));

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

  it('should handle context and metadata correctly', async () => {
    type UserContext = { username: string };
    type MessageMetadata = { timestamp?: Date };
    const initialContext: UserContext = {
      username: 'Alice',
    };
    const date = new Date();
    const template = new Sequence<MessageMetadata, UserContext>()
      .add(new System('You are a helpful assistant.'))
      .add(new Assistant('Hello, ${username}!'))
      .add(new User('My name is not Alice, it is Bob.'))
      // Update context with the last message
      .add(
        new Transform((session) => {
          const msgs = session.messages.map((m) => ({
            ...m,
            attrs: { ...m.attrs, timestamp: date },
          }));
          const next = Session.create<UserContext, MessageMetadata>({
            vars: session.vars,
            messages: msgs,
            print: session.print,
          });
          return next.withVar('username', 'Bob');
        }),
      );
    // Pass the raw initialContext object to Session.create
    const session = await template.execute(
      Session.create<UserContext>({ vars: initialContext }),
    );
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'assistant', 'user']);
    expect(messages[1].content).toContain('Hello, Alice!');
    expect(session.getVar('username')).toBe('Bob');
    console.log(
      'Messages with metadata:',
      messages.map((message) => message.attrs),
    );
    expect(
      messages
        .map((message) => message.attrs?.timestamp === date)
        .every((value) => value === true),
    ).toBe(true);
  });

  it('should execute agent and sequence', async () => {
    const sequence = new Sequence()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User('123456789'))
      .add(new Assistant(openAILLMSource));
    const session = await sequence.execute();
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
    expect(messages[2].content).toBeDefined();
    expect(messages[2].content).toContain('123456789');

    const agent = Agent.create()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User('123456789'))
      .add(new Assistant(openAILLMSource));
    const agentSession = await agent.execute();
    const agenMessages = Array.from(agentSession.messages) as Message[];
    expect(agenMessages).toHaveLength(3);
    expect_types(agenMessages, ['system', 'user', 'assistant']);
    expect(agenMessages[2].content).toBeDefined();
    expect(agenMessages[2].content).toContain('123456789');
  });

  it('should handle UserTemplate with InputSource', async () => {
    const template = new Sequence()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User(new LiteralSource('123456789')))
      .add(new Assistant(openAILLMSource));
    const session = await template.execute();
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
    expect(messages[2].content).toBeDefined();
    expect(messages[2].content).toContain('123456789');
  });

  it('should execute a if template', async () => {
    // thenTemplate
    const template = new Sequence()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User('YES'))
      .add(new Assistant(openAILLMSource))
      .add(
        new Conditional({
          condition: (session) => {
            const lastMessage = session.getLastMessage();
            return lastMessage!.content.toLowerCase().includes('yes');
          },
          thenTemplate: new User('You said YES'),
          elseTemplate: new User('You did not say YES'),
        }),
      );

    const session = await template.execute();
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect_types(messages, ['system', 'user', 'assistant', 'user']);
    expect(messages[3].content).toBeDefined();
    expect(messages[3].content).toContain('You said YES');

    // elseTemplate
    const template2 = new Sequence()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User('NO'))
      .add(new Assistant(openAILLMSource))
      .add(
        new Conditional({
          condition: (session) => {
            const lasMessage = session.getLastMessage();
            return lasMessage!.content.toLowerCase().includes('yes');
          },
          thenTemplate: new User('You said YES'),
          elseTemplate: new User('You did not say YES'),
        }),
      );
    const session2 = await template2.execute();
    const messages2 = Array.from(session2.messages);
    expect(messages2).toHaveLength(4);
    expect_types(messages2, ['system', 'user', 'assistant', 'user']);
    expect(messages2[3].content).toBeDefined();
    expect(messages2[3].content).toContain('You did not say YES');
  });

  it('should loop using LoopTemplate', async () => {
    // Exit loop if 3 messages are in session whose content is "123456789"
    const template = new Sequence()
      .add(
        new Sequence().add(new User('123456789')).loopIf((session) => {
          const messages = Array.from(session.messages);
          return (
            messages.filter((message) => message.content === '123456789')
              .length < 3
          );
        }),
      )
      .add(new Assistant('Loop ended'));

    const session = await template.execute();
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect_types(messages, ['user', 'user', 'user', 'assistant']);
    expect(messages[0].content).toBe('123456789');
    expect(messages[1].content).toBe('123456789');
    expect(messages[2].content).toBe('123456789');
    expect(messages[3].content).toBe('Loop ended');
  });

  it('should loop using Sequence().loopIf() is used', async () => {
    const template = new Sequence()
      .add(
        new Sequence()
          .add(new User('123456789'))
          .loopIf((session: Session<any, any>) => {
            return session.messages.length < 3;
          }),
      )
      .add(new Assistant('Loop ended'));
    const session = await template.execute();
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect_types(messages, ['user', 'user', 'user', 'assistant']);
    expect(messages[0].content).toBe('123456789');
    expect(messages[1].content).toBe('123456789');
    expect(messages[2].content).toBe('123456789');
    expect(messages[3].content).toBe('Loop ended');
  });

  it('should Agent have addXXXX methods', async () => {
    // Increase the timeout for this test
    vi.setConfig({ testTimeout: 15000 });
    // Each have system, user, assistant, conditional
    const sequence = Agent.create()
      .system('This is automated API testing. Repeat what user says.')
      .user('123456789')
      .assistant(openAILLMSource)
      .conditional(
        (session) => {
          const lastMessage = session.getLastMessage();
          return lastMessage!.content.toLowerCase().includes('123456789');
        },
        (agent) => agent.user('YES'),
        (agent) => agent.user('NO'),
      );
    const session = await sequence.execute();
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect_types(messages, ['system', 'user', 'assistant', 'user']);
    expect(messages[3].content).toBeDefined();
    expect(messages[3].content).toContain('YES');

    // Define the source for user content within the loop
    const userContentSource = new ListSource(['123456789', '987654321']);

    // Define the body of the loop as a Agent
    const loopBodySequence = Agent.create<Vars<{ count: number }>>()
      .system('This is automated API testing. Repeat what user says.')
      .user(userContentSource)
      .assistant(openAILLMSource)
      .conditional(
        (session: Session) => {
          // Add type annotation
          const lastMessage = session.getLastMessage();
          // Safely check lastMessage and its content
          return (
            lastMessage?.content?.toLowerCase().includes('123456789') ?? false
          );
        },
        (agent) => agent.user('Condition MET: User said 123456789'),
      );

    // Define the exit condition for the loop
    // Add a transform to increment count in the loop body
    const loopBodySequenceWithTransform = loopBodySequence.transform(
      (session: Session<Vars<{ count: number }>>) => {
        const currentCount =
          (session.getVar('count') as number | undefined) ?? 0;
        return session.withVar('count', currentCount + 1);
      },
    );

    // Define the exit condition for the loop (pure check)
    const loopExitCondition = (
      session: Session<Vars<{ count: number }>>,
    ): boolean => {
      const updatedCount = (session.getVar('count') as number | undefined) ?? 0;
      // Loop twice (count 0, 1) -> exit when count reaches 2
      // There are two items in the static list, so exit after two iterations
      return updatedCount < 2;
    };

    // Instantiate the LoopTemplate correctly and specify generic type
    const loop = new Loop<any, Vars<{ count: number }>>({
      bodyTemplate: loopBodySequenceWithTransform,
      loopIf: loopExitCondition,
    });

    // Execute the loop, starting context count at 0
    const session2 = await loop.execute(
      Session.create({ vars: { count: 0 } }),
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
    expect(session2.getVar('count')).toBe(2);

    // Removed misplaced commented code
  });

  it('should execute a subroutine template', async () => {
    // Inherit from parent and merge back to parent
    const subroutineBody = new Sequence()
      .add(new System('This is automated API testing. Repeat what user says.'))
      .add(new User('123456789'))
      .add(new Assistant(openAILLMSource));

    // Create a subroutine template with the body
    const subroutine = new Subroutine(subroutineBody);

    // Execute the subroutine
    const session = await subroutine.execute();

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

    const openAIgenerateOptionsWith = openAILLMSource.addTool(
      'weather',
      weatherTool,
    );

    const template = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(new User('What is the weather in Tokyo?'))
      .add(new Assistant(openAIgenerateOptionsWith));

    const session = await template.execute();

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect_types(messages, ['system', 'user', 'assistant', 'tool_result']);

    expect(messages[2].toolCalls).toBeDefined();
    const toolCalls = messages[2].toolCalls!;
    expect(toolCalls[0].name).toBe('weather');

    // Verify the tool result message
    expect(messages[3].type).toBe('tool_result');
    expect(messages[3].content).toBeDefined();
  });

  it('should execute a conversation with a loop and user input', async () => {
    // Use StaticSource instead of CLISource to avoid waiting for user input
    // Only one response: "no" to exit the loop immediately
    const continueResponses = new ListSource(['Yes', 'No']);

    const template = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(
        new Loop({
          bodyTemplate: new Sequence()
            .add(new User(new LiteralSource('What is your name?')))
            .add(new Assistant(openAILLMSource))
            .add(new User(continueResponses)),
          loopIf: (session) => {
            // User(continueResponses) is the last message
            const lastMessage = session.getLastMessage();
            return (
              lastMessage?.type === 'system' ||
              (lastMessage?.type === 'user' &&
                lastMessage.content.toLowerCase().includes('yes'))
            );
          },
        }),
      );

    const session = await template.execute();

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(7);
    expect_types(messages, [
      'system',
      'user',
      'assistant',
      'user',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[1].content).toBe('What is your name?');
    expect(messages[3].content).toBe('Yes');
    expect(messages[6].content).toBe('No');
  });
});
