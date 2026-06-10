import { describe, expect, it } from 'vitest';
import { Agent } from '../../templates';

const codexAppServerUrl = process.env.CODEX_APP_SERVER_URL;
const codexAppServerAvailable =
  codexAppServerUrl !== undefined
    ? await canConnectToCodexAppServer(codexAppServerUrl)
    : false;

describe.skipIf(!codexAppServerAvailable)(
  'Codex App Server integration',
  () => {
    it('should run a Codex turn over WebSocket and append the final answer', async () => {
      const session = await Agent.quick()
        .user('Reply exactly: PROMPTTRAIL_CODEX_TURN_OK')
        .codex({
          transport: {
            kind: 'websocket',
            url: codexAppServerUrl!,
            timeoutMs: 90_000,
          },
          cwd: process.cwd(),
          model: 'gpt-5.4-nano',
          sandboxPolicy: { type: 'readOnly' },
          approvalPolicy: 'never',
        })
        .execute();

      const lastMessage = session.getLastMessage();

      expect(lastMessage?.type).toBe('assistant');
      expect(lastMessage?.content).toBe('PROMPTTRAIL_CODEX_TURN_OK');
      expect((lastMessage?.attrs as any)?.codex).toMatchObject({
        status: 'completed',
      });
      expect((lastMessage?.attrs as any)?.codex.threadId).toBeTruthy();
      expect((lastMessage?.attrs as any)?.codex.turnId).toBeTruthy();
    }, 120_000);

    it('should stream live runtime events through onEvent', async () => {
      const events: unknown[] = [];
      const session = await Agent.quick()
        .user('Reply exactly: PROMPTTRAIL_CODEX_EVENT_OK')
        .codex({
          transport: {
            kind: 'websocket',
            url: codexAppServerUrl!,
            timeoutMs: 90_000,
          },
          cwd: process.cwd(),
          model: 'gpt-5.4-nano',
          sandboxPolicy: { type: 'readOnly' },
          approvalPolicy: 'never',
          onEvent: (event) => {
            events.push(event);
          },
        })
        .execute();

      expect(session.getLastMessage()?.content).toBe(
        'PROMPTTRAIL_CODEX_EVENT_OK',
      );
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((event: any) => event.type === 'turn.completed')).toBe(
        true,
      );
    }, 120_000);
  },
);

async function canConnectToCodexAppServer(url: string): Promise<boolean> {
  if (!globalThis.WebSocket) {
    return false;
  }

  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 1_000);

    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      socket.close();
      resolve(true);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}
