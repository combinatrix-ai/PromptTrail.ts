import { describe, expect, it } from 'vitest';
import type {
  CodexAppServerClient,
  CodexThreadStartParams,
  CodexThreadStartResult,
  CodexTurnStartParams,
} from '../../../codex_app_server';
import { Agent } from '../../../templates';
import { Session } from '../../../session';

class FakeCodexClient implements CodexAppServerClient {
  threadStarts: CodexThreadStartParams[] = [];
  turnStarts: CodexTurnStartParams[] = [];

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
      content: 'x'.repeat(500),
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
});
