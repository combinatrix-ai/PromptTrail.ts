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
import {
  Sequence,
  LoopTemplate,
  SystemTemplate,
  UserTemplate,
  AssistantTemplate,
  Agent,
} from '../../templates';
import { createMetadata } from '../../metadata';
import { createGenerateOptions } from '../../generate_options';
import { CLISource, StaticListSource, StaticSource } from '../../content_source';
import { createWeatherTool, expect_types } from './test_utils';

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
      .add(new SystemTemplate('You are a helpful assistant.'))
      .add(new UserTemplate('Hello, how are you?'))
      .add(new AssistantTemplate(openAIgenerateOptions));

    const session = await template.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
  });

  it('should execute a simple conversation with Anthropic', async () => {
    const template = new Sequence()
      .add(new SystemTemplate('You are a helpful assistant.'))
      .add(new UserTemplate('Hello, how are you?'))
      .add(new AssistantTemplate(anthroGenerateOptions));

    const session = await template.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
  });

  it('should handle print mode with console.log', async () => {
    // Spy on console.log
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

    // Create a template
    const chat = new Sequence()
      .add(new SystemTemplate("I'm a helpful assistant."))
      .add(new UserTemplate("What's TypeScript?"))
      .add(new AssistantTemplate('This is a mock response from the AI model.'));

    // Execute the template with print mode enabled
    // We only care about the side effect of console.log being called
    await chat.execute(createSession({ print: true }));

    // Verify console.log was called for each message
    expect(consoleSpy).toHaveBeenCalledTimes(3);

    // Restore console.log
    consoleSpy.mockRestore();
  });

  it('should handle metadata correctly', async () => {
    // createMetadata accepts interface
    interface UserMetadata extends Record<string, string> {
      username: string;
    }
    const metadata = createMetadata<UserMetadata>({
      username: 'Alice',
    });
    const template = new Sequence()
      .add(new SystemTemplate('You are a helpful assistant.'))
      // Interpolating metadata into the user message
      .add(new AssistantTemplate("Hello, {username}!"))
      .add(new UserTemplate('My name is not Alice, it is Bob.'))
      // Update metadata with the last message
      .addTransform(
        (session) => {
          // Change name Alice to Bob
          session.metadata.set('username', 'Bob');
          return session;
        },
      );
    const session = await template.execute(createSession<UserMetadata>(metadata));
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
    expect(messages[1].content).toContain('Alice!');
    expect(session.metadata.get('username')).toBe('Bob');
  });

  it('should execute agent and sequence', async () => {
    const sequence = new Sequence()
      .add(new SystemTemplate('This is automated API testing. Repeat what user says.'))
      .add(new UserTemplate('123456789'))
      .add(new AssistantTemplate(openAIgenerateOptions));
    const session = await sequence.execute(createSession());
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
    expect(messages[2].content).toBeDefined();
    expect(messages[2].content).toContain('123456789');

    const agent = new Agent()
      .add(new SystemTemplate('This is automated API testing. Repeat what user says.'))
      .add(new UserTemplate('123456789'))
      .add(new AssistantTemplate(openAIgenerateOptions));
    const agentSession = await agent.execute(createSession());
    const agentMessages = Array.from(agentSession.messages);
    expect(agentMessages).toHaveLength(3);
    expect_types(agentMessages, ['system', 'user', 'assistant']);
    expect(agentMessages[2].content).toBeDefined();
    expect(agentMessages[2].content).toContain('123456789');
  });

  it('should UserTemplate handle InputSource', async () => {
    const template = new Sequence()
      .add(new SystemTemplate('This is automated API testing. Repeat what user says.'))
      .add(new UserTemplate(new StaticSource('123456789')))
      .add(new AssistantTemplate(openAIgenerateOptions));
    const session = await template.execute(createSession());
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
    expect(messages[2].content).toBeDefined();
    expect(messages[2].content).toContain('123456789');
  });

  it('should execute a if template', async () => {
    const template = new Sequence()
      .add(new SystemTemplate('This is automated API testing. Repeat what user says.'))
      .add(new UserTemplate('YES'))
      .add(new AssistantTemplate(openAIgenerateOptions))
      .addIf(
        (session) => {
          const lastMessage = session.getLastMessage();
          return (
            lastMessage!.content.toLowerCase().includes('yes')
          );
        },
        new UserTemplate('You said YES'),
        new UserTemplate('You did not say YES'),
      )

    const session = await template.execute(createSession());
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect_types(messages, ['system', 'user', 'assistant', 'user']);
    expect(messages[3].content).toBeDefined();
    expect(messages[3].content).toContain('You said YES');

    const template2 = new Sequence()
      .add(new SystemTemplate('This is automated API testing. Repeat what user says.'))
      .add(new UserTemplate('NO'))
      .add(new AssistantTemplate(openAIgenerateOptions))
      .addIf(
        (session) => {
          const lastMessage = session.getLastMessage();
          return (
            lastMessage!.content.toLowerCase().includes('yes')
          );
        },
        new UserTemplate('You said YES'),
        new UserTemplate('You did not say YES'),
      )
    const session2 = await template2.execute(createSession());
    const messages2 = Array.from(session2.messages);
    expect(messages2).toHaveLength(4);
    expect_types(messages2, ['system', 'user', 'assistant', 'user']);
    expect(messages2[3].content).toBeDefined();
    expect(messages2[3].content).toContain('You did not say YES');
  });

  it('should loop if LoopTemplate is used or Seuqnce().loopIf() is used', async () => {
    const template = new Sequence()
      .add(new UserTemplate('123456789'))
      .loopIf(
        (session) => {
          session.metadata.set('count', session.metadata.get('count') + 1);
          return session.metadata.get('count') < 3;
        },
      );
    const session = await template.execute(createSession());
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);

    const using_loop = new LoopTemplate(
      // set condition
      (session) => {
        session.metadata.set('count', session.metadata.get('count') + 1);
        return session.metadata.get('count') < 3;
      }
    )
      .add(new UserTemplate('123456789'))

    const session2 = await using_loop.execute(createSession());
    const messages2 = Array.from(session2.messages);
    expect(messages2).toHaveLength(3);

  });

  it('should templates with linear child templates (sequence, loop) have addXXX methods', async () => {
    // Each have addSystem, addUser, addAssistant, addIf
    const sequence = new Sequence()
      .addSystem('This is automated API testing. Repeat what user says.')
      .addUser('123456789')
      .addAssistant(openAIgenerateOptions)
      .addIf(
        (session) => {
          const lastMessage = session.getLastMessage();
          return (
            lastMessage!.content.toLowerCase().includes('123456789')
          );
        },
        new UserTemplate('YES'),
        new UserTemplate('NO'),
      );
    const session = await sequence.execute(createSession());
    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect_types(messages, ['system', 'user', 'assistant', 'user']);
    expect(messages[3].content).toBeDefined();
    expect(messages[3].content).toContain('YES');

    const userContentSource = new StaticListSource(['123456789', '987654321'])
    const loop = new LoopTemplate(
      // just loop twice
      (session) => { session.metadata.set('count', session.metadata.get('count', 0) + 1); return session.metadata.get('count') < 2; }
    )
      .addSystem('This is automated API testing. Repeat what user says.')
      .addUser(userContentSource)
      .addAssistant(openAIgenerateOptions)
      .addIf(
        (session) => {
          const lastMessage = session.getLastMessage();
          return (
            lastMessage!.content.toLowerCase().includes('123456789')
          );
        },
        new UserTemplate('YES'),
        new UserTemplate('NO'),
      );
    const session2 = await loop.execute(createSession());
    const messages2 = Array.from(session2.messages);
    expect(messages2).toHaveLength(8);
    expect_types(messages2, ['system', 'user', 'assistant', 'user', 'system', 'user', 'assistant', 'user']);
    expect(messages2[3].content).toBeDefined();
    expect(messages2[3].content).toContain('YES');
    expect(messages2[7].content).toBeDefined();
    expect(messages2[7].content).toContain('NO');
  }
  );

  it('should execute a subroutine template', async () => {
    // Inherit from parent and merge back to parent
    const subroutine = new Sequence()
      .add(new SystemTemplate('This is automated API testing. Repeat what user says.'))
      .add(new UserTemplate('123456789'))
      .add(new AssistantTemplate(openAIgenerateOptions));



  };

  it('should execute a conversation with weather tool', async () => {
    const weatherTool = createWeatherTool();

    const openAIgenerateOptionsWith = openAIgenerateOptions.clone().addTool('weather', weatherTool);

    const template = new Sequence()
      .add(new SystemTemplate('You are a helpful assistant.'))
      .add(new UserTemplate('What is the weather in Tokyo?'))
      .add(new AssistantTemplate(openAIgenerateOptionsWith));

    const session = await template.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_types(messages, ['system', 'user', 'assistant']);
    expect(messages[2].toolCalls).toBe(true);

    const toolResults = session.metadata.get('toolResults');
    if (toolResults) {
      expect(Array.isArray(toolResults)).toBe(true);
    }
  });

  it('should execute a conversation with a loop and user input', async () => {

    const template = new Sequence()
      .add(new SystemTemplate('You are a helpful assistant.'))
      .add(
        new LoopTemplate({
          bodyTemplate: new Sequence()
            .add(new UserTemplate(new StaticSource('What is your name?')))
            .add(new AssistantTemplate(openAIgenerateOptions))
            .add(new UserTemplate(new CLISource('Should we continue? (yes/no): '))),
          exitCondition: (session) => {
            const lastMessage = session.getLastMessage();
            return (
              lastMessage?.type === 'user' &&
              lastMessage.content.toLowerCase().includes('no')
            );
          },
        }),
      );

    const session = await template.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(4);
    expect_types(messages, ['system', 'user', 'assistant', 'user']);

    expect(messages[1].content).toBe('Tell me something interesting.');
    expect(messages[3].content).toBe('Should we continue? (yes/no): no');
  });
});
