import { describe, expect, it } from 'vitest';
import {
  assertExplicitNativeSchemaModeWhenToolsArePresent,
  assertNativeStreamingToolLoopSupported,
  convertSessionToAiSdkMessages,
  createProvider,
  promptTrailStreamEventsToMessages,
  streamPromptTrailToolLoop,
} from '../../generate';
import { createExecutionRuntimeState, Middleware } from '../../interceptors';
import { Session } from '../../session';
import { Tool } from '../../tool';
import { z } from 'zod';

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

describe('native schema/tool guard', () => {
  it('allows native first-party schema generation with PromptTrail tools', () => {
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) => ({ query }),
    });
    const options = {
      provider: {
        type: 'openai' as const,
        apiKey: 'test-key',
        modelName: 'gpt-5.4-nano',
        api: 'responses' as const,
        adapter: 'native' as const,
      },
      capabilities: [lookup],
    };

    expect(() =>
      assertExplicitNativeSchemaModeWhenToolsArePresent(options, {
        schema: z.object({ status: z.literal('ok') }),
      }),
    ).not.toThrow();
    expect(() =>
      assertExplicitNativeSchemaModeWhenToolsArePresent(options, {
        schema: z.object({ status: z.literal('ok') }),
        mode: 'native',
      }),
    ).not.toThrow();
  });
});

describe('assertNativeStreamingToolLoopSupported', () => {
  it('allows native first-party streaming with PromptTrail tools', () => {
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      parameters: z.object({ query: z.string() }),
      execute: ({ query }) => ({ query }),
    });

    expect(() =>
      assertNativeStreamingToolLoopSupported({
        provider: {
          type: 'openai',
          apiKey: 'test-key',
          modelName: 'gpt-5.4-nano',
          api: 'responses',
          adapter: 'native',
        },
        capabilities: [lookup],
      }),
    ).not.toThrow();
  });

  it('allows ai-sdk streaming tool calls', () => {
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      parameters: z.object({ query: z.string() }),
      execute: ({ query }) => ({ query }),
    });

    expect(() =>
      assertNativeStreamingToolLoopSupported({
        provider: {
          type: 'openai',
          apiKey: 'test-key',
          modelName: 'gpt-5.4-nano',
          api: 'responses',
          adapter: 'ai-sdk',
        },
        capabilities: [lookup],
      }),
    ).not.toThrow();
  });
});

