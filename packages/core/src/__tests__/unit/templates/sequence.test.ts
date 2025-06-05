import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from '../../../generate';
import { Source } from '../../../source';
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
    });
  });

  it('should execute simple linear sequence', async () => {
    const sequence = new Sequence()
      .then(new System('You are a helpful assistant.'))
      .then(new User('Hello, who are you?'))
      .then(new Assistant('I am an AI assistant.'));

    const session = await sequence.execute();

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

    const session = await sequence.execute();

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect(messages[0].type).toBe('system');
    expect(messages[1].type).toBe('user');
    expect(messages[2].type).toBe('assistant');
  });

  it('should support string for UserTemplate', async () => {
    const sequence = new Sequence()
      .then(new System('You are a helpful assistant.'))
      .then(new User('Default user message'));

    const session = await sequence.execute();

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
    });

    const llm = Source.llm();

    const sequence = new Sequence()
      .then(new System('You are a helpful assistant.'))
      .then(new User('Hello, assistant'))
      .then(new Assistant(llm));

    const session = await sequence.execute();

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
          modelName: 'gpt-4o-mini',
        }),
      }),
    );
  });

  it('should support addTransform method', async () => {
    const sequence = new Sequence()
      .then(new System('You are a helpful assistant.'))
      .then(new User('Hello, my name is Alice'))
      .then(
        new Transform((session) => {
          const message = session.getLastMessage()?.content || '';
          const nameMatch = message.match(/my name is (\w+)/i);
          const name = nameMatch ? nameMatch[1] : 'unknown';
          // Cast the result to satisfy TTransformFunction type
          return session.withVars({ userName: name });
        }),
      )
      .then(new User('Nice to meet you, {{userName}}'));

    const session = await sequence.execute();

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_messages(messages, [
      { type: 'system', content: 'You are a helpful assistant.' },
      { type: 'user', content: 'Hello, my name is Alice' },
      { type: 'user', content: 'Nice to meet you, Alice' },
    ]);

    expect(session.getVar('userName')).toBe('Alice');
  });

  it('should execute an empty sequence without errors', async () => {
    const emptySequence = new Sequence();

    const session = await emptySequence.execute();

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(0);
  });

  it('should maintain session state across nested sequences', async () => {
    const sequence1 = new Sequence().then(new User('First message')).then(
      new Transform((session) => {
        // Cast the result to satisfy TTransformFunction type
        return session.withVars({ counter: 1 });
      }),
    );

    const sequence2 = new Sequence().then(new User('Second message')).then(
      new Transform((session) => {
        // Ensure counter is treated as a number
        const counter = Number(session.getVar('counter') || 0);
        // Cast the result to satisfy TTransformFunction type
        return session.withVars({
          counter: counter + 1,
        });
      }),
    );

    const mainSequence = new Sequence()
      .then(sequence1)
      .then(sequence2)
      // Note: Template interpolation uses `{{metadataKey}}` syntax
      .then(new User('Counter value: {{counter}}'));

    const session = await mainSequence.execute();

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    expect_messages(messages, [
      { type: 'user', content: 'First message' },
      { type: 'user', content: 'Second message' },
      { type: 'user', content: 'Counter value: 2' }, // Interpolated value
    ]);

    expect(session.getVar('counter')).toBe(2);
  });
});
