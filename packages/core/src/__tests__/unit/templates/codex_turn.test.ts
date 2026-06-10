import { describe, expect, it } from 'vitest';
import type {
  CodexAppServerClient,
  CodexSkillListResult,
  CodexThreadStartParams,
  CodexThreadStartResult,
  CodexTurnStartParams,
} from '../../../codex_app_server';
import { Agent } from '../../../templates';
import { Session } from '../../../session';
import { Tool } from '../../../tool';
import { Middleware } from '../../../interceptors';
import { z } from 'zod';

class FakeCodexClient implements CodexAppServerClient {
  threadStarts: CodexThreadStartParams[] = [];
  turnStarts: CodexTurnStartParams[] = [];
  skillsResult?: CodexSkillListResult | unknown[];

  async listSkills(): Promise<CodexSkillListResult | unknown[]> {
    return this.skillsResult ?? { skills: [] };
  }

  async startThread(
    params: CodexThreadStartParams,
  ): Promise<CodexThreadStartResult> {
    this.threadStarts.push(params);
    return { threadId: 'thread-1' };
  }

  async startTurn(params: CodexTurnStartParams) {
    this.turnStarts.push(params);
    return {
      threadId: params.threadId,
      turnId: 'turn-1',
      status: 'completed',
      finalAnswer: 'Codex result',
      items: [
        {
          id: 'item-1',
          type: 'agentMessage',
          status: 'completed',
          content: 'x'.repeat(600),
        },
      ],
      events: [
        {
          type: 'text.delta',
          id: 'event-1',
          delta: 'y'.repeat(600),
          raw: { large: true },
        },
      ],
      diff: 'diff --git a/file b/file',
      commands: [{ command: 'npm test', output: 'z'.repeat(600) }],
      raw: { transport: 'fake' },
      plan: [{ step: 'inspect', status: 'completed' }],
    };
  }
}

class FailingCodexClient extends FakeCodexClient {
  async startTurn(params: CodexTurnStartParams) {
    this.turnStarts.push(params);
    throw new Error('codex unavailable');
  }
}

