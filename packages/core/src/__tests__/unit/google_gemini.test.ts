import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  attachGeminiCachedContentMetadata,
  buildGeminiGenerationConfig,
  buildGeminiCachedContentCreateParams,
  collectGeminiFunctionCalls,
  convertMessagesToGeminiContents,
  convertSessionToGeminiContents,
  createGeminiCachedContent,
  createGeminiStructuredOutputConfig,
  createGeminiFunctionResponsePart,
  getGeminiCacheablePrefixSession,
  getGeminiToolDefinitions,
  getGeminiSystemInstruction,
  getGoogleGenAIClientOptions,
  normalizeGeminiContentStream,
  promptTrailBuiltinToGeminiTool,
  promptTrailToolToGeminiTool,
  retainGeminiResponseMetadata,
  resolveGeminiCachedContent,
} from '../../google_gemini';
import { deriveConversationBinding } from '../../conversation';
import { Session } from '../../session';
import { Tool } from '../../tool';

describe('Google Gemini native adapter helpers', () => {
  it('converts PromptTrail messages into Gemini contents and system instruction', () => {
    const session = Session.create()
      .addMessage({ type: 'system', content: 'Be concise.' })
      .addMessage({ type: 'user', content: 'Hello' })
      .addMessage({ type: 'assistant', content: 'Hi' });

    expect(getGeminiSystemInstruction(session)).toBe('Be concise.');
    expect(convertSessionToGeminiContents(session)).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi' }] },
    ]);
  });

  it('maps Google provider baseURL into GenAI httpOptions', () => {
    expect(
      getGoogleGenAIClientOptions({
        type: 'google',
        apiKey: 'test-key',
        modelName: 'gemini-2.5-flash',
        baseURL: 'https://google.test',
      }),
    ).toEqual({
      apiKey: 'test-key',
      httpOptions: { baseUrl: 'https://google.test' },
    });
  });

  it('injects RuntimeSkill instructions into Gemini system text and applies loss policy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const session = Session.create().addMessage({
        type: 'system',
        content: 'Be concise.',
      });
      const skill = {
        kind: 'skill' as const,
        name: 'Review',
        description: 'Review risky changes',
        instructions: 'Prefer focused findings.',
        materialize: 'temporary' as const,
      };

      expect(
        getGeminiSystemInstruction(session, { capabilities: [skill] }),
      ).toBe(
        [
          'Be concise.',
          'Available runtime skills:',
          'Skill: Review\nReview risky changes\nPrefer focused findings.',
        ].join('\n\n'),
      );
      expect(warn).toHaveBeenCalledWith(
        'RuntimeSkill "Review" carries files or materialization metadata that cannot be represented by instruction injection.',
      );
      expect(() =>
        getGeminiSystemInstruction(session, {
          capabilities: [skill],
          skillInjection: 'error',
        }),
      ).toThrow(
        'RuntimeSkill "Review" carries files or materialization metadata that cannot be represented by instruction injection.',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('converts content parts into Gemini content parts', () => {
    const session = Session.create().addMessage({
      type: 'user',
      content: 'Inspect this.',
      contentParts: [
        { kind: 'text', text: 'Inspect this.' },
        {
          kind: 'image',
          mimeType: 'image/png',
          source: { type: 'bytes', data: new Uint8Array([1, 2, 3]) },
        },
      ],
    });

    expect(convertSessionToGeminiContents(session)).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'Inspect this.' },
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'AQID',
            },
          },
        ],
      },
    ]);
  });

  it('converts only messages after a cachedContent binding', () => {
    const session = Session.create()
      .addMessage({ type: 'system', content: 'Cached system.' })
      .addMessage({ type: 'user', content: 'Cached prompt.' })
      .addMessage({
        type: 'assistant',
        content: 'Cached answer.',
        attrs: { google: { cachedContent: 'cachedContents/abc' } },
      })
      .addMessage({ type: 'user', content: 'Fresh tail.' });

    expect(convertMessagesToGeminiContents(session.messages.slice(3))).toEqual([
      { role: 'user', parts: [{ text: 'Fresh tail.' }] },
    ]);
    expect(
      buildGeminiGenerationConfig(
        session,
        {
          provider: {
            type: 'google',
            modelName: 'gemini-2.5-flash',
          },
          toolChoice: 'required',
        },
        [
          {
            kind: 'tool',
            name: 'lookup',
            description: 'Lookup docs',
            inputSchema: z.object({ query: z.string() }),
            execute: ({ query }) => ({ query }),
          },
        ],
        [{ functionDeclarations: [{ name: 'lookup' }] }],
        { provider: 'google', id: 'cachedContents/abc', messageIndex: 2 },
      ),
    ).toMatchObject({
      cachedContent: 'cachedContents/abc',
      systemInstruction: undefined,
      tools: undefined,
      toolConfig: undefined,
    });
  });

  it('builds Gemini CachedContent create params from canonical session history', () => {
    const session = Session.create()
      .addMessage({ type: 'system', content: 'Cache this system.' })
      .addMessage({ type: 'user', content: 'Cache this prompt.' });
    const tool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) => ({ query }),
    });

    expect(
      buildGeminiCachedContentCreateParams(session, {
        provider: {
          type: 'google',
          modelName: 'gemini-2.5-flash',
        },
        cacheKey: 'repo-prefix',
        capabilities: [tool],
        toolChoice: 'required',
      }),
    ).toEqual({
      model: 'gemini-2.5-flash',
      config: {
        displayName: 'repo-prefix',
        contents: [{ role: 'user', parts: [{ text: 'Cache this prompt.' }] }],
        systemInstruction: 'Cache this system.',
        tools: [
          {
            functionDeclarations: [
              {
                name: 'lookup',
                description: 'Lookup docs',
                parametersJsonSchema: {
                  type: 'object',
                  properties: { query: { type: 'string' } },
                  required: ['query'],
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: ['lookup'],
          },
        },
      },
    });
  });

  it('creates Gemini CachedContent through an injectable client', async () => {
    const calls: unknown[] = [];
    const client = {
      caches: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return { name: 'cachedContents/abc' };
        },
      },
    };

    await expect(
      createGeminiCachedContent(client, { model: 'gemini-2.5-flash' }),
    ).resolves.toBe('cachedContents/abc');
    expect(calls).toEqual([{ model: 'gemini-2.5-flash' }]);
    await expect(
      createGeminiCachedContent(
        { caches: { create: async () => ({}) } },
        { model: 'gemini-2.5-flash' },
      ),
    ).rejects.toThrow(
      'Gemini CachedContent create response did not include name.',
    );
  });

  it('resolves cache hints into Gemini CachedContent bindings', async () => {
    const session = Session.create()
      .addMessage({ type: 'system', content: 'Cache this system.' })
      .addMessage({ type: 'user', content: 'Cache this prefix.', cache: true })
      .addMessage({ type: 'user', content: 'Use the cached prefix.' });
    const calls: unknown[] = [];
    const client = {
      caches: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return { name: 'cachedContents/prefix' };
        },
      },
    };

    const prefix = getGeminiCacheablePrefixSession(session);
    expect(prefix?.messageIndex).toBe(1);
    expect(convertSessionToGeminiContents(prefix!.session)).toEqual([
      { role: 'user', parts: [{ text: 'Cache this prefix.' }] },
    ]);

    const cache = await resolveGeminiCachedContent(client, session, {
      provider: { type: 'google', modelName: 'gemini-2.5-flash' },
      cacheKey: 'repo-prefix',
    });

    expect(calls).toEqual([
      {
        model: 'gemini-2.5-flash',
        config: {
          displayName: 'repo-prefix',
          contents: [{ role: 'user', parts: [{ text: 'Cache this prefix.' }] }],
          systemInstruction: 'Cache this system.',
          tools: undefined,
          toolConfig: undefined,
        },
      },
    ]);
    expect(cache).toEqual({
      cachedContent: 'cachedContents/prefix',
      binding: {
        provider: 'google',
        id: 'cachedContents/prefix',
        messageIndex: 1,
      },
      metadataBinding: {
        provider: 'google',
        id: 'cachedContents/prefix',
        messageIndex: 1,
      },
    });
    expect(convertMessagesToGeminiContents(session.messages.slice(2))).toEqual([
      { role: 'user', parts: [{ text: 'Use the cached prefix.' }] },
    ]);
  });

  it('retains the Gemini CachedContent prefix index for later turns', () => {
    const metadata = attachGeminiCachedContentMetadata(
      { provider: 'google', api: 'gemini' },
      {
        cachedContent: 'cachedContents/prefix',
        metadataBinding: {
          provider: 'google',
          id: 'cachedContents/prefix',
          messageIndex: 1,
        },
      },
    );
    const session = Session.create()
      .addMessage({ type: 'system', content: 'Cache this system.' })
      .addMessage({ type: 'user', content: 'Cache this prefix.', cache: true })
      .addMessage({
        type: 'assistant',
        content: 'Cached.',
        attrs: { google: metadata },
      })
      .addMessage({ type: 'user', content: 'Continue.' });

    expect(metadata).toMatchObject({
      cachedContent: 'cachedContents/prefix',
      cachedContentBinding: {
        id: 'cachedContents/prefix',
        messageIndex: 1,
      },
    });
    expect(deriveConversationBinding(session, 'google')).toEqual({
      provider: 'google',
      id: 'cachedContents/prefix',
      messageIndex: 1,
    });
    expect(
      buildGeminiGenerationConfig(
        session,
        { provider: { type: 'google', modelName: 'gemini-2.5-flash' } },
        [],
        [],
        deriveConversationBinding(session, 'google'),
      ),
    ).toMatchObject({
      cachedContent: 'cachedContents/prefix',
      systemInstruction: undefined,
    });
  });

  it('maps PromptTrail tools to Gemini function declarations', () => {
    const tool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) => ({ query }),
    });

    expect(promptTrailToolToGeminiTool(tool)).toEqual({
      name: 'lookup',
      description: 'Lookup docs',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });
  });

  it('maps Gemini provider-hosted builtins into tool definitions', () => {
    const builtin = {
      kind: 'builtin' as const,
      name: 'google_search',
      provider: 'google' as const,
      executionMode: 'provider' as const,
      config: {},
    };

    expect(promptTrailBuiltinToGeminiTool(builtin)).toEqual({
      googleSearch: {},
    });
    expect(getGeminiToolDefinitions({ capabilities: [builtin] })).toEqual([
      { googleSearch: {} },
    ]);
  });

  it('collects function calls and creates function response parts', async () => {
    const tool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }, context) => ({ query, provider: context.provider }),
    });
    const calls = collectGeminiFunctionCalls({
      functionCalls: [
        { id: 'call-1', name: 'lookup', args: { query: 'capabilities' } },
      ],
    });

    expect(calls).toEqual([
      {
        id: 'call-1',
        name: 'lookup',
        args: { query: 'capabilities' },
        raw: { id: 'call-1', name: 'lookup', args: { query: 'capabilities' } },
      },
    ]);
    await expect(
      createGeminiFunctionResponsePart(calls[0], [tool], Session.create()),
    ).resolves.toEqual({
      functionResponse: {
        id: 'call-1',
        name: 'lookup',
        response: {
          content: [
            {
              type: 'json',
              json: { query: 'capabilities', provider: 'google' },
            },
          ],
          structuredContent: { query: 'capabilities', provider: 'google' },
        },
      },
    });
  });

  it('normalizes native Gemini async streams without an API call', async () => {
    await expect(
      collectAsync(
        normalizeGeminiContentStream(
          stream([
            {
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    parts: [{ text: 'Hi' }],
                  },
                },
              ],
              usageMetadata: { promptTokenCount: 1 },
            },
          ]),
        ),
      ),
    ).resolves.toEqual([
      { type: 'text.delta', index: 0, delta: 'Hi' },
      {
        type: 'message.done',
        finishReason: 'STOP',
        usage: { promptTokenCount: 1 },
      },
    ]);
  });

  it('applies metadata retention levels', () => {
    const response = {
      usageMetadata: { promptTokenCount: 1 },
      candidates: [{ finishReason: 'STOP', safetyRatings: [{ ok: true }] }],
    };

    expect(retainGeminiResponseMetadata(response, 'none')).toEqual({
      provider: 'google',
      api: 'gemini',
      finishReason: 'STOP',
      cachedContent: undefined,
      replayRequired: [],
    });
    expect(retainGeminiResponseMetadata(response, 'summary')).toEqual({
      provider: 'google',
      api: 'gemini',
      finishReason: 'STOP',
      cachedContent: undefined,
      replayRequired: [],
      usage: { promptTokenCount: 1 },
      candidates: [
        {
          finishReason: 'STOP',
          safetyRatings: [{ ok: true }],
        },
      ],
    });
    expect(retainGeminiResponseMetadata(response, 'full')).toMatchObject({
      raw: response,
      candidates: response.candidates,
    });
  });

  it('pins Gemini thought signatures even when retention is none', () => {
    expect(
      retainGeminiResponseMetadata(
        {
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  {
                    text: 'hidden',
                    thought: true,
                    thoughtSignature: 'sig',
                  },
                ],
              },
            },
          ],
        },
        'none',
      ),
    ).toMatchObject({
      replayRequired: [
        {
          provider: 'google',
          type: 'thoughtSignature',
          id: '0:0',
          artifact: {
            text: 'hidden',
            thought: true,
            thoughtSignature: 'sig',
          },
        },
      ],
    });
  });

  it('retains Gemini cachedContent binding metadata', () => {
    expect(
      retainGeminiResponseMetadata(
        {
          cachedContent: { name: 'cachedContents/abc' },
          candidates: [{ finishReason: 'STOP' }],
        },
        'none',
      ),
    ).toMatchObject({
      cachedContent: 'cachedContents/abc',
    });
  });

  it('creates response JSON schema config for native structured output', () => {
    expect(
      createGeminiStructuredOutputConfig({
        schema: z.object({
          status: z.literal('ok'),
          count: z.number(),
        }),
      }),
    ).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', const: 'ok' },
          count: { type: 'number' },
        },
        required: ['status', 'count'],
        additionalProperties: false,
      },
    });
  });
});

async function collectAsync<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function* stream(events: unknown[]) {
  for (const event of events) {
    yield event;
  }
}
