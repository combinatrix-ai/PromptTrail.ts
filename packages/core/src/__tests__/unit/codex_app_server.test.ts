import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerWebSocketClient,
  collectCodexTurnResult,
  normalizeCodexRuntimeEvent,
  type CodexTurnEvent,
} from '../../codex_app_server';

describe('Codex App Server helpers', () => {
  it('normalizes known runtime events', () => {
    expect(
      normalizeCodexRuntimeEvent({
        method: 'item/started',
        params: {
          item: {
            id: 'item-1',
            type: 'agentMessage',
            status: 'inProgress',
            content: 'hello',
          },
        },
      }),
    ).toMatchObject({
      type: 'item.started',
      id: 'item-1',
      itemType: 'agentMessage',
      status: 'inProgress',
      preview: 'hello',
    });

    expect(
      normalizeCodexRuntimeEvent({
        method: 'item/agentMessage/delta',
        params: { turnId: 'turn-1', delta: 'hi' },
      }),
    ).toMatchObject({
      type: 'text.delta',
      id: 'turn-1',
      delta: 'hi',
    });

    expect(
      normalizeCodexRuntimeEvent({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed' } },
      }),
    ).toMatchObject({
      type: 'turn.completed',
      id: 'turn-1',
      status: 'completed',
    });
  });

  it('retains unknown runtime events as raw events', () => {
    expect(
      normalizeCodexRuntimeEvent({
        method: 'future/event',
        params: { value: 1 },
      }),
    ).toMatchObject({
      type: 'raw',
      id: 'future/event',
      method: 'future/event',
    });
  });

  it('collects async iterable events and calls onEvent', async () => {
    const onEvent = vi.fn();
    const result = await collectCodexTurnResult(
      eventStream([
        {
          method: 'item/completed',
          params: {
            turnId: 'turn-1',
            item: {
              id: 'item-1',
              type: 'agentMessage',
              content: 'Codex result',
            },
          },
        },
        {
          method: 'turn/completed',
          params: { turn: { id: 'turn-1', status: 'completed' } },
        },
      ]),
      { threadId: 'thread-1' },
      onEvent,
    );

    expect(result).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      finalAnswer: 'Codex result',
      items: [{ id: 'item-1' }],
    });
    expect(result.events).toHaveLength(2);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      type: 'item.completed',
      id: 'item-1',
    });
  });

  it('responds to inbound JSON-RPC requests over the WebSocket client', async () => {
    const sent: unknown[] = [];
    const client = new CodexAppServerWebSocketClient({
      url: 'ws://127.0.0.1:1',
      onRequest: async (request) => ({
        method: request.method,
        params: request.params,
      }),
    });
    (client as any).socket = {
      send: (message: string) => sent.push(JSON.parse(message)),
    };

    (client as any).handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'item/tool/call',
        params: { name: 'lookup', input: { query: 'docs' } },
      }),
    );

    await Promise.resolve();

    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 42,
        result: {
          method: 'item/tool/call',
          params: { name: 'lookup', input: { query: 'docs' } },
        },
      },
    ]);
  });

  it('returns JSON-RPC method errors for unhandled inbound requests', async () => {
    const sent: unknown[] = [];
    const client = new CodexAppServerWebSocketClient({
      url: 'ws://127.0.0.1:1',
    });
    (client as any).socket = {
      send: (message: string) => sent.push(JSON.parse(message)),
    };

    (client as any).handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'npm test' },
      }),
    );

    await Promise.resolve();

    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 'approval-1',
        error: {
          code: -32601,
          message: 'No handler for item/commandExecution/requestApproval',
        },
      },
    ]);
  });
});

async function* eventStream(events: CodexTurnEvent[]) {
  for (const event of events) {
    yield event;
  }
}
