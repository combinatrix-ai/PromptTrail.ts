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

describe('CodexTurn template', () => {
  it('should start a thread, run a turn, and append the final answer', async () => {
    const client = new FakeCodexClient();
    const agent = Agent.create().user('Implement this').codexTurn({
      client,
      cwd: '/repo',
      model: 'gpt-5.4-nano',
      sandboxPolicy: 'workspace-write',
    });

    const session = await agent.execute(Session.create());
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
    const agent = Agent.create()
      .user('Continue')
      .codexTurn({
        client,
        threadId: 'thread-existing',
        input: (session) => `Input: ${session.getLastMessage()?.content}`,
        retainMessages: false,
      });

    const session = await agent.execute(Session.create());

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
    await Agent.create()
      .codexTurn({
        client,
        threadId: (_session, context) => `thread-${context?.channel}`,
        input: (session, context) =>
          `${context?.channel}:${session.getLastMessage()?.content}`,
      })
      .execute(
        Session.create().addMessage({ type: 'user', content: 'hello' }),
        { context: { channel: 'claw-test' } },
      );

    expect(client.threadStarts).toHaveLength(0);
    expect(client.turnStarts[0]).toMatchObject({
      threadId: 'thread-claw-test',
      input: [{ type: 'text', text: 'claw-test:hello' }],
    });
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
    const session = await Agent.create()
      .codexTurn({ client, threadId: 'auto' })
      .execute(initialSession);

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
    const agent = Agent.create().user('Use docs').codexTurn({
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

    await expect(agent.execute(Session.create())).rejects.toThrow(
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
    const agent = Agent.create().user('Run commands').codexTurn({
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

    await expect(agent.execute(Session.create())).rejects.toThrow(
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
    const originalSession = await Agent.create()
      .user('Original')
      .codexTurn({ client: originalClient })
      .execute(Session.create());
    const previousAssistant = originalSession.getLastMessage();
    const client = new FakeCodexClient();
    const divergentSession = Session.create()
      .addMessage({ type: 'user', content: 'Edited' })
      .addMessage(previousAssistant!)
      .addMessage({ type: 'user', content: 'Continue' });

    await Agent.create()
      .codexTurn({ client, threadId: 'auto' })
      .execute(divergentSession);

    expect(client.threadStarts).toHaveLength(1);
    expect(client.turnStarts[0]).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Continue' }],
    });
  });

  it('should summarize retained runtime metadata by default', async () => {
    const client = new FakeCodexClient();
    const session = await Agent.create()
      .user('Summarize')
      .codexTurn({ client })
      .execute(Session.create());

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
    const session = await Agent.create()
      .user('Do not retain runtime artifacts')
      .codexTurn({ client, retain: 'none' })
      .execute(Session.create());

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

    await Agent.create()
      .user('Use the tool')
      .codexTurn({
        client,
        capabilities: [lookupTool],
      })
      .execute(Session.create());

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

    await Agent.create()
      .user('Review this')
      .codexTurn({
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
      .execute(Session.create());

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

    await Agent.create()
      .user('Review this')
      .codexTurn({
        client,
        capabilities: [
          {
            kind: 'skill',
            name: 'review',
          },
        ],
      })
      .execute(Session.create());

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

    await Agent.create()
      .user('Use MCP')
      .codexTurn({
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
      .execute(Session.create());

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
