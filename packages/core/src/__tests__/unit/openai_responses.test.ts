import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildOpenAIResponsesRequestBody,
  collectOpenAIResponseFunctionCalls,
  convertSessionToResponsesInput,
  createOpenAIToolOutputItem,
  extractOpenAIResponseRefusal,
  finalizeOpenAIStructuredOutputMessage,
  getOpenAIInstructionCapabilities,
  getOpenAIResponsesToolDefinitions,
  getOpenAIPromptTrailTools,
  getOpenAIShellSkills,
  getOpenAIResponsesInclude,
  getOpenAIToolLoopContinuationOptions,
  getResponsesInstructions,
  normalizeOpenAIResponsesStream,
  promptTrailBuiltinToOpenAIResponsesTool,
  promptTrailMcpToOpenAIResponsesTool,
  promptTrailSkillToOpenAIShellSkill,
  promptTrailToolToOpenAIResponsesTool,
  retainOpenAIResponseMetadata,
} from '../../openai_responses';
import { Session } from '../../session';
import { Tool } from '../../tool';

describe('OpenAI Responses native adapter helpers', () => {
  it('converts PromptTrail messages into Responses input and instructions', () => {
    const session = Session.create()
      .addMessage({ type: 'system', content: 'Be concise.' })
      .addMessage({ type: 'user', content: 'Hello' })
      .addMessage({ type: 'assistant', content: 'Hi' })
      .addMessage({ type: 'user', content: 'Continue' });

    expect(getResponsesInstructions(session)).toBe('Be concise.');
    expect(convertSessionToResponsesInput(session)).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Continue' },
    ]);
  });

  it('converts only messages after a conversation binding when provided', () => {
    const session = Session.create()
      .addMessage({ type: 'user', content: 'Hello' })
      .addMessage({
        type: 'assistant',
        content: 'Hi',
        attrs: { openai: { responseId: 'resp-1' } },
      })
      .addMessage({ type: 'user', content: 'Continue' });

    expect(
      convertSessionToResponsesInput(session, {
        provider: 'openai',
        id: 'resp-1',
        messageIndex: 1,
      }),
    ).toEqual([{ role: 'user', content: 'Continue' }]);
  });

  it('replays pinned OpenAI reasoning and compaction items in stateless input', () => {
    const session = Session.create()
      .addMessage({ type: 'user', content: 'Use hidden reasoning.' })
      .addMessage({
        type: 'assistant',
        content: 'Done.',
        attrs: {
          openai: {
            replayRequired: [
              {
                provider: 'openai',
                type: 'reasoning.encrypted_content',
                id: 'rs_1',
                artifact: {
                  type: 'reasoning',
                  id: 'rs_1',
                  encrypted_content: 'encrypted',
                },
              },
              {
                provider: 'openai',
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

    expect(convertSessionToResponsesInput(session)).toEqual([
      { role: 'user', content: 'Use hidden reasoning.' },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted' },
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'compact' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Continue' },
    ]);
  });

  it('builds Responses request bodies for streaming and cached bindings', () => {
    expect(
      buildOpenAIResponsesRequestBody(
        [{ role: 'user', content: 'Continue' }],
        {
          provider: {
            type: 'openai',
            apiKey: 'test-key',
            modelName: 'gpt-5.4-nano',
            api: 'responses',
          },
          thinking: { effort: 'low', summary: true },
          cacheKey: 'prefix',
        },
        [{ type: 'function', name: 'lookup' }],
        'Be concise.',
        undefined,
        { provider: 'openai', id: 'resp-1', messageIndex: 1 },
        true,
      ),
    ).toMatchObject({
      model: 'gpt-5.4-nano',
      input: [{ role: 'user', content: 'Continue' }],
      instructions: 'Be concise.',
      previous_response_id: 'resp-1',
      reasoning: { effort: 'low', summary: 'auto' },
      include: undefined,
      prompt_cache_key: 'prefix',
      tools: [{ type: 'function', name: 'lookup' }],
      stream: true,
    });
    expect(getOpenAIResponsesInclude({ thinking: { effort: 'low' } })).toEqual([
      'reasoning.encrypted_content',
    ]);
    expect(
      getOpenAIResponsesInclude(
        { thinking: { effort: 'low' } },
        { provider: 'openai', id: 'resp-1', messageIndex: 1 },
      ),
    ).toBeUndefined();
  });

  it('keeps Responses tools and native text format together for schema tool loops', () => {
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Lookup a fixed test value',
      inputSchema: z.object({ key: z.string() }),
      execute: ({ key }) => ({ value: key }),
    });
    const textFormat = {
      type: 'json_schema',
      name: 'ToolSchemaResult',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
        additionalProperties: false,
      },
    };

    expect(
      buildOpenAIResponsesRequestBody(
        [{ role: 'user', content: 'Call lookup, then return JSON.' }],
        {
          provider: {
            type: 'openai',
            apiKey: 'test-key',
            modelName: 'gpt-5.4-nano',
            api: 'responses',
          },
          capabilities: [lookup],
          toolChoice: 'required',
        },
        getOpenAIResponsesToolDefinitions({ capabilities: [lookup] }),
        undefined,
        textFormat,
      ),
    ).toMatchObject({
      model: 'gpt-5.4-nano',
      input: [{ role: 'user', content: 'Call lookup, then return JSON.' }],
      text: { format: textFormat },
      tools: [
        {
          type: 'function',
          name: 'lookup',
          strict: true,
        },
      ],
      tool_choice: 'required',
    });
  });

  it('relaxes required OpenAI tool choice after tool outputs are appended', () => {
    const options = {
      provider: {
        type: 'openai' as const,
        apiKey: 'test-key',
        modelName: 'gpt-5.4-nano',
        api: 'responses' as const,
      },
      toolChoice: 'required' as const,
    };

    expect(getOpenAIToolLoopContinuationOptions(options)).toEqual({
      ...options,
      toolChoice: 'auto',
    });
    expect(
      getOpenAIToolLoopContinuationOptions({
        ...options,
        toolChoice: 'auto',
      }),
    ).toEqual({ ...options, toolChoice: 'auto' });
  });

  it('converts content parts into Responses input message blocks', () => {
    const session = Session.create().addMessage({
      type: 'user',
      content: 'Inspect this.',
      contentParts: [
        { kind: 'text', text: 'Inspect this.' },
        {
          kind: 'image',
          mimeType: 'image/png',
          source: { type: 'bytes', data: new Uint8Array([1, 2, 3]) },
          detail: 'high',
        },
      ],
    });

    expect(convertSessionToResponsesInput(session)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Inspect this.' },
          {
            type: 'input_image',
            detail: 'high',
            file_data: 'AQID',
          },
        ],
      },
    ]);
  });

  it('retains only binding-safe metadata at retain none', () => {
    expect(
      retainOpenAIResponseMetadata(
        {
          id: 'resp-1',
          status: 'completed',
          output: [{ type: 'message', id: 'item-1' }],
          usage: { input_tokens: 1 },
        },
        'none',
        'fnv1a:test',
      ),
    ).toEqual({
      provider: 'openai',
      api: 'responses',
      responseId: 'resp-1',
      historyFingerprint: 'fnv1a:test',
      status: 'completed',
      error: undefined,
      incompleteDetails: undefined,
      replayRequired: [],
    });
  });

  it('stores an optional history fingerprint with the response binding', () => {
    expect(
      retainOpenAIResponseMetadata(
        {
          id: 'resp-1',
          status: 'completed',
        },
        'none',
        'fnv1a:test',
      ),
    ).toMatchObject({
      responseId: 'resp-1',
      historyFingerprint: 'fnv1a:test',
    });
  });

  it('surfaces OpenAI structured output refusals in response metadata', () => {
    const output = [
      {
        type: 'message',
        id: 'msg-1',
        content: [
          {
            type: 'refusal',
            refusal: 'I cannot comply with that request.',
          },
        ],
      },
    ];

    expect(extractOpenAIResponseRefusal(output)).toBe(
      'I cannot comply with that request.',
    );
    expect(
      retainOpenAIResponseMetadata(
        {
          id: 'resp-1',
          status: 'completed',
          output,
        },
        'summary',
      ),
    ).toMatchObject({
      refusal: 'I cannot comply with that request.',
    });
  });

  it('returns OpenAI structured refusals without parsing assistant text', () => {
    const message = {
      type: 'assistant' as const,
      content: ' ',
      attrs: {
        openai: {
          provider: 'openai',
          api: 'responses',
          responseId: 'resp-1',
          refusal: 'I cannot comply with that request.',
        },
      },
    };

    expect(
      finalizeOpenAIStructuredOutputMessage(message, {
        schema: z.object({ status: z.literal('ok') }),
      }),
    ).toEqual({
      ...message,
      structuredOutput: undefined,
    });
  });

  it('raises a clear OpenAI structured output error for non-JSON text', () => {
    expect(() =>
      finalizeOpenAIStructuredOutputMessage(
        {
          type: 'assistant',
          content: 'not json',
        },
        {
          schema: z.object({ status: z.literal('ok') }),
        },
      ),
    ).toThrow('OpenAI structured output was not valid JSON');
  });

  it('summarizes output items by default and keeps raw only at full retention', () => {
    const response = {
      id: 'resp-1',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'item-1',
          status: 'completed',
          content: [{ text: 'x'.repeat(600) }],
        },
      ],
      usage: { input_tokens: 1 },
    };

    expect(retainOpenAIResponseMetadata(response, 'summary')).toEqual({
      provider: 'openai',
      api: 'responses',
      responseId: 'resp-1',
      status: 'completed',
      error: undefined,
      incompleteDetails: undefined,
      replayRequired: [],
      usage: { input_tokens: 1 },
      outputItems: [
        {
          type: 'message',
          id: 'item-1',
          status: 'completed',
          preview: 'x'.repeat(500),
          truncated: true,
          fullLength: 600,
        },
      ],
    });

    expect(retainOpenAIResponseMetadata(response, 'full')).toMatchObject({
      responseId: 'resp-1',
      outputItems: response.output,
      raw: response,
    });
  });

  it('keeps modern or unknown OpenAI output item types at full retention', () => {
    const response = {
      id: 'resp-1',
      status: 'completed',
      output: [
        {
          type: 'tool_search_call',
          id: 'search-1',
          status: 'completed',
          query: 'docs',
        },
        {
          type: 'mcp_approval_request',
          id: 'approval-1',
          server_label: 'docs',
        },
        {
          type: 'future_item_type',
          id: 'future-1',
          payload: { opaque: true },
        },
      ],
    };

    expect(retainOpenAIResponseMetadata(response, 'full')).toMatchObject({
      outputItems: response.output,
      raw: response,
    });
  });

  it('pins OpenAI replay-required artifacts even when retention is none', () => {
    expect(
      retainOpenAIResponseMetadata(
        {
          id: 'resp-1',
          output: [
            {
              type: 'reasoning',
              id: 'rs_1',
              encrypted_content: 'encrypted',
            },
          ],
        },
        'none',
      ),
    ).toMatchObject({
      replayRequired: [
        {
          provider: 'openai',
          type: 'reasoning.encrypted_content',
          id: 'rs_1',
          artifact: {
            type: 'reasoning',
            id: 'rs_1',
            encrypted_content: 'encrypted',
          },
        },
      ],
    });
  });

  it('maps PromptTrail tools to strict Responses function tools', () => {
    const tool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().optional(),
      }),
      execute: ({ query }) => ({ query }),
    });

    expect(getOpenAIPromptTrailTools({ capabilities: [tool] })).toEqual([tool]);
    expect(promptTrailToolToOpenAIResponsesTool(tool)).toEqual({
      type: 'function',
      name: 'lookup',
      description: 'Lookup docs',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: ['number', 'null'] },
        },
        required: ['query', 'limit'],
        additionalProperties: false,
      },
    });
  });

  it('maps provider-hosted builtins and HTTP MCP servers to Responses tools', () => {
    const builtin = {
      kind: 'builtin' as const,
      name: 'web_search_preview',
      provider: 'openai' as const,
      executionMode: 'provider' as const,
      config: { search_context_size: 'low' },
    };
    const mcp = {
      kind: 'mcp' as const,
      name: 'docs',
      transport: {
        kind: 'http' as const,
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer test' },
      },
      tools: ['lookup'],
    };

    expect(promptTrailBuiltinToOpenAIResponsesTool(builtin)).toEqual({
      type: 'web_search_preview',
      search_context_size: 'low',
    });
    expect(promptTrailMcpToOpenAIResponsesTool(mcp)).toEqual({
      type: 'mcp',
      server_label: 'docs',
      server_url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer test' },
      allowed_tools: ['lookup'],
    });
    expect(
      getOpenAIResponsesToolDefinitions({ capabilities: [builtin, mcp] }),
    ).toEqual([
      { type: 'web_search_preview', search_context_size: 'low' },
      {
        type: 'mcp',
        server_label: 'docs',
        server_url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer test' },
        allowed_tools: ['lookup'],
      },
    ]);
  });

  it('rejects non-HTTP MCP servers for native Responses tools', () => {
    const mcp = {
      kind: 'mcp' as const,
      name: 'local-docs',
      transport: {
        kind: 'stdio' as const,
        command: 'docs-mcp',
      },
      tools: 'all' as const,
    };

    expect(() => promptTrailMcpToOpenAIResponsesTool(mcp)).toThrow(
      'OpenAI Responses native MCP only supports HTTP transport; MCP server "local-docs" uses stdio.',
    );
    expect(() =>
      getOpenAIResponsesToolDefinitions({ capabilities: [mcp] }),
    ).toThrow(
      'OpenAI Responses native MCP only supports HTTP transport; MCP server "local-docs" uses stdio.',
    );
  });

  it('mounts RuntimeSkills on explicitly enabled OpenAI shell tools', () => {
    const shell = {
      kind: 'builtin' as const,
      name: 'hosted_shell',
      provider: 'openai' as const,
      executionMode: 'provider' as const,
      config: { environment: { image: 'python' } },
    };
    const mountedSkill = {
      kind: 'skill' as const,
      name: 'pptx',
      skillId: 'skill_123',
      instructions: 'Create slides.',
    };
    const localSkill = {
      kind: 'skill' as const,
      name: 'local-docs',
      path: '.codex/skills/local-docs',
    };
    const instructionOnlySkill = {
      kind: 'skill' as const,
      name: 'style',
      instructions: 'Use house style.',
    };

    expect(
      getOpenAIShellSkills([
        shell,
        mountedSkill,
        localSkill,
        instructionOnlySkill,
      ]),
    ).toEqual([mountedSkill, localSkill]);
    expect(promptTrailSkillToOpenAIShellSkill(mountedSkill)).toEqual({
      id: 'skill_123',
      name: 'pptx',
    });
    expect(
      promptTrailBuiltinToOpenAIResponsesTool(shell, [mountedSkill]),
    ).toEqual({
      type: 'hosted_shell',
      environment: {
        image: 'python',
        skills: [{ id: 'skill_123', name: 'pptx' }],
      },
    });
    expect(
      getOpenAIResponsesToolDefinitions({
        capabilities: [shell, mountedSkill, localSkill, instructionOnlySkill],
      }),
    ).toEqual([
      {
        type: 'hosted_shell',
        environment: {
          image: 'python',
          skills: [
            { id: 'skill_123', name: 'pptx' },
            { path: '.codex/skills/local-docs', name: 'local-docs' },
          ],
        },
      },
    ]);
    expect(
      getOpenAIInstructionCapabilities([
        shell,
        mountedSkill,
        localSkill,
        instructionOnlySkill,
      ]),
    ).toEqual([shell, instructionOnlySkill]);
  });

  it('collects function calls and creates tool output items', async () => {
    const tool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }, context) => ({
        query,
        provider: context.provider,
      }),
    });
    const calls = collectOpenAIResponseFunctionCalls([
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'lookup',
        arguments: JSON.stringify({ query: 'capabilities' }),
      },
    ]);

    expect(calls).toEqual([
      {
        callId: 'call-1',
        name: 'lookup',
        arguments: { query: 'capabilities' },
        raw: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'lookup',
          arguments: JSON.stringify({ query: 'capabilities' }),
        },
      },
    ]);

    await expect(
      createOpenAIToolOutputItem(calls[0], [tool], Session.create()),
    ).resolves.toEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: JSON.stringify({
        content: [
          {
            type: 'json',
            json: { query: 'capabilities', provider: 'openai' },
          },
        ],
        structuredContent: { query: 'capabilities', provider: 'openai' },
      }),
    });
  });

  it('uses approval handlers for native Responses tool executions', async () => {
    let executed = false;
    const tool = Tool.create({
      name: 'deleteRepo',
      description: 'Delete repo',
      inputSchema: z.object({ path: z.string() }),
      approval: 'always',
      execute: () => {
        executed = true;
        return { ok: true };
      },
    });

    const result = await createOpenAIToolOutputItem(
      {
        callId: 'call-approval',
        name: 'deleteRepo',
        arguments: { path: '/repo' },
        raw: { type: 'function_call' },
      },
      [tool],
      Session.create(),
      async (request) => {
        expect(request).toMatchObject({
          provider: 'openai',
          action: 'tool.execute',
          capability: 'deleteRepo',
          input: { path: '/repo' },
        });
        return { type: 'deny', reason: 'too risky' };
      },
    );

    expect(executed).toBe(false);
    expect(result).toEqual({
      type: 'function_call_output',
      call_id: 'call-approval',
      output: JSON.stringify({
        content: [
          { type: 'text', text: 'Tool execution denied: too risky' },
        ],
        isError: true,
      }),
    });
  });

  it('normalizes native Responses async streams without an API call', async () => {
    await expect(
      collectAsync(
        normalizeOpenAIResponsesStream(
          stream([
            {
              type: 'response.output_text.delta',
              output_index: 0,
              delta: 'Hi',
            },
            {
              type: 'response.completed',
              response: { status: 'completed', usage: { input_tokens: 1 } },
            },
          ]),
        ),
      ),
    ).resolves.toEqual([
      { type: 'text.delta', index: 0, delta: 'Hi' },
      {
        type: 'message.done',
        finishReason: 'completed',
        usage: { input_tokens: 1 },
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

async function* stream(events: unknown[]) {
  for (const event of events) {
    yield event;
  }
}
