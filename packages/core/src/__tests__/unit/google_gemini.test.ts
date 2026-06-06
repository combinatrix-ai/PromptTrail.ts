import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  collectGeminiFunctionCalls,
  convertSessionToGeminiContents,
  createGeminiStructuredOutputConfig,
  createGeminiFunctionResponsePart,
  getGeminiToolDefinitions,
  getGeminiSystemInstruction,
  promptTrailBuiltinToGeminiTool,
  promptTrailToolToGeminiTool,
  retainGeminiResponseMetadata,
} from '../../google_gemini';
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

  it('applies metadata retention levels', () => {
    const response = {
      usageMetadata: { promptTokenCount: 1 },
      candidates: [{ finishReason: 'STOP', safetyRatings: [{ ok: true }] }],
    };

    expect(retainGeminiResponseMetadata(response, 'none')).toEqual({
      provider: 'google',
      api: 'gemini',
      finishReason: 'STOP',
      replayRequired: [],
    });
    expect(retainGeminiResponseMetadata(response, 'summary')).toEqual({
      provider: 'google',
      api: 'gemini',
      finishReason: 'STOP',
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
