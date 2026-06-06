import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  collectGeminiFunctionCalls,
  convertSessionToGeminiContents,
  createGeminiFunctionResponsePart,
  getGeminiSystemInstruction,
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
    });
    expect(retainGeminiResponseMetadata(response, 'summary')).toEqual({
      provider: 'google',
      api: 'gemini',
      finishReason: 'STOP',
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
});
