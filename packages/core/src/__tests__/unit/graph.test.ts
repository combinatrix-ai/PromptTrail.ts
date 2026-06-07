import { describe, expect, it } from 'vitest';
import {
  AgentGraphValidationError,
  createAgentGraph,
  createAgentGraphManifest,
  validateAgentGraph,
  type AgentGraph,
} from '../../graph';

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
      nodes: [
        { id: 'node', type: 'patch', data: { b: 2, a: 1 } },
      ],
    });
    const right = createAgentGraph({
      name: 'stable',
      version: 'v1',
      nodes: [
        { id: 'node', type: 'patch', data: { a: 1, b: 2 } },
      ],
    });

    expect(createAgentGraphManifest(left).hash).toBe(
      createAgentGraphManifest(right).hash,
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
            id: 'turn',
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
