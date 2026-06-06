import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerWebSocketClient,
  collectCodexTurnResult,
  codexInboundRequestToApprovalRequest,
  createCodexRuntimeRequestHandler,
  createCodexToolRequestHandler,
  normalizeCodexRuntimeEvent,
  promptTrailToolToCodexDynamicTool,
  type CodexTurnEvent,
} from '../../codex_app_server';
import { createSession } from '../../session';
import { Tool } from '../../tool';
import { z } from 'zod';

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

  it('converts PromptTrail tools to Codex dynamic tool definitions', () => {
    const tool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().optional(),
      }),
      execute: ({ query }) => ({ query }),
    });

    expect(promptTrailToolToCodexDynamicTool(tool)).toEqual({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });
  });

  it('executes PromptTrail tools from Codex tool call requests', async () => {
    const tool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }, context) => ({
        query,
        provider: context.provider,
      }),
    });
    const handler = createCodexToolRequestHandler([tool], createSession());

    await expect(
      handler({
        id: 'call-1',
        method: 'item/tool/call',
        params: { name: 'lookup', input: { query: 'capabilities' } },
        raw: { method: 'item/tool/call' },
      }),
    ).resolves.toEqual({
      content: [
        {
          type: 'json',
          json: { query: 'capabilities', provider: 'codex' },
        },
      ],
      structuredContent: { query: 'capabilities', provider: 'codex' },
    });
  });

  it('maps Codex approval requests to the common approval handler', async () => {
    const handler = createCodexRuntimeRequestHandler({
      session: createSession(),
      approvalHandler: async (request) => {
        expect(request).toEqual({
          provider: 'codex',
          action: 'commandExecution',
          input: { command: 'npm test' },
          risk: 'execute',
          raw: { method: 'item/commandExecution/requestApproval' },
        });
        return { type: 'deny', reason: 'tests are disabled' };
      },
    });

    expect(
      codexInboundRequestToApprovalRequest({
        id: 'approval-1',
        method: 'item/fileChange/requestApproval',
        params: { path: 'src/index.ts' },
        raw: { method: 'item/fileChange/requestApproval' },
      }),
    ).toEqual({
      provider: 'codex',
      action: 'fileChange',
      input: { path: 'src/index.ts' },
      risk: 'write',
      raw: { method: 'item/fileChange/requestApproval' },
    });
    await expect(
      handler({
        id: 'approval-2',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'npm test' },
        raw: { method: 'item/commandExecution/requestApproval' },
      }),
    ).resolves.toEqual({
      decision: 'deny',
      reason: 'tests are disabled',
    });
  });
});

async function* eventStream(events: CodexTurnEvent[]) {
  for (const event of events) {
    yield event;
  }
}
