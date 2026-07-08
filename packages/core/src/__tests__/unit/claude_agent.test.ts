import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  buildClaudeAgentQueryParams,
  collectClaudeAgentTurnResult,
  createClaudePromptTrailMcpServer,
  getClaudeAllowedToolNames,
  getClaudeAgentMcpServers,
  getClaudeSkillNames,
  materializeClaudeAgentSkills,
  promptTrailMcpToClaudeAgentMcpServer,
  promptTrailToolToClaudeAgentToolDefinition,
  renderClaudeSkillMarkdown,
  sanitizeClaudeSkillName,
} from '../../claude_agent';
import type { CapabilitySet, PromptTrailTool } from '../../capabilities';
import { Session } from '../../session';
import { Tool } from '../../tool';

describe('Claude Agent SDK adapter helpers', () => {
  it('maps PromptTrail tools to in-process MCP tool definitions', async () => {
    const session = Session.create();
    const lookupTool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }, context) => ({
        query,
        provider: context.provider,
        channel: context.services?.channel,
      }),
    });
    const definition = promptTrailToolToClaudeAgentToolDefinition(
      lookupTool as PromptTrailTool,
      session,
      undefined,
      { channel: 'claw-test' },
    );

    expect(definition).toMatchObject({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    });
    await expect(
      definition.execute({ query: 'capabilities' }),
    ).resolves.toEqual({
      content: [
        {
          type: 'json',
          json: {
            query: 'capabilities',
            provider: 'claude-agent',
            channel: 'claw-test',
          },
        },
      ],
      structuredContent: {
        query: 'capabilities',
        provider: 'claude-agent',
        channel: 'claw-test',
      },
    });
  });

  it('uses approval handlers for Claude Agent in-process MCP tools', async () => {
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
    const definition = promptTrailToolToClaudeAgentToolDefinition(
      tool as PromptTrailTool,
      Session.create(),
      async (request) => {
        expect(request).toMatchObject({
          provider: 'claude-agent',
          action: 'tool.execute',
          capability: 'deleteRepo',
          input: { path: '/repo' },
        });
        return { type: 'deny', reason: 'too risky' };
      },
    );

    await expect(definition.execute({ path: '/repo' })).resolves.toEqual({
      content: [{ type: 'text', text: 'Tool execution denied: too risky' }],
      isError: true,
    });
    expect(executed).toBe(false);
  });

  it('builds Claude Agent query params with MCP server and allowed tool names', () => {
    const lookupTool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) => ({ query }),
    });

    expect(
      getClaudeAllowedToolNames([lookupTool] as PromptTrailTool[]),
    ).toEqual(['mcp__prompttrail__lookup']);
    expect(
      createClaudePromptTrailMcpServer(
        [lookupTool] as PromptTrailTool[],
        Session.create(),
      ),
    ).toMatchObject({
      name: 'prompttrail',
      tools: [
        {
          name: 'lookup',
          description: 'Lookup docs',
        },
      ],
    });
    expect(
      buildClaudeAgentQueryParams('Use the tool', Session.create(), {
        cwd: '/repo',
        model: 'claude-haiku-4-5',
        allowedTools: ['Read'],
        sessionId: 'session-existing',
        skills: ['code-review'],
        capabilities: [
          lookupTool,
          { kind: 'skill', name: 'repo-docs', instructions: 'Use docs.' },
        ] as CapabilitySet,
      }),
    ).toMatchObject({
      prompt: 'Use the tool',
      options: {
        cwd: '/repo',
        model: 'claude-haiku-4-5',
        allowedTools: ['Read', 'mcp__prompttrail__lookup'],
        resume: 'session-existing',
        skills: ['code-review', 'repo-docs'],
        mcpServers: {
          prompttrail: {
            name: 'prompttrail',
            tools: [{ name: 'lookup' }],
          },
        },
      },
    });
  });

  it('maps MCP server capabilities into Claude Agent SDK options', () => {
    const inProcessServer = { name: 'memory', tools: [] };
    const capabilities = [
      {
        kind: 'mcp' as const,
        name: 'docs',
        transport: {
          kind: 'http' as const,
          url: 'https://mcp.example.com',
          headers: { authorization: 'Bearer test' },
        },
        tools: ['search', 'fetch'],
      },
      {
        kind: 'mcp' as const,
        name: 'repo',
        transport: {
          kind: 'stdio' as const,
          command: 'repo-mcp',
          args: ['--root', '/repo'],
          env: { NODE_ENV: 'test' },
        },
        tools: 'all' as const,
      },
      {
        kind: 'mcp' as const,
        name: 'memory',
        transport: {
          kind: 'sdk-in-process' as const,
          server: inProcessServer,
        },
      },
    ];

    expect(promptTrailMcpToClaudeAgentMcpServer(capabilities[0])).toEqual({
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { authorization: 'Bearer test' },
      allowedTools: ['search', 'fetch'],
    });
    expect(promptTrailMcpToClaudeAgentMcpServer(capabilities[1])).toEqual({
      type: 'stdio',
      command: 'repo-mcp',
      args: ['--root', '/repo'],
      env: { NODE_ENV: 'test' },
      allowedTools: undefined,
    });
    expect(promptTrailMcpToClaudeAgentMcpServer(capabilities[2])).toBe(
      inProcessServer,
    );
    expect(
      getClaudeAgentMcpServers(capabilities, [], Session.create()),
    ).toEqual({
      docs: {
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { authorization: 'Bearer test' },
        allowedTools: ['search', 'fetch'],
      },
      repo: {
        type: 'stdio',
        command: 'repo-mcp',
        args: ['--root', '/repo'],
        env: { NODE_ENV: 'test' },
        allowedTools: undefined,
      },
      memory: inProcessServer,
    });

    expect(
      buildClaudeAgentQueryParams('Use docs MCP', Session.create(), {
        capabilities,
      }),
    ).toMatchObject({
      options: {
        allowedTools: ['mcp__docs__search', 'mcp__docs__fetch'],
        mcpServers: {
          docs: { type: 'http' },
          repo: { type: 'stdio' },
          memory: inProcessServer,
        },
      },
    });
  });

  it('maps BuiltinTool capabilities into Claude Agent allowed tools', () => {
    expect(
      buildClaudeAgentQueryParams('Read files', Session.create(), {
        allowedTools: ['Read'],
        capabilities: [
          {
            kind: 'builtin',
            name: 'Bash',
            executionMode: 'runtime',
          },
        ],
      }),
    ).toMatchObject({
      options: {
        allowedTools: ['Read', 'Bash'],
      },
    });
  });

  it('materializes workspace Claude skills behind approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'prompttrail-claude-skill-'));
    try {
      const approvals: unknown[] = [];
      const [materialized] = await materializeClaudeAgentSkills({
        cwd,
        capabilities: [
          {
            kind: 'skill',
            name: 'Code Review',
            description: 'Review code',
            instructions: 'Prefer focused diffs.',
            materialize: 'workspace',
          },
        ],
        session: Session.create(),
        approvalHandler: async (request) => {
          approvals.push(request);
          return { type: 'approve' };
        },
      });

      expect(sanitizeClaudeSkillName('Code Review')).toBe('code-review');
      expect(getClaudeSkillNames([{ kind: 'skill', name: 'docs' }])).toEqual([
        'docs',
      ]);
      expect(materialized.name).toBe('code-review');
      expect(approvals[0]).toMatchObject({
        provider: 'claude-agent',
        action: 'materializeSkill',
        capability: 'Code Review',
        risk: 'write',
      });
      await expect(readFile(materialized.skillFile, 'utf8')).resolves.toBe(
        renderClaudeSkillMarkdown({
          kind: 'skill',
          name: 'Code Review',
          description: 'Review code',
          instructions: 'Prefer focused diffs.',
          materialize: 'workspace',
        }),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('requires approval before Claude skill materialization', async () => {
    await expect(
      materializeClaudeAgentSkills({
        cwd: '/tmp/prompttrail-denied',
        capabilities: [
          {
            kind: 'skill',
            name: 'docs',
            materialize: 'workspace',
          },
        ],
        session: Session.create(),
        approvalHandler: undefined,
      }),
    ).rejects.toThrow(
      'Claude Agent skill materialization requires an approvalHandler.',
    );
  });

  it('collects streamed SDK events into a runtime result', async () => {
    const seen: unknown[] = [];
    const result = await collectClaudeAgentTurnResult(
      stream([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hi' }] },
        },
        {
          type: 'result',
          id: 'result-1',
          status: 'completed',
          session_id: 'session-1',
          result: 'Final answer',
        },
      ]),
      (event) => {
        seen.push(event);
      },
    );

    expect(seen).toHaveLength(2);
    expect(result).toMatchObject({
      provider: 'claude-agent',
      status: 'completed',
      sessionId: 'session-1',
      finalAnswer: 'Final answer',
    });
    expect(result.events).toHaveLength(2);
  });
});

async function* stream(events: unknown[]) {
  for (const event of events) {
    yield event;
  }
}