describe('streamPromptTrailToolLoop', () => {
  it('executes streamed tool calls and continues with tool results in session', async () => {
    const toolContexts: unknown[] = [];
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      parameters: z.object({ query: z.string() }),
      execute: ({ query }, context) => {
        toolContexts.push(context.context);
        return { value: `result:${query}` };
      },
    });
    const seenTurns: string[][] = [];

    const messages = await collectAsync(
      streamPromptTrailToolLoop(
        Session.create().addMessage({ type: 'user', content: 'Lookup docs.' }),
        {
          provider: {
            type: 'openai',
            apiKey: 'test-key',
            modelName: 'gpt-5.4-nano',
            api: 'responses',
          },
          capabilities: [lookup],
          context: { channel: 'stream-context' },
        },
        {
          provider: 'openai',
          attrsKey: 'openai',
          events: (turnSession) => {
            seenTurns.push(turnSession.messages.map((message) => message.type));
            return seenTurns.length === 1
              ? stream([
                  {
                    type: 'tool.start',
                    index: 0,
                    callId: 'call-1',
                    name: 'lookup',
                  },
                  {
                    type: 'tool.args.done',
                    index: 0,
                    callId: 'call-1',
                    args: { query: 'streaming' },
                  },
                  { type: 'message.done', finishReason: 'tool_calls' },
                ])
              : stream([
                  { type: 'text.delta', index: 0, delta: 'Done' },
                  { type: 'message.done', finishReason: 'stop' },
                ]);
          },
        },
      ),
    );

    expect(messages).toEqual([
      {
        type: 'assistant',
        content: ' ',
        attrs: expect.objectContaining({ openai: expect.any(Object) }),
        toolCalls: [
          {
            id: 'call-1',
            name: 'lookup',
            arguments: { query: 'streaming' },
          },
        ],
      },
      {
        type: 'tool_result',
        content: JSON.stringify({
          content: [{ type: 'json', json: { value: 'result:streaming' } }],
          structuredContent: { value: 'result:streaming' },
        }),
        attrs: { toolCallId: 'call-1', toolCallName: 'lookup' },
      },
      { type: 'assistant', content: 'Done' },
      {
        type: 'assistant',
        content: 'Done',
        attrs: expect.objectContaining({ openai: expect.any(Object) }),
        toolCalls: undefined,
      },
    ]);
    expect(seenTurns).toEqual([['user'], ['user', 'assistant', 'tool_result']]);
    expect(toolContexts).toEqual([{ channel: 'stream-context' }]);
  });

  it('runs beforeTool and afterTool middleware around streamed tool calls', async () => {
    const toolContexts: unknown[] = [];
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      parameters: z.object({ query: z.string() }),
      execute: ({ query }, context) => {
        toolContexts.push(context.context);
        return { value: `result:${query}` };
      },
    });
    const seenTurnVars: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    let seq = 0;
    const runtime = createExecutionRuntimeState({
      context: { channel: 'runtime-context' },
      middleware: [
        Middleware.create({
          name: 'toolPolicy',
          beforeTool: ({ request }) => {
            const call = request as {
              id: string;
              name: string;
              arguments: Record<string, unknown>;
            };
            return {
              request: {
                ...call,
                arguments: { ...call.arguments, query: 'rewritten' },
              },
              session: {
                vars: { beforeTool: true },
              },
            };
          },
          afterTool: ({ result }) => {
            const message = result as { type: string; content: string };
            return {
              result: {
                ...message,
                content: 'patched tool result',
              },
              session: {
                vars: { afterTool: true },
              },
            };
          },
        }),
      ],
      emitEvent: (event) => {
        events.push(
          `${event.seq}:${event.type}:${event.phase ?? event.toolCallId ?? '-'}`,
        );
      },
      nextEventSeq: () => seq++,
    });

    const messages = await collectAsync(
      streamPromptTrailToolLoop(
        Session.create().addMessage({ type: 'user', content: 'Lookup docs.' }),
        {
          provider: {
            type: 'openai',
            apiKey: 'test-key',
            modelName: 'gpt-5.4-nano',
            api: 'responses',
          },
          capabilities: [lookup],
        },
        {
          provider: 'openai',
          attrsKey: 'openai',
          runtime,
          events: (turnSession) => {
            seenTurnVars.push(turnSession.getVarsObject());
            return seenTurnVars.length === 1
              ? stream([
                  {
                    type: 'tool.start',
                    index: 0,
                    callId: 'call-1',
                    name: 'lookup',
                  },
                  {
                    type: 'tool.args.done',
                    index: 0,
                    callId: 'call-1',
                    args: { query: 'original' },
                  },
                  { type: 'message.done', finishReason: 'tool_calls' },
                ])
              : stream([
                  { type: 'text.delta', index: 0, delta: 'Done' },
                  { type: 'message.done', finishReason: 'stop' },
                ]);
          },
        },
      ),
    );

    expect(messages[1]).toMatchObject({
      type: 'tool_result',
      content: 'patched tool result',
      attrs: { toolCallId: 'call-1', toolCallName: 'lookup' },
    });
    expect(seenTurnVars).toEqual([{}, { beforeTool: true, afterTool: true }]);
    expect(events).toEqual([
      '0:session.patched:beforeTool',
      '1:tool.started:call-1',
      '2:session.patched:afterTool',
      '3:tool.completed:call-1',
    ]);
    expect(toolContexts).toEqual([{ channel: 'runtime-context' }]);
  });

  it('wraps streamed tool calls with middleware', async () => {
    let executed = false;
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      parameters: z.object({ query: z.string() }),
      execute: () => {
        executed = true;
        return { value: 'should not run' };
      },
    });
    const events: string[] = [];
    let seq = 0;
    const runtime = createExecutionRuntimeState({
      middleware: [
        Middleware.create({
          name: 'toolWrapper',
          wrapToolCall: ({ request }) => {
            const call = request as { id: string; name: string };
            return {
              result: {
                type: 'tool_result',
                content: `blocked:${call.name}`,
                attrs: {
                  toolCallId: call.id,
                  toolCallName: call.name,
                },
              },
              session: {
                vars: { wrappedTool: true },
              },
            };
          },
          afterTool: ({ result }) => {
            const message = result as { content: string };
            return {
              result: {
                ...message,
                content: `${message.content}:after`,
              },
            };
          },
        }),
      ],
      emitEvent: (event) => {
        events.push(
          `${event.seq}:${event.type}:${event.phase ?? event.toolCallId ?? '-'}`,
        );
      },
      nextEventSeq: () => seq++,
    });

    const messages = await collectAsync(
      streamPromptTrailToolLoop(
        Session.create().addMessage({ type: 'user', content: 'Lookup docs.' }),
        {
          provider: {
            type: 'openai',
            apiKey: 'test-key',
            modelName: 'gpt-5.4-nano',
            api: 'responses',
          },
          capabilities: [lookup],
        },
        {
          provider: 'openai',
          attrsKey: 'openai',
          runtime,
          events: (turnSession) =>
            turnSession.messages.length === 1
              ? stream([
                  {
                    type: 'tool.start',
                    index: 0,
                    callId: 'call-1',
                    name: 'lookup',
                  },
                  {
                    type: 'tool.args.done',
                    index: 0,
                    callId: 'call-1',
                    args: { query: 'original' },
                  },
                  { type: 'message.done', finishReason: 'tool_calls' },
                ])
              : stream([
                  { type: 'text.delta', index: 0, delta: 'Done' },
                  { type: 'message.done', finishReason: 'stop' },
                ]),
        },
      ),
    );

    expect(executed).toBe(false);
    expect(messages[1]).toMatchObject({
      type: 'tool_result',
      content: 'blocked:lookup:after',
      attrs: { toolCallId: 'call-1', toolCallName: 'lookup' },
    });
    expect(events).toEqual([
      '0:session.patched:wrapToolCall',
      '1:tool.completed:call-1',
    ]);
  });
});