describe('CodexTurn template', () => {
  it('should start a thread, run a turn, and append the final answer', async () => {
    const client = new FakeCodexClient();
    const agent = Agent.quick().user('Implement this').codex({
      client,
      cwd: '/repo',
      model: 'gpt-5.4-nano',
      sandboxPolicy: 'workspace-write',
    });

    const session = await agent.execute({ session: Session.create() });
    const lastMessage = session.getLastMessage();

    expect(client.threadStarts).toEqual([
      {
        cwd: '/repo',
        model: 'gpt-5.4-nano',
        sandboxPolicy: 'workspace-write',
        approvalPolicy: undefined,
      },
    ]);
    expect(client.turnStarts[0]).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Implement this' }],
      cwd: '/repo',
      model: 'gpt-5.4-nano',
    });
    expect(lastMessage).toMatchObject({
      type: 'assistant',
      content: 'Codex result',
      attrs: {
        codex: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          status: 'completed',
          historyFingerprint: expect.stringMatching(/^fnv1a:/),
        },
      },
    });
  });

  it('should reuse an existing thread and allow metadata-only retention', async () => {
    const client = new FakeCodexClient();
    const agent = Agent.quick()
      .user('Continue')
      .codex({
        client,
        threadId: 'thread-existing',
        input: (session) => `Input: ${session.getLastMessage()?.content}`,
        retainMessages: false,
      });

    const session = await agent.execute({ session: Session.create() });

    expect(client.threadStarts).toHaveLength(0);
    expect(client.turnStarts[0]).toMatchObject({
      threadId: 'thread-existing',
      input: [{ type: 'text', text: 'Input: Continue' }],
    });
    expect(session.messages).toHaveLength(1);
    expect(session.getVar('codex' as never)).toMatchObject({
      finalAnswer: 'Codex result',
      threadId: 'thread-existing',
    });
  });

  it('passes direct execution context to input callbacks', async () => {
    const client = new FakeCodexClient();
    await Agent.quick()
      .codex({
        client,
        threadId: (_session, context) => `thread-${context?.channel}`,
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

    expect(client.threadStarts).toHaveLength(0);
    expect(client.turnStarts[0]).toMatchObject({
      threadId: 'thread-claw-test',
      input: [{ type: 'text', text: 'claw-test:hello' }],
    });
  });

  it('applies beforeModel session patches before resolving Codex input', async () => {
    const client = new FakeCodexClient();

    await Agent.quick()
      .use(
        Middleware.create({
          name: 'codexContext',
          beforeModel: () => ({
            session: { vars: { injected: 'from-before-model' } },
          }),
        }),
      )
      .codex({
        client,
        input: (session) => String(session.getVar('injected' as never)),
      })
      .execute({ session: Session.create() });

    expect(client.turnStarts[0]).toMatchObject({
      input: [{ type: 'text', text: 'from-before-model' }],
    });
  });

  it('applies afterModel result and session patches to Codex turns', async () => {
    const client = new FakeCodexClient();
    const session = await Agent.quick()
      .use(
        Middleware.create({
          name: 'codexResult',
          afterModel: ({ result }) => ({
            result: {
              ...(result as Record<string, unknown>),
              finalAnswer: 'rewritten by afterModel',
            },
            session: { vars: { afterModel: 'codex' } },
          }),
        }),
      )
      .codex({ client })
      .execute({ session: Session.create() });

    expect(session.getLastMessage()).toMatchObject({
      type: 'assistant',
      content: 'rewritten by afterModel',
    });
    expect(session.getVarsObject()).toEqual({ afterModel: 'codex' });
  });

  it('allows wrapModelCall to short-circuit Codex provider calls', async () => {
    const client = new FakeCodexClient();
    const events: string[] = [];
    const session = await Agent.quick()
      .observe((event) => {
        if (event.type.startsWith('model.')) {
          events.push(event.type);
        }
      })
      .use(
        Middleware.create({
          name: 'codexWrapper',
          wrapModelCall: () => ({
            session: { vars: { wrapped: 'codex' } },
            result: {
              threadId: 'thread-wrapped',
              turnId: 'turn-wrapped',
              status: 'completed',
              finalAnswer: 'wrapped Codex result',
            },
          }),
        }),
      )
      .codex({ client })
      .execute({ session: Session.create() });

    expect(client.threadStarts).toHaveLength(0);
    expect(client.turnStarts).toHaveLength(0);
    expect(events).toEqual([]);
    expect(session.getVarsObject()).toEqual({ wrapped: 'codex' });
    expect(session.getLastMessage()).toMatchObject({
      type: 'assistant',
      content: 'wrapped Codex result',
      attrs: {
        codex: {
          threadId: 'thread-wrapped',
          turnId: 'turn-wrapped',
        },
      },
    });
  });

  it('applies prepareModelInput as transient Codex input', async () => {
    const client = new FakeCodexClient();
    const session = await Agent.quick()
      .use(
        Middleware.create({
          name: 'codexPrepare',
          prepareModelInput: ({ request }) => ({
            request: {
              session: (request as { session: Session }).session.withVar(
                'transient',
                'codex',
              ),
            },
          }),
        }),
      )
      .codex({
        client,
        input: (session) => String(session.getVar('transient' as never)),
      })
      .execute({ session: Session.create() });

    expect(client.turnStarts[0]).toMatchObject({
      input: [{ type: 'text', text: 'codex' }],
    });
    expect(session.getVarsObject()).toEqual({});
  });

  it('rejects persistent session patches from Codex prepareModelInput', async () => {
    const client = new FakeCodexClient();

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
        .codex({ client })
        .execute({ session: Session.create() }),
    ).rejects.toThrow(
      'CodexTurn prepareModelInput cannot return persistent session patches.',
    );
    expect(client.turnStarts).toHaveLength(0);
  });

  it('emits model boundary events for direct execution observers', async () => {
    const client = new FakeCodexClient();
    const events: string[] = [];

    await Agent.quick()
      .observe((event) => {
        if (event.type.startsWith('model.')) {
          events.push(
            `${event.seq}:${event.type}:${event.stepId}:${event.idempotencyKey}`,
          );
        }
      })
      .user('Implement this')
      .codex({ client })
      .execute({ session: Session.create() });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(
      /^1:model\.started:codexTurn:direct-agent:.+:model:1:model\.started$/,
    );
    expect(events[1]).toMatch(
      /^2:model\.completed:codexTurn:direct-agent:.+:model:2:model\.completed$/,
    );
  });

  it('emits model.failed when a direct Codex turn fails', async () => {
    const client = new FailingCodexClient();
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
        .user('Implement this')
        .codex({ client })
        .execute({ session: Session.create() }),
    ).rejects.toThrow('codex unavailable');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatch(
      /^1:model\.started:codexTurn:direct-agent:.+:model:1:model\.started$/,
    );
    expect(events[1]).toMatch(
      /^2:model\.failed:codexTurn:direct-agent:.+:model:2:model\.failed$/,
    );
  });

  it('should derive an existing Codex thread when threadId is auto', async () => {
    const client = new FakeCodexClient();
    const initialSession = Session.create()
      .addMessage({
        type: 'assistant',
        content: 'Previous result',
        attrs: { codex: { threadId: 'thread-existing' } },
      })
      .addMessage({ type: 'user', content: 'Continue' });
    const session = await Agent.quick()
      .codex({ client, threadId: 'auto' })
      .execute({ session: initialSession });

    expect(client.threadStarts).toHaveLength(0);
    expect(client.turnStarts[0]).toMatchObject({
      threadId: 'thread-existing',
      input: [{ type: 'text', text: 'Continue' }],
    });
    expect(session.getLastMessage()?.attrs?.codex).toMatchObject({
      threadId: 'thread-existing',
    });
  });

  it('requires approval before configuring Codex MCP servers', async () => {
    const client = new FakeCodexClient();
    const approvals: unknown[] = [];
    const agent = Agent.quick()
      .user('Use docs')
      .codex({
        client,
        capabilities: [
          {
            kind: 'mcp',
            name: 'docs',
            transport: {
              kind: 'http',
              url: 'https://mcp.example.com',
            },
            tools: 'all',
            approval: 'always',
          },
        ],
        approvalHandler: async (request) => {
          approvals.push(request);
          return { type: 'deny', reason: 'no external servers' };
        },
      });

    await expect(agent.execute({ session: Session.create() })).rejects.toThrow(
      'Capability "docs" approval denied: no external servers',
    );

    expect(client.threadStarts).toHaveLength(0);
    expect(client.turnStarts).toHaveLength(0);
    expect(approvals[0]).toMatchObject({
      provider: 'codex',
      action: 'mcp.configure',
      capability: 'docs',
      risk: 'external',
      input: {
        transport: {
          kind: 'http',
          url: 'https://mcp.example.com',
        },
        tools: 'all',
      },
    });
  });

  it('requires approval before enabling Codex builtin runtime tools', async () => {
    const client = new FakeCodexClient();
    const approvals: unknown[] = [];
    const agent = Agent.quick()
      .user('Run commands')
      .codex({
        client,
        capabilities: [
          {
            kind: 'builtin',
            name: 'shell',
            provider: 'codex',
            executionMode: 'runtime',
            config: { sandboxPolicy: 'workspace-write' },
            approval: 'always',
          },
        ],
        approvalHandler: async (request) => {
          approvals.push(request);
          return { type: 'deny', reason: 'shell disabled' };
        },
      });

    await expect(agent.execute({ session: Session.create() })).rejects.toThrow(
      'Capability "shell" approval denied: shell disabled',
    );

    expect(client.threadStarts).toHaveLength(0);
    expect(client.turnStarts).toHaveLength(0);
    expect(approvals[0]).toMatchObject({
      provider: 'codex',
      action: 'builtin.enable',
      capability: 'shell',
      risk: 'execute',
      input: {
        executionMode: 'runtime',
        config: { sandboxPolicy: 'workspace-write' },
      },
    });
  });

  it('should start a new Codex thread when auto binding history diverged', async () => {
    const originalClient = new FakeCodexClient();
    const originalSession = await Agent.quick()
      .user('Original')
      .codex({ client: originalClient })
      .execute({ session: Session.create() });
    const previousAssistant = originalSession.getLastMessage();
    const client = new FakeCodexClient();
    const divergentSession = Session.create()
      .addMessage({ type: 'user', content: 'Edited' })
      .addMessage(previousAssistant!)
      .addMessage({ type: 'user', content: 'Continue' });

    await Agent.quick()
      .codex({ client, threadId: 'auto' })
      .execute({ session: divergentSession });

    expect(client.threadStarts).toHaveLength(1);
    expect(client.turnStarts[0]).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Continue' }],
    });
  });

  it('should summarize retained runtime metadata by default', async () => {
    const client = new FakeCodexClient();
    const session = await Agent.quick()
      .user('Summarize')
      .codex({ client })
      .execute({ session: Session.create() });

    const codex = session.getLastMessage()?.attrs?.codex as any;

    expect(codex.raw).toBeUndefined();
    expect(codex.items[0]).toEqual({
      type: 'agentMessage',
      id: 'item-1',
      status: 'completed',
      preview: 'x'.repeat(500),
      truncated: true,
      fullLength: 600,
    });
    expect(codex.events[0]).toMatchObject({
      type: 'text.delta',
      id: 'event-1',
      preview: 'y'.repeat(500),
      truncated: true,
      fullLength: 600,
    });
    expect(codex.diff).toEqual({
      preview: 'diff --git a/file b/file',
      truncated: undefined,
      fullLength: undefined,
    });
    expect(codex.commands[0]).toMatchObject({
      command: 'npm test',
      preview: 'z'.repeat(500),
      truncated: true,
      fullLength: 600,
    });
  });

  it('should retain only binding and status metadata when retain is none', async () => {
    const client = new FakeCodexClient();
    const session = await Agent.quick()
      .user('Do not retain runtime artifacts')
      .codex({ client, retain: 'none' })
      .execute({ session: Session.create() });

    const codex = session.getLastMessage()?.attrs?.codex as any;

    expect(codex).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
      finalAnswer: 'Codex result',
    });
    expect(codex.items).toBeUndefined();
    expect(codex.events).toBeUndefined();
    expect(codex.diff).toBeUndefined();
    expect(codex.commands).toBeUndefined();
    expect(codex.raw).toBeUndefined();
  });

  it('should register PromptTrail tools as Codex dynamic tools on new threads', async () => {
    const client = new FakeCodexClient();
    const lookupTool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: ({ query }) => ({ query }),
    });

    await Agent.quick()
      .user('Use the tool')
      .codex({
        client,
        capabilities: [lookupTool],
      })
      .execute({ session: Session.create() });

    expect(client.threadStarts[0].dynamicTools).toEqual([
      {
        name: 'lookup',
        description: 'Lookup docs',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ]);
  });

  it('should prepend RuntimeSkill input items on Codex turns', async () => {
    const client = new FakeCodexClient();

    await Agent.quick()
      .user('Review this')
      .codex({
        client,
        capabilities: [
          {
            kind: 'skill',
            name: 'review',
            description: 'Review code',
            instructions: 'Prefer focused diffs.',
          },
        ],
      })
      .execute({ session: Session.create() });

    expect(client.turnStarts[0].input).toEqual([
      {
        type: 'skill',
        name: 'review',
        description: 'Review code',
        instructions: 'Prefer focused diffs.',
        skillId: undefined,
        path: undefined,
        materialize: undefined,
      },
      { type: 'text', text: 'Review this' },
    ]);
  });

  it('should resolve RuntimeSkill input items through Codex skills/list', async () => {
    const client = new FakeCodexClient();
    client.skillsResult = {
      skills: [
        {
          name: 'review',
          id: 'skill-review',
          path: '.codex/skills/review',
          description: 'Review code',
          instructions: 'Prefer focused diffs.',
        },
      ],
    };

    await Agent.quick()
      .user('Review this')
      .codex({
        client,
        capabilities: [
          {
            kind: 'skill',
            name: 'review',
          },
        ],
      })
      .execute({ session: Session.create() });

    expect(client.turnStarts[0].input).toEqual([
      {
        type: 'skill',
        name: 'review',
        description: 'Review code',
        instructions: 'Prefer focused diffs.',
        skillId: 'skill-review',
        path: '.codex/skills/review',
        materialize: undefined,
      },
      { type: 'text', text: 'Review this' },
    ]);
  });

  it('should pass MCP server capabilities to Codex thread start', async () => {
    const client = new FakeCodexClient();

    await Agent.quick()
      .user('Use MCP')
      .codex({
        client,
        capabilities: [
          {
            kind: 'mcp',
            name: 'docs',
            transport: {
              kind: 'http',
              url: 'https://mcp.example.com',
              headers: { authorization: 'Bearer test' },
            },
            tools: ['search'],
          },
        ],
      })
      .execute({ session: Session.create() });

    expect(client.threadStarts[0].mcpServers).toEqual({
      docs: {
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { authorization: 'Bearer test' },
        tools: ['search'],
      },
    });
  });
});
