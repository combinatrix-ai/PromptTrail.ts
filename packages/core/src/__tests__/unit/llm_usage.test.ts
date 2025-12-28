import { describe, expect, it } from 'vitest';
import { Session } from '../../session';
import { Source } from '../../source';
import { Assistant } from '../../templates/primitives/assistant';

describe('LLM Usage Tracking Integration', () => {
  it('should track usage from mocked LLM source', async () => {
    const session = Session.create();

    const mockSource = Source.llm()
      .mock()
      .mockResponse({
        content: 'Hello, world!',
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cost: 0.001,
        },
      });

    const assistant = new Assistant(mockSource);
    const updatedSession = await assistant.execute(session);

    expect(updatedSession.usage.totalPromptTokens).toBe(100);
    expect(updatedSession.usage.totalCompletionTokens).toBe(50);
    expect(updatedSession.usage.totalTokens).toBe(150);
    expect(updatedSession.usage.totalPrice).toBe(0.001);
    expect(updatedSession.usage.callCount).toBe(1);
    expect(updatedSession.messages).toHaveLength(1);
    expect(updatedSession.messages[0].type).toBe('assistant');
  });

  it('should accumulate usage from multiple LLM calls', async () => {
    const session = Session.create();

    const mockSource1 = Source.llm()
      .mock()
      .mockResponse({
        content: 'First response',
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cost: 0.001,
        },
      });

    const mockSource2 = Source.llm()
      .mock()
      .mockResponse({
        content: 'Second response',
        usage: {
          promptTokens: 200,
          completionTokens: 100,
          totalTokens: 300,
          cost: 0.002,
        },
      });

    const assistant1 = new Assistant(mockSource1);
    const assistant2 = new Assistant(mockSource2);

    const session2 = await assistant1.execute(session);
    const session3 = await assistant2.execute(session2);

    expect(session3.usage.totalPromptTokens).toBe(300);
    expect(session3.usage.totalCompletionTokens).toBe(150);
    expect(session3.usage.totalTokens).toBe(450);
    expect(session3.usage.totalPrice).toBe(0.003);
    expect(session3.usage.callCount).toBe(2);
    expect(session3.usage.history).toHaveLength(2);
  });

  it('should handle LLM calls without usage information', async () => {
    const session = Session.create();

    const mockSource = Source.llm().mock().mockResponse({
      content: 'Response without usage',
    });

    const assistant = new Assistant(mockSource);
    const updatedSession = await assistant.execute(session);

    expect(updatedSession.usage.totalPrice).toBe(0);
    expect(updatedSession.usage.callCount).toBe(0);
    expect(updatedSession.messages).toHaveLength(1);
  });

  it('should preserve usage across different session operations', async () => {
    const session = Session.create();

    const mockSource = Source.llm()
      .mock()
      .mockResponse({
        content: 'Response with usage',
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cost: 0.001,
        },
      });

    const assistant = new Assistant(mockSource);
    let updatedSession = await assistant.execute(session);

    // Add a user message
    updatedSession = updatedSession.addMessage({
      type: 'user',
      content: 'Follow up question',
    });

    // Update vars
    updatedSession = updatedSession.withVar('key', 'value');

    // Usage should still be preserved
    expect(updatedSession.usage.totalPrice).toBe(0.001);
    expect(updatedSession.usage.callCount).toBe(1);
    expect(updatedSession.messages).toHaveLength(2);
  });

  it('should track usage with tool calls', async () => {
    const session = Session.create();

    const mockSource = Source.llm()
      .mock()
      .mockResponse({
        content: 'Using a tool',
        toolCalls: [
          {
            id: 'call_123',
            name: 'search',
            arguments: { query: 'test' },
          },
        ],
        usage: {
          promptTokens: 150,
          completionTokens: 75,
          totalTokens: 225,
          cost: 0.0015,
        },
      });

    const assistant = new Assistant(mockSource);
    const updatedSession = await assistant.execute(session);

    expect(updatedSession.usage.totalPrice).toBe(0.0015);
    expect(updatedSession.usage.callCount).toBe(1);
    expect(updatedSession.messages[0].toolCalls).toHaveLength(1);
  });
});
