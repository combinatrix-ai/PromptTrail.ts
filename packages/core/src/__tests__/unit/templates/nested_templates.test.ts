import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LinearTemplate,
  LoopTemplate,
  SystemTemplate,
  UserTemplate,
  SubroutineTemplate,
  IfTemplate,
} from '../../../templates';
import { createSession } from '../../../session';
import { createMetadata } from '../../../metadata';
import { generateText } from '../../../generate';
import type { GenerateOptions } from '../../../generate';
import type { Session } from '../../../types';

// Mock the generateText function
vi.mock('../../../generate', () => {
  return {
    generateText: vi.fn(),
  };
});

describe('Nested Templates', () => {
  let generateOptions: GenerateOptions;
  let responseIndex: number;
  const mockResponses = [
    'Response to first question',
    'Response to second question',
    'Final response',
    'Response with metadata',
    'Response A',
    'Response B',
  ];

  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();
    responseIndex = 0;

    // Create generateOptions
    generateOptions = {
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    };

    // Setup mock implementation for generateText
    vi.mocked(generateText).mockImplementation(async () => {
      const response =
        mockResponses[responseIndex++] || 'Default mock response';
      return {
        type: 'assistant',
        content: response,
        metadata: createMetadata(),
      };
    });
  });

  it('should execute deeply nested templates', async () => {
    // Create a complex nested template structure
    // Note: We're using array-based construction instead of chaining for templates
    // that don't have specific add methods
    const ifTemplate = new IfTemplate({
      condition: () => true, // Always true for this test
      thenTemplate: new LinearTemplate()
        .addUser('First question')
        .addAssistant({ generateOptions }),
      elseTemplate: new SystemTemplate({ content: 'Condition was false' }),
    });

    const loopTemplate = new LoopTemplate()
      .addUser('Second question')
      .addAssistant({ generateOptions })
      .addUser('Follow-up question')
      .setExitCondition((session: Session) => {
        // Exit after one iteration
        const messages = Array.from(session.messages);
        return messages.length >= 5; // System + First Q&A + Second Q&A
      });

    const subroutineTemplate = new SubroutineTemplate({
      template: new LinearTemplate()
        .addUser('Final question')
        .addAssistant({ generateOptions }),
      initWith: () => createSession(), // Don't need parent session in this test
      squashWith: (parentSession, childSession) => {
        // Create a new session with all messages from both sessions
        let result = parentSession;
        const childMessages = Array.from(childSession.messages);
        for (const message of childMessages) {
          result = result.addMessage(message);
        }
        return result;
      },
    });

    // Combine templates using array-based construction
    const template = new LinearTemplate([
      new SystemTemplate({ content: 'You are a helpful assistant.' }),
      ifTemplate,
      loopTemplate,
      subroutineTemplate,
    ]);

    // Execute the template
    const session = await template.execute(createSession());

    // Verify the conversation flow
    const messages = Array.from(session.messages);

    // Check the number of messages
    // 1 system + 1 user + 1 assistant + 1 user + 1 assistant + 1 user + 1 user + 1 assistant = 8
    expect(messages).toHaveLength(8);

    // Check message types
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
    expect(messages[3].type).toBe('user');
    expect(messages[4].type).toBe('assistant');
    expect(messages[5].type).toBe('user');
    expect(messages[6].type).toBe('user');
    expect(messages[7].type).toBe('assistant');

    // Check message content
    expect(messages[0].content).toBe('You are a helpful assistant.');
    expect(messages[1].content).toBe('First question');
    expect(messages[2].content).toBe('Response to first question');
    expect(messages[3].content).toBe('Second question');
    expect(messages[4].content).toBe('Response to second question');
    expect(messages[5].content).toBe('Follow-up question');
    expect(messages[6].content).toBe('Final question');
    expect(messages[7].content).toBe('Final response');
  });

  it('should handle nested templates with shared metadata', async () => {
    // Reset response index for this test
    responseIndex = 3; // Index for 'Response with metadata'

    // Create a session with metadata
    const session = createSession();
    session.metadata.set('username', 'Alice');
    session.metadata.set('topic', 'TypeScript');

    // Create a template with nested templates that use the metadata
    const subroutineTemplate = new SubroutineTemplate({
      template: new LinearTemplate()
        .addUser('Tell me about ${topic}.')
        .addAssistant({ generateOptions }),
      initWith: (_parentSession: Session) => {
        // Copy metadata from parent to child
        const childSession = createSession();
        childSession.metadata.set(
          'username',
          _parentSession.metadata.get('username'),
        );
        childSession.metadata.set(
          'topic',
          _parentSession.metadata.get('topic'),
        );
        return childSession;
      },
      squashWith: (_parentSession, childSession) => {
        // Create a new session with all messages from both sessions
        let result = _parentSession;
        const childMessages = Array.from(childSession.messages);
        for (const message of childMessages) {
          result = result.addMessage(message);
        }
        return result;
      },
    });

    const template = new LinearTemplate([
      new SystemTemplate({ content: 'Hello, ${username}!' }),
      subroutineTemplate,
    ]);

    // Execute the template
    const result = await template.execute(session);

    // Verify the conversation flow
    const messages = Array.from(result.messages);

    // Check the number of messages
    expect(messages).toHaveLength(3);

    // Check message types and content
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('Hello, Alice!');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Tell me about TypeScript.');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('Response with metadata');
  });

  it('should handle complex conditional logic in nested templates', async () => {
    // Reset response index for this test
    responseIndex = 4; // Index for 'Response A' and 'Response B'

    // Create a session with a condition flag
    const session = createSession();
    session.metadata.set('condition', true);

    // Create a template with nested conditional templates
    const template = new LinearTemplate()
      .addSystem('Conditional template test')
      // First level condition
      .addIf({
        condition: (session) => Boolean(session.metadata.get('condition')),
        thenTemplate: new LinearTemplate()
          .addUser('Question when condition is true')
          .addAssistant({ generateOptions })
          // Nested condition
          .addIf({
            condition: (session) => {
              // Check if the last message contains a specific text
              const lastMessage = session.getLastMessage();
              return lastMessage?.content.includes('Response A') ?? false;
            },
            thenTemplate: new UserTemplate({
              description: 'Follow-up question',
              default: 'Follow-up when response contains "Response A"',
            }),
            elseTemplate: new UserTemplate({
              description: 'Alternative follow-up',
              default: 'This should not be added',
            }),
          }),
        elseTemplate: new LinearTemplate()
          .addUser('Question when condition is false')
          .addAssistant({ generateOptions }),
      });

    // Execute the template
    const result = await template.execute(session);

    // Verify the conversation flow
    const messages = Array.from(result.messages);

    // Check the number of messages
    expect(messages).toHaveLength(4);

    // Check message types and content
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe('Conditional template test');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Question when condition is true');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('Response A');
    expect(messages[3].type).toBe('user');
    expect(messages[3].content).toBe(
      'Follow-up when response contains "Response A"',
    );

    // Now test with condition = false
    const session2 = createSession();
    session2.metadata.set('condition', false);

    const result2 = await template.execute(session2);
    const messages2 = Array.from(result2.messages);

    // Check the number of messages
    expect(messages2).toHaveLength(3);

    // Check message types and content
    expect(messages2[0].type).toBe('system');
    expect(messages2[0].content).toBe('Conditional template test');
    expect(messages2[1].type).toBe('user');
    expect(messages2[1].content).toBe('Question when condition is false');
    expect(messages2[2].type).toBe('assistant');
    expect(messages2[2].content).toBe('Response B');
  });
});
