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
      diff: 'diff --git a/file b/file',
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
});
