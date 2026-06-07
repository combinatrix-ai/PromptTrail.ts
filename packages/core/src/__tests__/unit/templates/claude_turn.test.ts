import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ClaudeAgentClient,
  ClaudeAgentQueryParams,
} from '../../../claude_agent';
import { Session } from '../../../session';
import { Agent } from '../../../templates';

class FakeClaudeAgentClient implements ClaudeAgentClient {
  queries: ClaudeAgentQueryParams[] = [];

  async *query(params: ClaudeAgentQueryParams): AsyncIterable<unknown> {
    this.queries.push(params);
    yield {
      type: 'assistant',
      id: 'event-1',
      message: { content: [{ type: 'text', text: 'Working' }] },
    };
    yield {
      type: 'result',
      id: 'result-1',
      status: 'completed',
      session_id: 'session-1',
      result: 'Claude result',
    };
  }
}

describe('ClaudeTurn template', () => {
  it('runs a Claude Agent SDK turn and appends the final answer', async () => {
    const client = new FakeClaudeAgentClient();
    const session = await Agent.create()
      .user('Review this')
      .claudeTurn({
        client,
        cwd: '/repo',
        model: 'claude-haiku-4-5',
        allowedTools: ['Read'],
      })
      .execute(Session.create());
    const lastMessage = session.getLastMessage();

    expect(client.queries).toEqual([
      {
        prompt: 'Review this',
        options: {
          cwd: '/repo',
          model: 'claude-haiku-4-5',
          allowedTools: ['Read'],
          disallowedTools: undefined,
          permissionMode: undefined,
          settingSources: undefined,
          skills: undefined,
          resume: undefined,
          mcpServers: undefined,
        },
      },
    ]);
    expect(lastMessage).toMatchObject({
      type: 'assistant',
      content: 'Claude result',
      attrs: {
        claudeAgent: {
          provider: 'claude-agent',
          status: 'completed',
          sessionId: 'session-1',
          finalAnswer: 'Claude result',
          historyFingerprint: expect.stringMatching(/^fnv1a:/),
        },
      },
    });
    expect((lastMessage?.attrs?.claudeAgent as any).raw).toBeUndefined();
    expect((lastMessage?.attrs?.claudeAgent as any).events[1]).toMatchObject({
      type: 'result',
      id: 'result-1',
      status: 'completed',
      preview: 'Claude result',
    });
  });

  it('supports metadata-only retention', async () => {
    const client = new FakeClaudeAgentClient();
    const session = await Agent.create()
      .user('Continue')
      .claudeTurn({ client, retainMessages: false, retain: 'none' })
      .execute(Session.create());

    expect(session.messages).toHaveLength(1);
    expect(session.getVar('claudeAgent' as never)).toMatchObject({
      provider: 'claude-agent',
      status: 'completed',
      finalAnswer: 'Claude result',
      sessionId: 'session-1',
    });
  });

  it('passes direct execution context to input callbacks', async () => {
    const client = new FakeClaudeAgentClient();
    await Agent.create()
      .claudeTurn({
        client,
        sessionId: (_session, context) => `session-${context?.channel}`,
        input: (session, context) =>
          `${context?.channel}:${session.getLastMessage()?.content}`,
      })
      .execute(
        Session.create().addMessage({ type: 'user', content: 'hello' }),
        { context: { channel: 'claw-test' } },
      );

    expect(client.queries[0].prompt).toBe('claw-test:hello');
    expect(client.queries[0].options.resume).toBe('session-claw-test');
  });

  it('resumes a Claude Agent session when sessionId is auto', async () => {
    const originalClient = new FakeClaudeAgentClient();
    const originalSession = await Agent.create()
      .user('Original')
      .claudeTurn({ client: originalClient })
      .execute(Session.create());
    const client = new FakeClaudeAgentClient();

    await Agent.create()
      .claudeTurn({ client, sessionId: 'auto' })
      .execute(
        originalSession.addMessage({
          type: 'user',
          content: 'Continue',
        }),
      );

    expect(client.queries[0]).toMatchObject({
      prompt: 'Continue',
      options: {
        resume: 'session-1',
      },
    });
  });

  it('requires approval before configuring Claude Agent MCP servers', async () => {
    const client = new FakeClaudeAgentClient();
    const approvals: unknown[] = [];

    await expect(
      Agent.create()
        .user('Use docs')
        .claudeTurn({
          client,
          capabilities: [
            {
              kind: 'mcp',
              name: 'docs',
              transport: {
                kind: 'http',
                url: 'https://mcp.example.com',
              },
              tools: ['search'],
              approval: 'always',
            },
          ],
          approvalHandler: async (request) => {
            approvals.push(request);
            return { type: 'deny', reason: 'no external servers' };
          },
        })
        .execute(Session.create()),
    ).rejects.toThrow('Capability "docs" approval denied: no external servers');

    expect(client.queries).toHaveLength(0);
    expect(approvals[0]).toMatchObject({
      provider: 'claude-agent',
      action: 'mcp.configure',
      capability: 'docs',
      risk: 'external',
      input: {
        transport: {
          kind: 'http',
          url: 'https://mcp.example.com',
        },
        tools: ['search'],
      },
    });
  });

  it('requires approval before enabling Claude Agent built-in tools', async () => {
    const client = new FakeClaudeAgentClient();
    const approvals: unknown[] = [];

    await expect(
      Agent.create()
        .user('Run a command')
        .claudeTurn({
          client,
          capabilities: [
            {
              kind: 'builtin',
              name: 'Bash',
              executionMode: 'runtime',
              approval: 'always',
            },
          ],
          approvalHandler: async (request) => {
            approvals.push(request);
            return { type: 'deny', reason: 'no shell' };
          },
        })
        .execute(Session.create()),
    ).rejects.toThrow('Capability "Bash" approval denied: no shell');

    expect(client.queries).toHaveLength(0);
    expect(approvals[0]).toMatchObject({
      provider: 'claude-agent',
      action: 'builtin.enable',
      capability: 'Bash',
      risk: 'execute',
      input: {
        executionMode: 'runtime',
      },
    });
  });

  it('materializes workspace skills before querying the SDK', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'prompttrail-claude-turn-'));
    const client = new FakeClaudeAgentClient();
    try {
      await Agent.create()
        .user('Review this')
        .claudeTurn({
          client,
          cwd,
          capabilities: [
            {
              kind: 'skill',
              name: 'review',
              instructions: 'Prefer focused diffs.',
              materialize: 'workspace',
            },
          ],
          approvalHandler: async () => ({ type: 'approve' }),
        })
        .execute(Session.create());

      expect(client.queries[0].options.skills).toEqual(['review']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
