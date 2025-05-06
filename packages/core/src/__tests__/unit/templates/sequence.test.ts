import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from '../../../generate';
import { createGenerateOptions } from '../../../generate_options';
import { createSession } from '../../../session';
import { Transform } from '../../../templates';
import { Sequence } from '../../../templates/composite/sequence';
import { Assistant } from '../../../templates/primitives/assistant';
import { System } from '../../../templates/primitives/system';
import { User } from '../../../templates/primitives/user';
import { expect_messages } from '../../utils';

// Mock the generate module directly. Vitest replaces the actual generateText export with a mock.
vi.mock('../../../generate');

describe('Sequence Template', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Set up default mock using vi.mocked() on the imported function name
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'Mock response',
      metadata: undefined,
    });
  });

  it('should execute simple linear sequence', async () => {
    const sequence = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(new User('Hello, who are you?'))
      .add(new Assistant('I am an AI assistant.'));

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_messages(messages, [
      { type: 'system', content: 'You are a helpful assistant.' },
      { type: 'user', content: 'Hello, who are you?' },
      { type: 'assistant', content: 'I am an AI assistant.' },
    ]);
  });

  it('should create a sequence with constructor arguments', async () => {
    const systemTemplate = new System('You are a helpful assistant.');
    const userTemplate = new User('Hello, who are you?');
    const assistantTemplate = new Assistant('I am an AI assistant.');

    const sequence = new Sequence([
      systemTemplate,
      userTemplate,
      assistantTemplate,
    ]);

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
  });

  it('should support default ContentSource for UserTemplate', async () => {
    const sequence = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(new User('Default user message'));

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[1].content).toBe('Default user message');
  });

  it('should support default ContentSource for AssistantTemplate', async () => {
    // Mock the generateText function using vi.mocked()
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'I am the assistant response',
      metadata: undefined,
    });

    const options = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4',
      },
    });

    const sequence = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(new User('Hello, assistant'))
      .add(new Assistant(options));

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].content).toBe('I am the assistant response');

    // Verify the generateText was called using vi.mocked()
    expect(vi.mocked(generateText)).toHaveBeenCalledWith(
      expect.anything(), // Session object
      expect.objectContaining({
        // GenerateOptions object
        provider: expect.objectContaining({
          type: 'openai',
          modelName: 'gpt-4',
        }),
      }),
    );
  });

  it('should support addTransform method', async () => {
    const sequence = new Sequence()
      .add(new System('You are a helpful assistant.'))
      .add(new User('Hello, my name is Alice'))
      .add(
        new Transform((session) => {
          const message = session.getLastMessage()?.content || '';
          const nameMatch = message.match(/my name is (\w+)/i);
          const name = nameMatch ? nameMatch[1] : 'unknown';
          // Cast the result to satisfy TTransformFunction type
          return session.setContextValues({ userName: name });
        }),
      )
      .add(new User('Nice to meet you, ${userName}'));

    const session = await sequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_messages(messages, [
      { type: 'system', content: 'You are a helpful assistant.' },
      { type: 'user', content: 'Hello, my name is Alice' },
      { type: 'user', content: 'Nice to meet you, Alice' },
    ]);

    expect(session.getContextValue('userName')).toBe('Alice');
  });

  it('should execute an empty sequence without errors', async () => {
    const emptySequence = new Sequence();

    const session = await emptySequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(0);
  });

  it('should maintain session state across nested sequences', async () => {
    const sequence1 = new Sequence().add(new User('First message')).add(
      new Transform((session) => {
        // Cast the result to satisfy TTransformFunction type
        return session.setContextValues({ counter: 1 });
      }),
    );

    const sequence2 = new Sequence().add(new User('Second message')).add(
      new Transform((session) => {
        // Ensure counter is treated as a number
        const counter = Number(session.getContextValue('counter') || 0);
        // Cast the result to satisfy TTransformFunction type
        return session.setContextValues({
          counter: counter + 1,
        });
      }),
    );

    const mainSequence = new Sequence()
      .add(sequence1)
      .add(sequence2)
      // Note: Template interpolation uses `${metadataKey}` syntax
      .add(new User('Counter value: ${counter}'));

    const session = await mainSequence.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_messages(messages, [
      { type: 'user', content: 'First message' },
      { type: 'user', content: 'Second message' },
      { type: 'user', content: 'Counter value: 2' }, // Interpolated value
    ]);

    expect(session.getContextValue('counter')).toBe(2);
  });
});
