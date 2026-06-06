import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AnthropicSkillsHttpClient,
  buildAnthropicSchemaRequestBody,
  collectAnthropicToolUses,
  convertSessionToAnthropicMessages,
  createAnthropicStructuredOutputTool,
  createAnthropicToolResultBlock,
  getAnthropicToolDefinitions,
  getAnthropicRequestOptions,
  getAnthropicRequestContent,
  getAnthropicSkillsContainer,
  getAnthropicSystemPrompt,
  limitAnthropicCacheControlBreakpoints,
  normalizeAnthropicMessagesStream,
  promptTrailBuiltinToAnthropicTool,
  promptTrailSkillToAnthropicContainerSkill,
  promptTrailToolToAnthropicTool,
  renderAnthropicSkillMarkdown,
  sanitizeAnthropicSkillDirectoryName,
  uploadAnthropicTemporarySkills,
  retainAnthropicMessageMetadata,
} from '../../anthropic_messages';
import type { RuntimeSkill } from '../../capabilities';
import { Session } from '../../session';
import { Tool } from '../../tool';

describe('Anthropic Messages native adapter helpers', () => {
  it('converts PromptTrail messages into Anthropic messages and system prompt', () => {
    const session = Session.create()
      .addMessage({ type: 'system', content: 'Be concise.' })
      .addMessage({ type: 'user', content: 'Hello' })
      .addMessage({ type: 'assistant', content: 'Hi' });

    expect(getAnthropicSystemPrompt(session)).toBe('Be concise.');
    expect(getAnthropicRequestContent(session)).toEqual({
      system: 'Be concise.',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
    });
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

  it('replays pinned Anthropic thinking and compaction blocks in messages', () => {
    const session = Session.create()
      .addMessage({ type: 'user', content: 'Use extended thinking.' })
      .addMessage({
        type: 'assistant',
        content: 'Done.',
        attrs: {
          anthropic: {
            replayRequired: [
              {
                provider: 'anthropic',
                type: 'thinking.signature',
                artifact: {
                  type: 'thinking',
                  thinking: 'private',
                  signature: 'sig',
                },
              },
              {
                provider: 'anthropic',
                type: 'compaction',
                id: 'cmp_1',
                artifact: {
                  type: 'compaction',
                  id: 'cmp_1',
                  encrypted_content: 'compact',
                },
              },
            ],
          },
        },
      })
      .addMessage({ type: 'user', content: 'Continue' });

    expect(convertSessionToAnthropicMessages(session)).toEqual([
      { role: 'user', content: 'Use extended thinking.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private', signature: 'sig' },
          { type: 'compaction', id: 'cmp_1', encrypted_content: 'compact' },
          { type: 'text', text: 'Done.' },
        ],
      },
      { role: 'user', content: 'Continue' },
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

  it('caps Anthropic cache breakpoints at four with longer TTL first', () => {
    const request = getAnthropicRequestContent(
      Session.create()
        .addMessage({ type: 'system', content: 'System 5m.', cache: true })
        .addMessage({ type: 'system', content: 'System 1h.', cache: '1h' })
        .addMessage({ type: 'user', content: 'User 5m 1.', cache: true })
        .addMessage({
          type: 'assistant',
          content: 'Assistant 1h.',
          cache: '1h',
        })
        .addMessage({ type: 'user', content: 'User 5m 2.', cache: true })
        .addMessage({
          type: 'assistant',
          content: 'Assistant 5m.',
          cache: true,
        }),
    );

    expect(collectCacheControlledText(request)).toEqual([
      'User 5m 1.',
      'Assistant 1h.',
      'User 5m 2.',
      'System 1h.',
    ]);
  });

  it('limits arbitrary Anthropic content blocks without reordering them', () => {
    const content = [
      { type: 'text', text: '5m first', cache_control: { ttl: '5m' } },
      { type: 'text', text: '5m removed', cache_control: { ttl: '5m' } },
      { type: 'text', text: '1h first', cache_control: { ttl: '1h' } },
    ];

    expect(limitAnthropicCacheControlBreakpoints(content, 2)).toBe(content);
    expect(collectCacheControlledText(content)).toEqual([
      '5m first',
      '1h first',
    ]);
    expect(content.map((block) => block.text)).toEqual([
      '5m first',
      '5m removed',
      '1h first',
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

  it('uploads temporary RuntimeSkills behind explicit approval', async () => {
    const approvals: unknown[] = [];
    const skill: RuntimeSkill = {
      kind: 'skill',
      name: 'Finance Review',
      description: 'Review financial statements',
      instructions: 'Check assumptions and flag missing inputs.',
      materialize: 'temporary',
    };
    const capabilities = await uploadAnthropicTemporarySkills({
      capabilities: [skill],
      session: Session.create(),
      approvalHandler: async (request) => {
        approvals.push(request);
        return { type: 'approve' };
      },
      uploadClient: {
        async uploadSkill(uploadedSkill) {
          expect(uploadedSkill).toBe(skill);
          return {
            skillId: 'skill_01FinanceReview',
            version: '1759178010641129',
            raw: { id: 'skill_01FinanceReview' },
          };
        },
      },
    });

    expect(sanitizeAnthropicSkillDirectoryName('Finance Review')).toBe(
      'finance-review',
    );
    expect(approvals[0]).toMatchObject({
      provider: 'anthropic',
      action: 'uploadSkill',
      capability: 'Finance Review',
      risk: 'external',
      input: { endpoint: '/v1/skills' },
    });
    expect(capabilities).toEqual([
      {
        ...skill,
        skillId: 'skill_01FinanceReview',
        metadata: {
          source: 'custom',
          version: '1759178010641129',
          upload: { id: 'skill_01FinanceReview' },
        },
      },
    ]);
    expect(getAnthropicSkillsContainer({ capabilities })).toEqual({
      skills: [
        {
          type: 'custom',
          skill_id: 'skill_01FinanceReview',
          version: '1759178010641129',
        },
      ],
    });
  });

  it('requires approval before uploading temporary Anthropic skills', async () => {
    await expect(
      uploadAnthropicTemporarySkills({
        capabilities: [
          {
            kind: 'skill',
            name: 'docs',
            materialize: 'temporary',
          },
        ],
        session: Session.create(),
        approvalHandler: undefined,
        uploadClient: {
          async uploadSkill() {
            throw new Error('should not upload');
          },
        },
      }),
    ).rejects.toThrow('Anthropic skill upload requires an approvalHandler.');
  });

  it('posts inline RuntimeSkills to the Anthropic Skills API as form data', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new AnthropicSkillsHttpClient({
      apiKey: 'test-key',
      baseURL: 'https://api.test',
      fetch: (async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            id: 'skill_01Uploaded',
            latest_version: '1759178010641129',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }) as typeof fetch,
    });
    const skill: RuntimeSkill = {
      kind: 'skill',
      name: 'Inline Skill',
      description: 'Use a generated SKILL.md file',
      instructions: 'Follow the workflow.',
      materialize: 'temporary',
    };

    await expect(client.uploadSkill(skill)).resolves.toEqual({
      skillId: 'skill_01Uploaded',
      version: '1759178010641129',
      raw: {
        id: 'skill_01Uploaded',
        latest_version: '1759178010641129',
      },
    });

    expect(requests[0].url).toBe('https://api.test/v1/skills');
    expect(requests[0].init.method).toBe('POST');
    expect(requests[0].init.headers).toMatchObject({
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'skills-2025-10-02',
    });
    expect(requests[0].init.body).toBeInstanceOf(FormData);
    const body = requests[0].init.body as FormData;
    expect(body.get('display_title')).toBe('Inline Skill');
    const file = body.get('files') as File;
    expect(file.name).toBe('inline-skill/SKILL.md');
    await expect(file.text()).resolves.toBe(
      renderAnthropicSkillMarkdown(skill),
    );
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

  it('normalizes native Anthropic async streams without an API call', async () => {
    await expect(
      collectAsync(
        normalizeAnthropicMessagesStream(
          stream([
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hi' },
            },
            {
              type: 'message_stop',
              stop_reason: 'end_turn',
              usage: { input_tokens: 1 },
            },
          ]),
        ),
      ),
    ).resolves.toEqual([
      { type: 'text.delta', index: 0, delta: 'Hi' },
      {
        type: 'message.done',
        finishReason: 'end_turn',
        usage: { input_tokens: 1 },
      },
    ]);
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
      replayRequired: [],
    });
    expect(retainAnthropicMessageMetadata(response, 'summary')).toMatchObject({
      replayRequired: [],
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

  it('pins Anthropic replay-required blocks even when retention is none', () => {
    expect(
      retainAnthropicMessageMetadata(
        {
          id: 'msg-1',
          content: [
            {
              type: 'thinking',
              id: 'think-1',
              thinking: 'private',
              signature: 'sig',
            },
          ],
        },
        'none',
      ),
    ).toMatchObject({
      replayRequired: [
        {
          provider: 'anthropic',
          type: 'thinking.signature',
          id: 'think-1',
          artifact: {
            type: 'thinking',
            id: 'think-1',
            thinking: 'private',
            signature: 'sig',
          },
        },
      ],
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

  it('builds forced-tool schema requests when requested', () => {
    const session = Session.create().addMessage({
      type: 'user',
      content: 'Extract status and count.',
    });

    expect(
      buildAnthropicSchemaRequestBody(
        session,
        {
          provider: {
            type: 'anthropic',
            apiKey: 'test-key',
            modelName: 'claude-haiku-4-5',
          },
        },
        {
          mode: 'tool',
          schema: z.object({
            status: z.literal('ok'),
            count: z.number(),
          }),
          functionName: 'StructuredResult',
        },
      ),
    ).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Extract status and count.' }],
      tools: [
        {
          name: 'StructuredResult',
          input_schema: {
            type: 'object',
            required: ['status', 'count'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'StructuredResult' },
    });
  });

  it('builds native output_config schema requests when requested', () => {
    const session = Session.create().addMessage({
      type: 'user',
      content: 'Extract status and count.',
    });

    const body = buildAnthropicSchemaRequestBody(
      session,
      {
        provider: {
          type: 'anthropic',
          apiKey: 'test-key',
          modelName: 'claude-haiku-4-5',
        },
        maxTokens: 256,
      },
      {
        mode: 'native',
        schema: z.object({
          status: z.literal('ok'),
          count: z.number(),
        }),
      },
    );

    expect(body).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Extract status and count.' }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', const: 'ok' },
              count: { type: 'number' },
            },
            required: ['status', 'count'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('keeps structured_output as a native schema mode alias', () => {
    const session = Session.create().addMessage({
      type: 'user',
      content: 'Extract status.',
    });

    const body = buildAnthropicSchemaRequestBody(
      session,
      {
        provider: {
          type: 'anthropic',
          apiKey: 'test-key',
          modelName: 'claude-haiku-4-5',
        },
      },
      {
        mode: 'structured_output',
        schema: z.object({
          status: z.literal('ok'),
        }),
      },
    );

    expect(body).toHaveProperty('output_config');
    expect(body).not.toHaveProperty('tools');
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

function collectCacheControlledText(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectCacheControlledText);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const self =
    record.cache_control && typeof record.text === 'string'
      ? [record.text]
      : [];
  return [
    ...self,
    ...Object.values(record).flatMap(collectCacheControlledText),
  ];
}