describe('promptTrailStreamEventsToMessages', () => {
  it('emits a final assistant message from the reduced stream state', async () => {
    await expect(
      collectAsync(
        promptTrailStreamEventsToMessages(
          stream([
            { type: 'text.delta', index: 0, delta: 'Hel' },
            { type: 'text.delta', index: 0, delta: 'lo' },
            {
              type: 'message.done',
              finishReason: 'stop',
              usage: { tokens: 3 },
            },
          ]),
        ),
      ),
    ).resolves.toEqual([
      { type: 'assistant', content: 'Hel' },
      { type: 'assistant', content: 'lo' },
      { type: 'assistant', content: 'Hello', attrs: undefined },
    ]);
  });

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

  it('attaches provider stream metadata on reduced stream messages', async () => {
    await expect(
      collectAsync(
        promptTrailStreamEventsToMessages(
          stream([
            { type: 'text.delta', index: 0, delta: 'Hi' },
            {
              type: 'message.done',
              finishReason: 'stop',
              usage: { tokens: 1 },
            },
          ]),
          { attrsKey: 'google', retain: 'summary' },
        ),
      ),
    ).resolves.toEqual([
      { type: 'assistant', content: 'Hi' },
      {
        type: 'assistant',
        content: 'Hi',
        attrs: {
          google: {
            finishReason: 'stop',
            usage: { tokens: 1 },
            text: { preview: 'Hi' },
            reasoning: { preview: '' },
            tools: [],
            errors: [],
            events: [
              { type: 'text.delta', index: 0, delta: { preview: 'Hi' } },
              {
                type: 'message.done',
                finishReason: 'stop',
                usage: { tokens: 1 },
              },
            ],
          },
        },
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
