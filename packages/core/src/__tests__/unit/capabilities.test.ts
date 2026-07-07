import { describe, expect, it } from 'vitest';
import {
  assertCheckpointDiscoveredToolEffectDeclaration,
  requireConfiguredCapabilityApproval,
  resolveConfiguredCapabilityApproval,
  type McpServer,
} from '../../capabilities';
import { Session } from '../../session';

describe('configured capability approvals', () => {
  const session = Session.create();

  it('approves configured capabilities without an approval policy', async () => {
    const server: McpServer = {
      kind: 'mcp',
      name: 'docs',
      transport: { kind: 'http', url: 'https://mcp.example.com' },
    };

    await expect(
      resolveConfiguredCapabilityApproval(server, {
        provider: 'openai',
        session,
      }),
    ).resolves.toEqual({ type: 'approve' });
  });

  it('requires an approval handler for policy-based capability approvals', async () => {
    const server: McpServer = {
      kind: 'mcp',
      name: 'repo',
      transport: { kind: 'stdio', command: 'repo-mcp' },
      approval: 'always',
    };

    await expect(
      requireConfiguredCapabilityApproval(server, {
        provider: 'codex',
        session,
      }),
    ).rejects.toThrow(
      'Capability "repo" approval denied: Capability "repo" requires approval but no approval handler was provided.',
    );
  });

  it('sends MCP configuration details to the approval handler', async () => {
    const server: McpServer = {
      kind: 'mcp',
      name: 'docs',
      transport: { kind: 'http', url: 'https://mcp.example.com' },
      tools: ['search'],
      approval: 'always',
    };
    const requests: unknown[] = [];

    await expect(
      requireConfiguredCapabilityApproval(server, {
        provider: 'claude-agent',
        session,
        approvalHandler: async (request) => {
          requests.push(request);
          return { type: 'approve' };
        },
      }),
    ).resolves.toBeUndefined();

    expect(requests[0]).toMatchObject({
      provider: 'claude-agent',
      action: 'mcp.configure',
      capability: 'docs',
      risk: 'external',
      input: {
        transport: { kind: 'http', url: 'https://mcp.example.com' },
        tools: ['search'],
      },
    });
  });

  it('sends builtin enablement details to the approval handler', async () => {
    const builtin = {
      kind: 'builtin' as const,
      name: 'hosted_shell',
      executionMode: 'provider' as const,
      config: { timeoutMs: 1000 },
      approval: 'always' as const,
    };
    const requests: unknown[] = [];

    await expect(
      requireConfiguredCapabilityApproval(builtin, {
        provider: 'openai',
        session,
        approvalHandler: async (request) => {
          requests.push(request);
          return { type: 'approve' };
        },
      }),
    ).resolves.toBeUndefined();

    expect(requests[0]).toMatchObject({
      provider: 'openai',
      action: 'builtin.enable',
      capability: 'hosted_shell',
      risk: 'execute',
      input: {
        executionMode: 'provider',
        config: { timeoutMs: 1000 },
      },
    });
  });

  it('guards checkpoint MCP tools discovered without source effects', () => {
    const server: McpServer = {
      kind: 'mcp',
      name: 'docs',
      transport: { kind: 'http', url: 'https://mcp.example.com' },
      effects: {
        perTool: {
          search: { repeatable: true },
        },
      },
    };

    expect(
      assertCheckpointDiscoveredToolEffectDeclaration(server, 'search'),
    ).toEqual({ repeatable: true });
    expect(() =>
      assertCheckpointDiscoveredToolEffectDeclaration(server, 'fetch'),
    ).toThrow(
      'Checkpoint MCP tool "fetch" discovered from server "docs" is missing an ExecutionEffectDeclaration.',
    );
  });
});
