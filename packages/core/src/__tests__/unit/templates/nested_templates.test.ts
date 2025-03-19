import { describe, it, expect } from 'vitest';
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
import { Model } from '../../../model/base';
import type { Session, ModelConfig } from '../../../types';

// Create a mock model for testing
class MockModel extends Model<ModelConfig> {
  constructor(private responses: string[] = ['Mock response']) {
    super({
      modelName: 'mock-model',
      temperature: 0.7,
    });
  }

  async send(_session: Session): Promise<unknown> {
    const response = this.responses.shift() || 'Default mock response';
    return {
      type: 'assistant',
      content: response,
      metadata: createMetadata(),
    };
  }

  async *sendAsync(): AsyncGenerator<unknown, void, unknown> {
    throw new Error('Not implemented');
  }

  protected formatTool(): Record<string, unknown> {
    throw new Error('Not implemented');
  }

  protected validateConfig(): void {}
}

describe('Nested Templates', () => {
  it('should execute deeply nested templates', async () => {
    // Create a mock model with specific responses
    const mockModel = new MockModel([
      'Response to first question',
      'Response to second question',
      'Final response',
    ]);

    // Create a complex nested template structure
    // Note: We're using array-based construction instead of chaining for templates
    // that don't have specific add methods
    const ifTemplate = new IfTemplate({
      condition: () => true, // Always true for this test
      thenTemplate: new LinearTemplate()
        .addUser('First question')
        .addAssistant({ model: mockModel }),
      elseTemplate: new SystemTemplate({ content: 'Condition was false' }),
    });

    const loopTemplate = new LoopTemplate()
      .addUser('Second question')
      .addAssistant({ model: mockModel })
      .addUser('Follow-up question')
      .setExitCondition((session: Session) => {
        // Exit after one iteration
        const messages = Array.from(session.messages);
        return messages.length >= 5; // System + First Q&A + Second Q&A
      });

    const subroutineTemplate = new SubroutineTemplate({
      template: new LinearTemplate()
        .addUser('Final question')
        .addAssistant({ model: mockModel }),
      initWith: (_parentSession: Session) => createSession(),
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
    // Create a mock model
    const mockModel = new MockModel(['Response with metadata']);

    // Create a session with metadata
    const session = createSession();
    session.metadata.set('username', 'Alice');
    session.metadata.set('topic', 'TypeScript');

    // Create a template with nested templates that use the metadata
    const subroutineTemplate = new SubroutineTemplate({
      template: new LinearTemplate()
        .addUser('Tell me about ${topic}.')
        .addAssistant({ model: mockModel }),
      initWith: (_parentSession: Session) => {
        // Copy metadata from parent to child
        const childSession = createSession();
        childSession.metadata.set(
          'username',
          _parentSession.metadata.get('username'),
        );
        childSession.metadata.set('topic', _parentSession.metadata.get('topic'));
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
    // Create a mock model
    const mockModel = new MockModel(['Response A', 'Response B']);

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
          .addAssistant({ model: mockModel })
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
          .addAssistant({ model: mockModel }),
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
