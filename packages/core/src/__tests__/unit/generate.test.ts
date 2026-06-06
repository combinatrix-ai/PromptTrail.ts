import { describe, expect, it } from 'vitest';
import {
  convertSessionToAiSdkMessages,
  createProvider,
  promptTrailStreamEventsToMessages,
} from '../../generate';
import { Session } from '../../session';

describe('createProvider', () => {
  it('should use OpenAI Responses API when requested', () => {
    const provider = createProvider({
      provider: {
        type: 'openai',
        apiKey: 'test-key',
        modelName: 'gpt-5.4-nano',
        api: 'responses',
      },
    }) as any;

    expect(provider.modelId).toBe('gpt-5.4-nano');
    expect(provider.config.provider).toBe('openai.responses');
  });

  it('should keep OpenAI chat compatibility when requested', () => {
    const provider = createProvider({
      provider: {
        type: 'openai',
        apiKey: 'test-key',
        modelName: 'gpt-5.4-nano',
        api: 'chat',
      },
    }) as any;

    expect(provider.modelId).toBe('gpt-5.4-nano');
    expect(provider.config.provider).toBe('openai.chat');
  });
});

describe('convertSessionToAiSdkMessages', () => {
  it('should inject runtime skill instructions as system messages for ai-sdk path', () => {
    const messages = convertSessionToAiSdkMessages(
      Session.create({
        messages: [{ type: 'user', content: 'Use the skill.' }],
      }),
      {
        capabilities: [
          {
            kind: 'skill',
            name: 'docs',
            instructions: 'Prefer local docs.',
          },
        ],
      },
    );

    expect(messages[0]).toEqual({
      role: 'system',
      content: 'Available runtime skills:\n\nSkill: docs\nPrefer local docs.',
    });
    expect(messages[1]).toEqual({ role: 'user', content: 'Use the skill.' });
  });

  it('preserves user content parts for ai-sdk path', () => {
    const messages = convertSessionToAiSdkMessages(
      Session.create({
        messages: [
          {
            type: 'user',
            content: 'Inspect the image.',
            contentParts: [
              { kind: 'text', text: 'Inspect the image.' },
              {
                kind: 'image',
                mimeType: 'image/png',
                source: {
                  type: 'uri',
                  uri: 'https://example.com/image.png',
                },
              },
            ],
          },
        ],
      }),
    );

    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect the image.' },
          {
            type: 'image',
            image: new URL('https://example.com/image.png'),
            mimeType: 'image/png',
            providerOptions: undefined,
          },
        ],
      },
    ]);
  });
});

describe('promptTrailStreamEventsToMessages', () => {
  it('converts normalized provider stream events into message chunks', async () => {
    await expect(
      collectAsync(
        promptTrailStreamEventsToMessages(
          stream([
            { type: 'text.delta', index: 0, delta: 'Hi' },
            { type: 'tool.start', index: 1, callId: 'call-1', name: 'lookup' },
            {
              type: 'tool.args.done',
              index: 1,
              callId: 'call-1',
              args: { query: 'docs' },
            },
          ]),
        ),
      ),
    ).resolves.toEqual([
      { type: 'assistant', content: 'Hi' },
      {
        type: 'assistant',
        content: 'Hi',
        attrs: undefined,
        toolCalls: [
          { id: 'call-1', name: 'lookup', arguments: { query: 'docs' } },
        ],
      },
    ]);
  });
});

async function collectAsync<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function* stream(events: any[]) {
  for (const event of events) {
    yield event;
  }
}
