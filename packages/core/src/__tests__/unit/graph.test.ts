import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentGraphValidationError,
  createAgentGraph,
  createAgentGraphManifest,
  validateAgentGraph,
  type AgentGraph,
} from '../../graph';
import { Source } from '../../source';
import type { PromptTrailTool } from '../../tool';

describe('AgentGraph', () => {
  it('creates a durable/app graph manifest with stable node paths', () => {
    const graph = createAgentGraph({
      name: 'assistant',
      version: 'v1',
      nodes: [
        { id: 'system', type: 'system', data: { content: 'Be concise.' } },
        {
          id: 'main',
          type: 'loop',
          children: [
            { id: 'inbound', type: 'inbox' },
            {
              id: 'toolLoop',
              type: 'loop',
              children: [
                { id: 'reply', type: 'assistant' },
                { id: 'tools', type: 'tools' },
              ],
            },
            { id: 'next', type: 'awaitInput' },
          ],
        },
      ],
    });

    const manifest = createAgentGraphManifest(graph);

    expect(manifest.name).toBe('assistant');
    expect(manifest.version).toBe('v1');
    expect(manifest.nodes.map((node) => node.path)).toEqual([
      'assistant/system',
      'assistant/main',
      'assistant/main/inbound',
      'assistant/main/toolLoop',
      'assistant/main/toolLoop/reply',
      'assistant/main/toolLoop/tools',
      'assistant/main/next',
    ]);
    expect(manifest.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps manifests stable for equivalent object key ordering', () => {
    const left = createAgentGraph({
      name: 'stable',
      version: 'v1',
      nodes: [{ id: 'node', type: 'transform', data: { b: 2, a: 1 } }],
    });
    const right = createAgentGraph({
      name: 'stable',
      version: 'v1',
      nodes: [{ id: 'node', type: 'transform', data: { a: 1, b: 2 } }],
    });

    expect(createAgentGraphManifest(left).hash).toBe(
      createAgentGraphManifest(right).hash,
    );
  });

  it('includes binary tool activity in graph manifests', () => {
    function lookupKey(input: unknown): string {
      return `lookup:${(input as { id: string }).id}`;
    }
    function otherLookupKey(input: unknown): string {
      return `lookup:${(input as { id: string }).id}`;
    }
    const tool = (
      idempotencyKey: (input: unknown) => string,
    ): PromptTrailTool => ({
      kind: 'tool',
      name: 'lookup',
      description: 'Lookup',
      inputSchema: z.object({ id: z.string() }),
      activity: { idempotencyKey },
      execute: ({ id }) => ({ id }),
    });
    const keyedGraph = createAgentGraph({
      name: 'tools',
      nodes: [{ id: 'reply', type: 'assistant' }],
      tools: { lookup: tool(lookupKey) },
    });
    const renamedKeyGraph = createAgentGraph({
      name: 'tools',
      nodes: [{ id: 'reply', type: 'assistant' }],
      tools: { lookup: tool(otherLookupKey) },
    });

    const manifest = createAgentGraphManifest(keyedGraph);

    expect(manifest.tools).toEqual([
      {
        name: 'lookup',
        activity: {
          idempotencyKey: { kind: 'function', name: 'lookupKey' },
        },
      },
    ]);
    expect(manifest.hash).not.toBe(
      createAgentGraphManifest(renamedKeyGraph).hash,
    );
  });

  it('does not detect function key body edits in graph manifests', () => {
    const tool = (
      idempotencyKey: (input: unknown) => string,
    ): PromptTrailTool => ({
      kind: 'tool',
      name: 'lookup',
      description: 'Lookup',
      inputSchema: z.object({ id: z.string() }),
      activity: { idempotencyKey },
      execute: ({ id }) => ({ id }),
    });
    const firstKey = function lookupKey(): string {
      return 'first';
    };
    const secondKey = function lookupKey(): string {
      return 'second';
    };
    const firstGraph = createAgentGraph({
      name: 'tools',
      nodes: [{ id: 'reply', type: 'assistant' }],
      tools: { lookup: tool(firstKey) },
    });
    const secondGraph = createAgentGraph({
      name: 'tools',
      nodes: [{ id: 'reply', type: 'assistant' }],
      tools: { lookup: tool(secondKey) },
    });

    expect(createAgentGraphManifest(firstGraph).hash).toBe(
      createAgentGraphManifest(secondGraph).hash,
    );
  });

  it('does not treat shared manifest references as circular values', () => {
    const shared = { model: 'gpt-test' };
    const graph = createAgentGraph({
      name: 'shared',
      nodes: [
        {
          id: 'reply',
          type: 'assistant',
          data: { left: shared, right: shared },
        },
      ],
    });

    expect(createAgentGraphManifest(graph).nodes[0].data).toEqual({
      left: { model: 'gpt-test' },
      right: { model: 'gpt-test' },
    });
  });

  it('captures opaque LLM source config without leaking credentials', () => {
    const buildSource = (schema = z.object({ ok: z.boolean() })) =>
      Source.llm()
        .anthropic({
          apiKey: 'sk-secret',
          modelName: 'claude-test',
          baseURL: 'https://private.example.test',
        })
        .temperature(0.2)
        .maxTokens(64)
        .withCapabilities([
          {
            kind: 'tool',
            name: 'local_lookup',
            description: 'Lookup local state.',
            inputSchema: z.object({ query: z.string() }),
            execute: function localLookup() {
              return 'ok';
            },
          },
          {
            kind: 'skill',
            name: 'planner',
            description: 'Plan work.',
            instructions: 'Break the work into concrete steps.',
            path: 'skills/planner',
          },
          {
            kind: 'builtin',
            name: 'web_search',
            provider: 'openai',
            executionMode: 'provider',
            config: { apiToken: 'tool-secret' },
            metadata: { owner: 'secret-owner' },
          },
          {
            kind: 'mcp',
            name: 'private-mcp',
            transport: {
              kind: 'http',
              url: 'https://mcp.example.test',
              headers: { Authorization: 'secret-header' },
            },
            tools: ['lookup'],
          },
        ])
        .dangerouslyAllowBrowser()
        .withSchema(schema, {
          mode: 'tool',
          functionName: 'make_result',
        });
    const source = buildSource();
    const graph = createAgentGraph({
      name: 'llmManifest',
      version: 'v1',
      nodes: [{ id: 'reply', type: 'assistant', data: { input: source } }],
    });
    const sameConfig = createAgentGraph({
      name: 'llmManifest',
      version: 'v1',
      nodes: [
        { id: 'reply', type: 'assistant', data: { input: buildSource() } },
      ],
    });
    const modelChanged = createAgentGraph({
      name: 'llmManifest',
      version: 'v1',
      nodes: [
        {
          id: 'reply',
          type: 'assistant',
          data: {
            input: Source.llm().anthropic({ modelName: 'claude-other' }),
          },
        },
      ],
    });
    const schemaChanged = createAgentGraph({
      name: 'llmManifest',
      version: 'v1',
      nodes: [
        {
          id: 'reply',
          type: 'assistant',
          data: {
            input: buildSource(
              z.object({ ok: z.boolean(), danger: z.string() }),
            ),
          },
        },
      ],
    });

    const manifest = createAgentGraphManifest(graph);
    const data = manifest.nodes[0].data;

    expect(data).toMatchObject({
      input: {
        kind: 'manifestDescriptor',
        descriptor: {
          kind: 'source',
          sourceType: 'LlmSource',
          config: {
            provider: {
              type: 'anthropic',
              modelName: 'claude-test',
              apiKey: { present: true },
              baseURL: { present: true },
            },
            generation: {
              temperature: 0.2,
              maxTokens: 64,
              dangerouslyAllowBrowser: true,
            },
            schema: {
              mode: 'tool',
              functionName: 'make_result',
            },
            capabilities: [
              {
                kind: 'tool',
                name: 'local_lookup',
                description: 'Lookup local state.',
                inputSchema: {
                  typeName: 'ZodObject',
                },
                execute: { kind: 'function', name: 'localLookup' },
              },
              {
                kind: 'skill',
                name: 'planner',
                description: 'Plan work.',
                instructions: 'Break the work into concrete steps.',
                path: 'skills/planner',
              },
              {
                kind: 'builtin',
                name: 'web_search',
                provider: 'openai',
                executionMode: 'provider',
                configKeys: ['apiToken'],
                metadataKeys: ['owner'],
              },
              {
                kind: 'mcp',
                name: 'private-mcp',
                transport: {
                  kind: 'http',
                  url: 'https://mcp.example.test',
                  headerKeys: ['Authorization'],
                },
                tools: ['lookup'],
              },
            ],
          },
        },
      },
    });
    expect(JSON.stringify(data)).not.toContain('sk-secret');
    expect(JSON.stringify(data)).not.toContain('private.example.test');
    expect(JSON.stringify(data)).not.toContain('tool-secret');
    expect(JSON.stringify(data)).not.toContain('secret-owner');
    expect(JSON.stringify(data)).not.toContain('secret-header');
    expect(manifest.hash).toBe(createAgentGraphManifest(sameConfig).hash);
    expect(manifest.hash).not.toBe(createAgentGraphManifest(modelChanged).hash);
    expect(manifest.hash).not.toBe(
      createAgentGraphManifest(schemaChanged).hash,
    );
  });

  it('rejects missing stable ids for app and durable graphs', () => {
    const graph: AgentGraph = {
      name: 'assistant',
      version: 'v1',
      nodes: [{ id: '', type: 'assistant' }],
      edges: [],
      tools: {},
      middleware: [],
      hooks: [],
      observers: [],
    };

    expect(() => validateAgentGraph(graph, { durable: true })).toThrow(
      AgentGraphValidationError,
    );
  });

  it('rejects ids with leading or trailing whitespace', () => {
    expect(() =>
      createAgentGraph({
        name: 'assistant',
        nodes: [{ id: ' reply', type: 'assistant' }],
      }),
    ).toThrow(AgentGraphValidationError);
  });

  it('allows anonymous node ids for ephemeral graph validation', () => {
    const graph: AgentGraph = {
      name: 'assistant',
      version: 'v1',
      nodes: [{ id: '', type: 'assistant' }],
      edges: [],
      tools: {},
      middleware: [],
      hooks: [],
      observers: [],
    };

    expect(() => validateAgentGraph(graph)).not.toThrow();
  });

  it('rejects duplicate local child ids', () => {
    expect(() =>
      createAgentGraph({
        name: 'assistant',
        nodes: [
          {
            id: 'loop',
            type: 'loop',
            children: [
              { id: 'reply', type: 'assistant' },
              { id: 'reply', type: 'tools' },
            ],
          },
        ],
      }),
    ).toThrow(/Duplicate child graph node id/);
  });

  it('validates nested edge paths relative to the graph root', () => {
    expect(() =>
      createAgentGraph({
        name: 'assistant',
        nodes: [
          {
            id: 'loop',
            type: 'loop',
            children: [
              { id: 'reply', type: 'assistant' },
              { id: 'tools', type: 'tools' },
            ],
          },
        ],
        edges: [{ from: 'loop/reply', to: 'loop/tools' }],
      }),
    ).not.toThrow();
  });

  it('requires stable middleware and hook names for durable graphs', () => {
    expect(() =>
      createAgentGraph({
        name: 'assistant',
        nodes: [{ id: 'reply', type: 'assistant' }],
        middleware: [{ beforeModel: ({ session }) => ({ session }) }],
      }),
    ).toThrow(/middleware/);

    expect(() =>
      createAgentGraph({
        name: 'assistant',
        nodes: [{ id: 'reply', type: 'assistant' }],
        hooks: [{ onRunStart: ({ session }) => ({ session }) }],
      }),
    ).toThrow(/hook/);
  });
});
