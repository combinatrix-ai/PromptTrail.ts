import { describe, it, expect, vi } from 'vitest';
import type { Session } from '../../../session';
import { createSession } from '../../../session';
import {
  LinearTemplate,
  LoopTemplate,
  SystemTemplate,
  UserTemplate,
  AssistantTemplate,
  SubroutineTemplate,
  IfTemplate,
} from '../../../templates';
import { CallbackInputSource } from '../../../input_source';
import type { Message, ModelConfig } from '../../../types';
import { Model } from '../../../model/base';
import { createMetadata } from '../../../metadata';

class MockModel extends Model<ModelConfig> {
  constructor(private responses: string[]) {
    super({
      modelName: 'mock-model',
      temperature: 0,
    });
  }

  async send(): Promise<Message> {
    // We don't need any session parameter in this mock implementation
    const response = this.responses.shift();
    if (!response) throw new Error('No more mock responses');
    return {
      type: 'assistant',
      content: response,
      metadata: createMetadata(),
    };
  }

  async *sendAsync(): AsyncGenerator<Message, void, unknown> {
    // Add yield to satisfy generator function requirement
    if (this.responses.length > 1000) yield { type: 'assistant', content: '', metadata: createMetadata() };
    throw new Error('Not implemented');
  }

  protected formatTool(): Record<string, unknown> {
    throw new Error('Not implemented');
  }

  protected validateConfig(): void {}
}

