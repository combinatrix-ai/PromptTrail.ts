import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildClaudeAgentQueryParams,
  collectClaudeAgentTurnResult,
  createClaudePromptTrailMcpServer,
  getClaudeAllowedToolNames,
  promptTrailToolToClaudeAgentToolDefinition,
} from '../../claude_agent';
import { Session } from '../../session';
import { Tool } from '../../tool';

describe('Claude Agent SDK adapter helpers', () => {
  it('maps PromptTrail tools to in-process MCP tool definitions', async () => {
    const session = Session.create();
    const lookupTool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }, context) => ({ query, provider: context.provider }),
    });
    const definition = promptTrailToolToClaudeAgentToolDefinition(
      lookupTool,
      session,
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
          json: { query: 'capabilities', provider: 'claude-agent' },
        },
      ],
      structuredContent: { query: 'capabilities', provider: 'claude-agent' },
    });
  });

  it('builds Claude Agent query params with MCP server and allowed tool names', () => {
    const lookupTool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }) => ({ query }),
    });

    expect(getClaudeAllowedToolNames([lookupTool])).toEqual([
      'mcp__prompttrail__lookup',
    ]);
    expect(
      createClaudePromptTrailMcpServer([lookupTool], Session.create()),
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
        capabilities: [lookupTool],
      }),
    ).toMatchObject({
      prompt: 'Use the tool',
      options: {
        cwd: '/repo',
        model: 'claude-haiku-4-5',
        allowedTools: ['Read', 'mcp__prompttrail__lookup'],
        mcpServers: {
          prompttrail: {
            name: 'prompttrail',
            tools: [{ name: 'lookup' }],
          },
        },
      },
    });
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
      (event) => seen.push(event),
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
