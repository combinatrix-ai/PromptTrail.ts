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