describe('Templates', () => {
  describe('LinearTemplate with Loop', () => {
    it('should execute a math teacher conversation flow (array-based)', async () => {
      // Create mock model
      const mockModel = new MockModel([
        'Dividing a number by zero is undefined in mathematics because...',
        'END',
      ]);

      // Create the template structure
      const template = new LinearTemplate([
        new SystemTemplate({
          content: "You're a math teacher bot.",
        }),
        new LoopTemplate({
          templates: [
            new UserTemplate({
              description: "Let's ask a question to AI:",
              default: "Why can't you divide a number by zero?",
            }),
            new AssistantTemplate({
              model: mockModel,
            }),
            new AssistantTemplate({
              content: 'Are you satisfied?',
            }),
            new UserTemplate({
              description: 'Input:',
              default: 'Yes.',
            }),
            new AssistantTemplate({
              content:
                'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
            }),
            new AssistantTemplate({
              model: mockModel,
            }),
          ],
          exitCondition: (session: Session) => {
            const lastMessage = session.getLastMessage();
            return lastMessage?.content.includes('END') ?? false;
          },
        }),
      ]);

      // Create an initial session
      const session = createSession();

      // Execute the template
      const result = await template.execute(session);

      // Verify the conversation flow
      const messages = Array.from(result.messages);

      // Get the actual content from the messages (unused in this test but useful for debugging)
      // const actualContents = messages.map((msg) => msg.content);

      // Verify the conversation flow structure
      expect(messages).toHaveLength(7);
      expect(messages[0].type).toBe('system');
      expect(messages[1].type).toBe('user');
      expect(messages[2].type).toBe('assistant');
      expect(messages[3].type).toBe('assistant');
      expect(messages[4].type).toBe('user');
      expect(messages[5].type).toBe('assistant');
      expect(messages[6].type).toBe('assistant');

      // Verify specific content that should be consistent
      expect(messages[0].content).toBe("You're a math teacher bot.");
      expect(messages[2].content).toBe(
        'Dividing a number by zero is undefined in mathematics because...',
      );
      expect(messages[3].content).toBe('Are you satisfied?');
      expect(messages[5].content).toBe(
        'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
      );
      expect(messages[6].content).toBe('END');

      // No need to verify mock calls as MockModel handles responses directly
    });

    it('should execute a math teacher conversation flow (chaining API)', async () => {
      // Create mock model
      const mockModel = new MockModel([
        'Dividing a number by zero is undefined in mathematics because...',
        'END',
      ]);

      // Create the template structure using chaining API
      const template = new LinearTemplate()
        .addSystem("You're a math teacher bot.")
        .addLoop(
          new LoopTemplate()
            .addUser(
              "Let's ask a question to AI:",
              "Why can't you divide a number by zero?",
            )
            .addAssistant({ model: mockModel })
            .addAssistant('Are you satisfied?')
            .addUser('Input:', 'Yes.')
            .addAssistant(
              'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
            )
            .addAssistant({ model: mockModel })
            .setExitCondition(
              (session: Session) =>
                session.getLastMessage()?.content.includes('END') ?? false,
            ),
        );

      // Create an initial session
      const session = createSession();

      // Execute the template
      const result = await template.execute(session);

      // Verify the conversation flow
      const messages = Array.from(result.messages);

      // Get the actual content from the messages (unused in this test but useful for debugging)
      // const actualContents = messages.map((msg) => msg.content);

      // Verify the conversation flow structure
      expect(messages).toHaveLength(7);
      expect(messages[0].type).toBe('system');
      expect(messages[1].type).toBe('user');
      expect(messages[2].type).toBe('assistant');
      expect(messages[3].type).toBe('assistant');
      expect(messages[4].type).toBe('user');
      expect(messages[5].type).toBe('assistant');
      expect(messages[6].type).toBe('assistant');

      // Verify specific content that should be consistent
      expect(messages[0].content).toBe("You're a math teacher bot.");
      expect(messages[2].content).toBe(
        'Dividing a number by zero is undefined in mathematics because...',
      );
      expect(messages[3].content).toBe('Are you satisfied?');
      expect(messages[5].content).toBe(
        'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
      );
      expect(messages[6].content).toBe('END');

      // No need to verify mock calls as MockModel handles responses directly
    });

    it('should handle multiple loop iterations when user is not satisfied', async () => {
      // Create mock model for multiple iterations
      const mockModel = new MockModel([
        'First explanation about division by zero...',
        'RETRY',
        'Second, more detailed explanation...',
        'END',
      ]);

      const template = new LinearTemplate([
        new SystemTemplate({
          content: "You're a math teacher bot.",
        }),
        new LoopTemplate({
          templates: [
            new UserTemplate({
              description: "Let's ask a question to AI:",
              default: "Why can't you divide a number by zero?",
            }),
            new AssistantTemplate({
              model: mockModel,
            }),
            new AssistantTemplate({
              content: 'Are you satisfied?',
            }),
            new UserTemplate({
              description: 'Input:',
              default: 'No, please explain more.',
            }),
            new AssistantTemplate({
              content:
                'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
            }),
            new AssistantTemplate({
              model: mockModel,
            }),
          ],
          exitCondition: (session: Session) => {
            const lastMessage = session.getLastMessage();
            return lastMessage?.content.includes('END') ?? false;
          },
        }),
      ]);

      const session = createSession();
      const result = await template.execute(session);

      // Verify multiple iterations occurred
      const messages = Array.from(result.messages);

      expect(
        messages.map((msg) => ({
          ...msg,
          metadata: msg.metadata ? msg.metadata.toJSON() : {},
        })),
      ).toEqual([
        {
          type: 'system',
          content: "You're a math teacher bot.",
          metadata: {},
        },
        {
          type: 'user',
          content: "Why can't you divide a number by zero?",
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'First explanation about division by zero...',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'Are you satisfied?',
          metadata: {},
        },
        {
          type: 'user',
          content: 'No, please explain more.',
          metadata: {},
        },
        {
          type: 'assistant',
          content:
            'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'RETRY',
          metadata: {},
        },
        {
          type: 'user',
          content: "Why can't you divide a number by zero?",
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'Second, more detailed explanation...',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'Are you satisfied?',
          metadata: {},
        },
        {
          type: 'user',
          content: 'No, please explain more.',
          metadata: {},
        },
        {
          type: 'assistant',
          content:
            'The user has stated their feedback. If you think the user is satisfied, you must answer `END`. Otherwise, you must answer `RETRY`.',
          metadata: {},
        },
        {
          type: 'assistant',
          content: 'END',
          metadata: {},
        },
      ]);

      // No need to verify mock calls as MockModel handles responses directly
    });
  });

  describe('UserTemplate', () => {
    it('should support string constructor', async () => {
      const template = new UserTemplate('test description');
      const session = await template.execute(createSession());
      const messages = session.getMessagesByType('user');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('');
    });

    it('should support options object constructor', async () => {
      const template = new UserTemplate({
        description: 'test description',
        default: 'default value',
      });
      const session = await template.execute(createSession());
      const messages = session.getMessagesByType('user');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('default value');
    });

    it('should support custom input source', async () => {
      const inputSource = new CallbackInputSource(async () => 'custom input');
      const template = new UserTemplate({
        description: 'test description',
        inputSource,
      });
      const session = await template.execute(createSession());
      const messages = session.getMessagesByType('user');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('custom input');
    });

    it('should validate input', async () => {
      const inputSource = new CallbackInputSource(async () => 'valid input');
      const validate = vi
        .fn()
        .mockImplementation((input: string) =>
          Promise.resolve(input === 'valid input'),
        );

      const template = new UserTemplate({
        description: 'test description',
        inputSource,
        validate,
      });

      const session = await template.execute(createSession());
      const messages = session.getMessagesByType('user');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('valid input');
      expect(validate).toHaveBeenCalledWith('valid input');
    });

    it('should call onInput callback', async () => {
      const onInput = vi.fn();
      const template = new UserTemplate({
        description: 'test description',
        default: 'test input',
        onInput,
      });

      await template.execute(createSession());
      expect(onInput).toHaveBeenCalledWith('test input');
    });
  });

  describe('Template Interpolation', () => {
    it('should interpolate basic variables in SystemTemplate', async () => {
      const session = createSession();
      session.metadata.set('name', 'John');

      const template = new SystemTemplate({
        content: 'Hello ${name}!',
      });

      const result = await template.execute(session);
      expect(result.getLastMessage()?.content).toBe('Hello John!');
    });

    it('should interpolate nested objects in UserTemplate', async () => {
      const session = createSession();
      session.metadata.set('user', {
        preferences: { language: 'TypeScript' },
      });

      const template = new UserTemplate({
        description: 'Programming in ${user.preferences.language}',
        default: 'I love ${user.preferences.language}!',
        inputSource: new CallbackInputSource(async () => 'I love TypeScript!'),
      });

      const result = await template.execute(session);
      expect(result.getLastMessage()?.content).toBe('I love TypeScript!');
    });

    it('should handle missing variables gracefully', async () => {
      const session = createSession();
      session.metadata.set('name', 'John');
      // Intentionally not setting 'age'

      const template = new SystemTemplate({
        content: 'Hello ${name}, your age is ${age}!',
      });

      const result = await template.execute(session);
      expect(result.getLastMessage()?.content).toBe(
        'Hello John, your age is !',
      );
    });

    it('should work with AssistantTemplate', async () => {
      const session = createSession();
      session.metadata.set('topic', 'TypeScript');
      session.metadata.set('version', '5.0');

      const template = new AssistantTemplate({
        content: 'Let me tell you about ${topic} version ${version}',
      });

      const result = await template.execute(session);
      expect(result.getLastMessage()?.content).toBe(
        'Let me tell you about TypeScript version 5.0',
      );
    });

    it('should work with template chains', async () => {
      const session = createSession();
      session.metadata.set('topic', 'TypeScript');
      session.metadata.set('student', 'John');

      const template = new LinearTemplate()
        .addSystem('Teaching ${topic} to ${student}')
        .addUser('What is ${topic}?', 'What is ${topic}?')
        .addAssistant('${topic} is a programming language');

      const result = await template.execute(session);
      const messages = Array.from(result.messages);

      expect(messages[0].content).toBe('Teaching TypeScript to John');
      expect(messages[1].content).toBe('What is TypeScript?');
      expect(messages[2].content).toBe('TypeScript is a programming language');
    });
  });

  describe('SubroutineTemplate', () => {
    it('should execute child template with separate session', async () => {
      const session = createSession();
      session.metadata.set('parentValue', 'parent');

      const childTemplate = new LinearTemplate()
        .addSystem('Child system message')
        .addAssistant('Child response');

      const template = new SubroutineTemplate({
        template: childTemplate,
        initWith: () => {
          // Parent session not needed in this test
          const childSession = createSession();
          childSession.metadata.set('childValue', 'child');
          return childSession;
        },
      });

      const result = await template.execute(session);

      // Parent session should be unchanged
      expect(result.metadata.get('parentValue')).toBe('parent');
      expect(result.messages).toHaveLength(0);
    });

    it('should merge results with squashWith', async () => {
      const session = createSession();
      const childTemplate = new LinearTemplate()
        .addSystem('Child system message')
        .addAssistant('Child response');

      const template = new SubroutineTemplate({
        template: childTemplate,
        initWith: () => createSession(), // Parent session not needed
        squashWith: (parentSession: Session) => {
          // Child session not needed in this test
          return parentSession.addMessage({
            type: 'system',
            content: 'Merged child messages',
            metadata: createMetadata(),
          });
        },
      });

      const result = await template.execute(session);

      // Parent session should be updated with merged message
      expect(result.messages).toHaveLength(1);
      expect(result.getLastMessage()?.content).toBe('Merged child messages');
    });

    it('should work with nested templates', async () => {
      const mockModel = new MockModel(['Child response', 'Parent response']);

      const childTemplate = new LinearTemplate()
        .addSystem('Child context')
        .addAssistant({ model: mockModel });

      // This template is defined but not used in this test
      // const parentTemplate = new LinearTemplate()
      //   .addSystem('Parent context')
      //   .addAssistant({ model: mockModel })
      //   .addLoop(
      //     new LoopTemplate()
      //       .addUser('Input:', 'test')
      //       .addAssistant('Response')
      //       .setExitCondition(() => true),
      //   );

      const template = new SubroutineTemplate({
        template: childTemplate,
        initWith: (_parentSession: Session) => {
          const childSession = createSession();
          // Copy relevant metadata from parent to child
          const context = _parentSession.metadata.get('context') as string;
          childSession.metadata.set('context', context);
          return childSession;
        },
        squashWith: (_parentSession: Session, _childSession: Session) => {
          // Merge child messages into parent
          let updatedSession = _parentSession;
          for (const message of _childSession.messages) {
            updatedSession = updatedSession.addMessage(message);
          }
          return updatedSession;
        },
      });

      const session = createSession();
      session.metadata.set('context', 'test context');

      const result = await template.execute(session);

      // Verify messages were merged
      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Child context');
      expect(messages[1].content).toBe('Child response');
    });
  });

  describe('IfTemplate', () => {
    it('should execute thenTemplate when condition is true', async () => {
      // Create a session with a condition that will be true
      const session = createSession();
      session.metadata.set('condition', true);

      // Create templates for then and else branches
      const thenTemplate = new SystemTemplate({
        content: 'Then branch executed',
      });
      const elseTemplate = new SystemTemplate({
        content: 'Else branch executed',
      });

      // Create the if template
      const ifTemplate = new IfTemplate({
        condition: (session: Session) =>
          Boolean(session.metadata.get('condition')),
        thenTemplate,
        elseTemplate,
      });

      // Execute the template
      const result = await ifTemplate.execute(session);

      // Verify the then branch was executed
      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Then branch executed');
    });

    it('should execute elseTemplate when condition is false', async () => {
      // Create a session with a condition that will be false
      const session = createSession();
      session.metadata.set('condition', false);

      // Create templates for then and else branches
      const thenTemplate = new SystemTemplate({
        content: 'Then branch executed',
      });
      const elseTemplate = new SystemTemplate({
        content: 'Else branch executed',
      });

      // Create the if template
      const ifTemplate = new IfTemplate({
        condition: (session: Session) =>
          Boolean(session.metadata.get('condition')),
        thenTemplate,
        elseTemplate,
      });

      // Execute the template
      const result = await ifTemplate.execute(session);

      // Verify the else branch was executed
      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Else branch executed');
    });

    it('should return session unchanged when condition is false and no elseTemplate is provided', async () => {
      // Create a session with a condition that will be false
      const session = createSession();
      session.metadata.set('condition', false);

      // Create template for then branch only
      const thenTemplate = new SystemTemplate({
        content: 'Then branch executed',
      });

      // Create the if template without an else branch
      const ifTemplate = new IfTemplate({
        condition: (session: Session) =>
          Boolean(session.metadata.get('condition')),
        thenTemplate,
      });

      // Execute the template
      const result = await ifTemplate.execute(session);

      // Verify the session is unchanged (no messages added)
      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(0);
    });

    it('should work with complex conditions based on session state', async () => {
      // Create a session with messages
      let session = createSession();
      session = session.addMessage({
        type: 'user',
        content: 'Hello',
        metadata: createMetadata(),
      });

      // Create templates for then and else branches
      const thenTemplate = new SystemTemplate({ content: 'User said hello' });
      const elseTemplate = new SystemTemplate({
        content: 'User said something else',
      });

      // Create the if template with a condition that checks message content
      const ifTemplate = new IfTemplate({
        condition: (session: Session) => {
          const lastMessage = session.getLastMessage();
          return (
            lastMessage?.type === 'user' && lastMessage.content === 'Hello'
          );
        },
        thenTemplate,
        elseTemplate,
      });

      // Execute the template
      const result = await ifTemplate.execute(session);

      // Verify the then branch was executed
      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(2); // Original message + new message
      expect(messages[1].content).toBe('User said hello');
    });

    it('should work with template interpolation', async () => {
      // Create a session with metadata
      const session = createSession();
      session.metadata.set('username', 'John');
      session.metadata.set('isAdmin', true);

      // Create templates with interpolation
      const thenTemplate = new SystemTemplate({
        content: 'Welcome admin ${username}!',
      });
      const elseTemplate = new SystemTemplate({
        content: 'Welcome user ${username}!',
      });

      // Create the if template
      const ifTemplate = new IfTemplate({
        condition: (session: Session) =>
          Boolean(session.metadata.get('isAdmin')),
        thenTemplate,
        elseTemplate,
      });

      // Execute the template
      const result = await ifTemplate.execute(session);

      // Verify the interpolated content
      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Welcome admin John!');
    });

    it('should integrate with LinearTemplate', async () => {
      // Create a session with metadata
      const session = createSession();
      session.metadata.set('isLoggedIn', true);

      // Create a LinearTemplate with an IfTemplate
      const template = new LinearTemplate()
        .addSystem('Welcome to the system')
        .addUser('Status check', 'Status check')
        .addAssistant('Checking status...');

      // Add an IfTemplate to the LinearTemplate
      const ifTemplate = new IfTemplate({
        condition: (session: Session) =>
          Boolean(session.metadata.get('isLoggedIn')),
        thenTemplate: new SystemTemplate({ content: 'User is logged in' }),
        elseTemplate: new SystemTemplate({ content: 'User is not logged in' }),
      });

      // Add the IfTemplate to the LinearTemplate
      template['templates'].push(ifTemplate);

      // Execute the template
      const result = await template.execute(session);

      // Verify the conversation flow
      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(4);
      expect(messages[0].content).toBe('Welcome to the system');
      expect(messages[1].content).toBe('Status check');
      expect(messages[2].content).toBe('Checking status...');
      expect(messages[3].content).toBe('User is logged in');
    });

    it('should work with LinearTemplate.addIf method', async () => {
      // Create a session with metadata
      const session = createSession();
      session.metadata.set('isLoggedIn', true);

      // Create a LinearTemplate with the addIf method
      const template = new LinearTemplate()
        .addSystem('Welcome to the system')
        .addUser('Status check', 'Status check')
        .addAssistant('Checking status...')
        .addIf({
          condition: (session: Session) =>
            Boolean(session.metadata.get('isLoggedIn')),
          thenTemplate: new SystemTemplate({ content: 'User is logged in' }),
          elseTemplate: new SystemTemplate({
            content: 'User is not logged in',
          }),
        });

      // Execute the template
      const result = await template.execute(session);

      // Verify the conversation flow
      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(4);
      expect(messages[0].content).toBe('Welcome to the system');
      expect(messages[1].content).toBe('Status check');
      expect(messages[2].content).toBe('Checking status...');
      expect(messages[3].content).toBe('User is logged in');
    });
  });
});
