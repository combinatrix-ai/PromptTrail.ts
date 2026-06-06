import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  collectAnthropicToolUses,
  convertSessionToAnthropicMessages,
  createAnthropicStructuredOutputTool,
  createAnthropicToolResultBlock,
  getAnthropicToolDefinitions,
  getAnthropicRequestOptions,
  getAnthropicSkillsContainer,
  getAnthropicSystemPrompt,
  promptTrailBuiltinToAnthropicTool,
  promptTrailSkillToAnthropicContainerSkill,
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

  it('applies message cache hints to Anthropic content blocks', () => {
    const session = Session.create()
      .addMessage({ type: 'system', content: 'Cached system.', cache: '1h' })
      .addMessage({
        type: 'user',
        content: 'Inspect this.',
        cache: true,
        contentParts: [
          { kind: 'text', text: 'Inspect this.' },
          {
            kind: 'file',
            mimeType: 'application/pdf',
            source: {
              type: 'uri',
              uri: 'https://example.com/report.pdf',
            },
            filename: 'report.pdf',
          },
        ],
      });

    expect(getAnthropicSystemPrompt(session)).toEqual([
      {
        type: 'text',
        text: 'Cached system.',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
    expect(convertSessionToAnthropicMessages(session)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this.' },
          {
            type: 'document',
            source: {
              type: 'url',
              url: 'https://example.com/report.pdf',
            },
            title: 'report.pdf',
            cache_control: { type: 'ephemeral', ttl: '5m' },
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

  it('maps Anthropic provider-hosted builtins into tool definitions', () => {
    const builtin = {
      kind: 'builtin' as const,
      name: 'web_search_20250305',
      provider: 'anthropic' as const,
      executionMode: 'provider' as const,
      config: { max_uses: 2 },
    };

    expect(promptTrailBuiltinToAnthropicTool(builtin)).toEqual({
      type: 'web_search_20250305',
      name: 'web_search_20250305',
      max_uses: 2,
    });
    expect(getAnthropicToolDefinitions({ capabilities: [builtin] })).toEqual([
      {
        type: 'web_search_20250305',
        name: 'web_search_20250305',
        max_uses: 2,
      },
    ]);
  });

  it('maps RuntimeSkill skill IDs to Anthropic native skills', () => {
    const pptxSkill = {
      kind: 'skill' as const,
      name: 'presentations',
      skillId: 'pptx',
    };
    const customSkill = {
      kind: 'skill' as const,
      name: 'finance',
      skillId: 'skill_01AbCdEfGhIjKlMnOpQrStUv',
      metadata: { version: '1759178010641129' },
    };

    expect(promptTrailSkillToAnthropicContainerSkill(pptxSkill)).toEqual({
      type: 'anthropic',
      skill_id: 'pptx',
      version: 'latest',
    });
    expect(promptTrailSkillToAnthropicContainerSkill(customSkill)).toEqual({
      type: 'custom',
      skill_id: 'skill_01AbCdEfGhIjKlMnOpQrStUv',
      version: '1759178010641129',
    });
    expect(
      getAnthropicSkillsContainer({
        capabilities: [pptxSkill, customSkill],
      }),
    ).toEqual({
      skills: [
        { type: 'anthropic', skill_id: 'pptx', version: 'latest' },
        {
          type: 'custom',
          skill_id: 'skill_01AbCdEfGhIjKlMnOpQrStUv',
          version: '1759178010641129',
        },
      ],
    });
    expect(getAnthropicToolDefinitions({ capabilities: [pptxSkill] })).toEqual([
      { type: 'code_execution_20250825', name: 'code_execution' },
    ]);
    expect(getAnthropicRequestOptions({ capabilities: [pptxSkill] })).toEqual({
      headers: {
        'anthropic-beta':
          'code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14',
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
