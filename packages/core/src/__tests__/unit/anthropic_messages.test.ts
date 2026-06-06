import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  collectAnthropicToolUses,
  convertSessionToAnthropicMessages,
  createAnthropicStructuredOutputTool,
  createAnthropicToolResultBlock,
  getAnthropicSystemPrompt,
  promptTrailToolToAnthropicTool,
  retainAnthropicMessageMetadata,
} from '../../anthropic_messages';
import { Session } from '../../session';
import { Tool } from '../../tool';

describe('Anthropic Messages native adapter helpers', () => {
  it('converts PromptTrail messages into Anthropic messages and system prompt', () => {
    const session = Session.create()
      .addMessage({ type: 'system', content: 'Be concise.' })
      .addMessage({ type: 'user', content: 'Hello' })
      .addMessage({ type: 'assistant', content: 'Hi' });

    expect(getAnthropicSystemPrompt(session)).toBe('Be concise.');
    expect(convertSessionToAnthropicMessages(session)).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
  });

  it('converts content parts into Anthropic content blocks', () => {
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

    expect(convertSessionToAnthropicMessages(session)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this.' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'AQID',
            },
          },
        ],
      },
    ]);
  });

  it('maps PromptTrail tools to Anthropic tool definitions', () => {
    const tool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) => ({ query }),
    });

    expect(promptTrailToolToAnthropicTool(tool)).toEqual({
      name: 'lookup',
      description: 'Lookup docs',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });
  });

  it('collects tool uses and creates tool result blocks', async () => {
    const tool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }, context) => ({ query, provider: context.provider }),
    });
    const toolUses = collectAnthropicToolUses([
      {
        type: 'tool_use',
        id: 'toolu-1',
        name: 'lookup',
        input: { query: 'capabilities' },
      },
    ]);

    expect(toolUses).toEqual([
      {
        id: 'toolu-1',
        name: 'lookup',
        input: { query: 'capabilities' },
        raw: {
          type: 'tool_use',
          id: 'toolu-1',
          name: 'lookup',
          input: { query: 'capabilities' },
        },
      },
    ]);

    await expect(
      createAnthropicToolResultBlock(toolUses[0], [tool], Session.create()),
    ).resolves.toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu-1',
      is_error: undefined,
      content: JSON.stringify({
        content: [
          {
            type: 'json',
            json: { query: 'capabilities', provider: 'anthropic' },
          },
        ],
        structuredContent: { query: 'capabilities', provider: 'anthropic' },
      }),
    });
  });

  it('applies metadata retention levels', () => {
    const response = {
      id: 'msg-1',
      stop_reason: 'end_turn',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 1 },
      content: [{ type: 'text', text: 'x'.repeat(600) }],
    };

    expect(retainAnthropicMessageMetadata(response, 'none')).toEqual({
      provider: 'anthropic',
      api: 'messages',
      responseId: 'msg-1',
      stopReason: 'end_turn',
      model: 'claude-haiku-4-5',
    });
    expect(retainAnthropicMessageMetadata(response, 'summary')).toMatchObject({
      usage: { input_tokens: 1 },
      content: [
        {
          type: 'text',
          preview: 'x'.repeat(500),
          truncated: true,
          fullLength: 600,
        },
      ],
    });
    expect(retainAnthropicMessageMetadata(response, 'full')).toMatchObject({
      raw: response,
      content: response.content,
    });
  });

  it('creates forced-tool definitions for native structured output', () => {
    expect(
      createAnthropicStructuredOutputTool({
        schema: z.object({
          status: z.literal('ok'),
          count: z.number(),
        }),
        functionName: 'StructuredResult',
      }),
    ).toEqual({
      name: 'StructuredResult',
      description: 'Generate structured output according to the JSON schema.',
      input_schema: {
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
