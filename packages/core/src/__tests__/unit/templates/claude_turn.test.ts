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
import { Middleware } from '../../../interceptors';

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

class FailingClaudeAgentClient implements ClaudeAgentClient {
  queries: ClaudeAgentQueryParams[] = [];

  async *query(params: ClaudeAgentQueryParams): AsyncIterable<unknown> {
    this.queries.push(params);
    yield await Promise.reject(new Error('claude unavailable'));
  }
}

describe('ClaudeTurn template', () => {
  it('runs a Claude Agent SDK turn and appends the final answer', async () => {
    const client = new FakeClaudeAgentClient();
    const session = await Agent.quick()
      .user('Review this')
      .claudeTurn({
        client,
        cwd: '/repo',
        model: 'claude-haiku-4-5',
        allowedTools: ['Read'],
      })
      .execute({ session: Session.create() });
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
    const session = await Agent.quick()
      .user('Continue')
      .claudeTurn({ client, retainMessages: false, retain: 'none' })
      .execute({ session: Session.create() });

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
    await Agent.quick()
      .claudeTurn({
        client,
        sessionId: (_session, context) => `session-${context?.channel}`,
        input: (session, context) =>
          `${context?.channel}:${session.getLastMessage()?.content}`,
      })
      .execute({
        session: Session.create().addMessage({
          type: 'user',
          content: 'hello',
        }),
        context: { channel: 'claw-test' },
      });

    expect(client.queries[0].prompt).toBe('claw-test:hello');
    expect(client.queries[0].options.resume).toBe('session-claw-test');
  });

  it('applies beforeModel session patches before resolving Claude input', async () => {
    const client = new FakeClaudeAgentClient();

    await Agent.quick()
      .use(
        Middleware.create({
          name: 'claudeContext',
          beforeModel: () => ({
            session: { vars: { injected: 'from-before-model' } },
          }),
        }),
      )
      .claudeTurn({
        client,
        input: (session) => String(session.getVar('injected' as never)),
      })
      .execute({ session: Session.create() });

    expect(client.queries[0].prompt).toBe('from-before-model');
  });

  it('applies afterModel result and session patches to Claude turns', async () => {
    const client = new FakeClaudeAgentClient();
    const session = await Agent.quick()
      .use(
        Middleware.create({
          name: 'claudeResult',
          afterModel: ({ result }) => ({
            result: {
              ...(result as Record<string, unknown>),
              finalAnswer: 'rewritten by afterModel',
            },
            session: { vars: { afterModel: 'claude' } },
          }),
        }),
      )
      .claudeTurn({ client })
      .execute({ session: Session.create() });

    expect(session.getLastMessage()).toMatchObject({
      type: 'assistant',
      content: 'rewritten by afterModel',
    });
    expect(session.getVarsObject()).toEqual({ afterModel: 'claude' });
  });

  it('allows wrapModelCall to short-circuit Claude provider calls', async () => {
    const client = new FakeClaudeAgentClient();
    const events: string[] = [];
    const session = await Agent.quick()
      .observe((event) => {
        if (event.type.startsWith('model.')) {
          events.push(event.type);
        }
      })
      .use(
        Middleware.create({
          name: 'claudeWrapper',
          wrapModelCall: () => ({
            session: { vars: { wrapped: 'claude' } },
            result: {
              provider: 'claude-agent',
              status: 'completed',
              finalAnswer: 'wrapped Claude result',
              events: [],
              raw: [],
              sessionId: 'session-wrapped',
            },
          }),
        }),
      )
      .claudeTurn({ client })
      .execute({ session: Session.create() });

    expect(client.queries).toHaveLength(0);
    expect(events).toEqual([]);
    expect(session.getVarsObject()).toEqual({ wrapped: 'claude' });
    expect(session.getLastMessage()).toMatchObject({
      type: 'assistant',
      content: 'wrapped Claude result',
      attrs: {
        claudeAgent: {
          sessionId: 'session-wrapped',
          provider: 'claude-agent',
        },
      },
    });
  });

  it('applies prepareModelInput as transient Claude input', async () => {
    const client = new FakeClaudeAgentClient();
    const session = await Agent.quick()
      .use(
        Middleware.create({
          name: 'claudePrepare',
          prepareModelInput: ({ request }) => ({
            request: {
              session: (request as { session: Session }).session.withVar(
                'transient',
                'claude',
              ),
            },
          }),
        }),
      )
      .claudeTurn({
        client,
        input: (session) => String(session.getVar('transient' as never)),
      })
      .execute({ session: Session.create() });

    expect(client.queries[0].prompt).toBe('claude');
    expect(session.getVarsObject()).toEqual({});
  });

  it('rejects persistent session patches from Claude prepareModelInput', async () => {
    const client = new FakeClaudeAgentClient();

    await expect(
      Agent.quick()
        .use(
          Middleware.create({
            name: 'badPrepare',
            prepareModelInput: () => ({
              session: { vars: { persistent: true } },
            }),
          }),
        )
        .claudeTurn({ client })
        .execute({ session: Session.create() }),
    ).rejects.toThrow(
      'ClaudeTurn prepareModelInput cannot return persistent session patches.',
    );
    expect(client.queries).toHaveLength(0);
  });

  it('emits model boundary events for direct execution observers', async () => {
    const client = new FakeClaudeAgentClient();
    const events: string[] = [];

    await Agent.quick()
      .observe((event) => {
        if (event.type.startsWith('model.')) {
          events.push(
            `${event.seq}:${event.type}:${event.stepId}:${event.idempotencyKey}`,
          );
        }
      })
      .user('Review this')
      .claudeTurn({ client })
      .execute({ session: Session.create() });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(
      /^1:model\.started:claudeTurn:direct-agent:.+:model:1:model\.started$/,
    );
    expect(events[1]).toMatch(
      /^2:model\.completed:claudeTurn:direct-agent:.+:model:2:model\.completed$/,
    );
  });

  it('emits model.failed when a direct Claude turn fails', async () => {
    const client = new FailingClaudeAgentClient();
    const events: string[] = [];

    await expect(
      Agent.quick()
        .observe((event) => {
          if (event.type.startsWith('model.')) {
            events.push(
              `${event.seq}:${event.type}:${event.stepId}:${event.idempotencyKey}`,
            );
          }
        })
        .user('Review this')
        .claudeTurn({ client })
        .execute({ session: Session.create() }),
    ).rejects.toThrow('claude unavailable');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(
      /^1:model\.started:claudeTurn:direct-agent:.+:model:1:model\.started$/,
    );
    expect(events[1]).toMatch(
      /^2:model\.failed:claudeTurn:direct-agent:.+:model:2:model\.failed$/,
    );
  });

  it('resumes a Claude Agent session when sessionId is auto', async () => {
    const originalClient = new FakeClaudeAgentClient();
    const originalSession = await Agent.quick()
      .user('Original')
      .claudeTurn({ client: originalClient })
      .execute({ session: Session.create() });
    const client = new FakeClaudeAgentClient();

    await Agent.quick()
      .claudeTurn({ client, sessionId: 'auto' })
      .execute({
        session: originalSession.addMessage({
          type: 'user',
          content: 'Continue',
        }),
      });

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
      Agent.quick()
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
        .execute({ session: Session.create() }),
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
      Agent.quick()
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
        .execute({ session: Session.create() }),
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
      await Agent.quick()
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
        .execute({ session: Session.create() });

      expect(client.queries[0].options.skills).toEqual(['review']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
