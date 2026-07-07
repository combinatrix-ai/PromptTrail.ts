import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  CodexAppServerLineJsonRpcClient,
  CodexAppServerWebSocketClient,
  collectCodexTurnResult,
  codexInboundRequestToApprovalRequest,
  createCodexRuntimeRequestHandler,
  createCodexToolRequestHandler,
  getCodexMcpServerConfig,
  getCodexRuntimeSkills,
  normalizeCodexRuntimeEvent,
  promptTrailMcpToCodexMcpServer,
  promptTrailSkillToCodexInputItem,
  promptTrailToolToCodexDynamicTool,
  resolveCodexRuntimeSkills,
  type CodexTurnEvent,
} from '../../codex_app_server';
import { createSession } from '../../session';
import { Tool, type PromptTrailTool } from '../../tool';
import { z } from 'zod';

describe('Codex App Server helpers', () => {
  it('sends JSON-RPC over line transports for stdio and unix clients', async () => {
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    const client = new CodexAppServerLineJsonRpcClient({
      readable: serverToClient,
      writable: clientToServer,
      timeoutMs: 1_000,
    });
    const writes: string[] = [];
    clientToServer.on('data', (chunk) => {
      writes.push(chunk.toString('utf8'));
    });

    const threadPromise = client.startThread({ cwd: '/repo' });
    await waitFor(() => writes.length > 0);
    expect(JSON.parse(writes.join('').trim())).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'thread/start',
      params: { cwd: '/repo' },
    });
    serverToClient.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { threadId: 'thread-1' } })}\n`,
    );
    await expect(threadPromise).resolves.toEqual({ threadId: 'thread-1' });

    writes.length = 0;
    const turnPromise = client.startTurn({
      threadId: 'thread-1',
      input: 'hello',
    });
    await waitFor(() => writes.length > 0);
    expect(JSON.parse(writes.join('').trim())).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      method: 'turn/start',
      params: { threadId: 'thread-1', input: 'hello' },
    });
    serverToClient.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          status: 'completed',
          finalAnswer: 'done',
        },
      })}\n`,
    );
    await expect(turnPromise).resolves.toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      finalAnswer: 'done',
    });

    writes.length = 0;
    const skillsPromise = client.listSkills();
    await waitFor(() => writes.length > 0);
    expect(JSON.parse(writes.join('').trim())).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'skills/list',
    });
    serverToClient.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        result: {
          skills: [{ name: 'review', id: 'skill-1' }],
        },
      })}\n`,
    );
    await expect(skillsPromise).resolves.toEqual({
      skills: [{ name: 'review', id: 'skill-1' }],
    });
    await client.close();
  });

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

  it('normalizes Codex command, diff, and approval runtime events from item payloads', () => {
    expect(
      normalizeCodexRuntimeEvent({
        method: 'item/commandExecution/completed',
        params: {
          item: {
            id: 'cmd-1',
            command: 'pnpm test',
            exitCode: 0,
            status: 'completed',
            stdout: '448 passed',
          },
        },
      }),
    ).toMatchObject({
      type: 'command',
      id: 'cmd-1',
      command: 'pnpm test',
      exitCode: 0,
      status: 'completed',
      outputPreview: '448 passed',
    });

    expect(
      normalizeCodexRuntimeEvent({
        method: 'item/fileChange/completed',
        params: {
          item: {
            id: 'diff-1',
            filePath: 'src/index.ts',
            added: 12,
            removed: 3,
            status: 'completed',
          },
        },
      }),
    ).toMatchObject({
      type: 'diff',
      id: 'diff-1',
      path: 'src/index.ts',
      added: 12,
      removed: 3,
      status: 'completed',
    });

    expect(
      normalizeCodexRuntimeEvent({
        id: 'approval-1',
        method: 'item/fileChange/approvalCompleted',
        params: { status: 'approved' },
      }),
    ).toMatchObject({
      type: 'approval.resolved',
      id: 'approval-1',
      action: 'fileChange',
      status: 'approved',
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
          params: {
            turn: {
              id: 'turn-1',
              status: 'completed',
              error: undefined,
            },
          },
        },
      ]),
      { threadId: 'thread-1' },
      onEvent,
    );

    expect(result).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
      error: undefined,
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

    expect(
      promptTrailToolToCodexDynamicTool(
        tool as PromptTrailTool<unknown, unknown>,
      ),
    ).toEqual({
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

  it('maps RuntimeSkill capabilities to Codex skill input items', () => {
    const skill = {
      kind: 'skill' as const,
      name: 'review',
      description: 'Review code',
      instructions: 'Prefer focused diffs.',
      path: '.codex/skills/review',
      materialize: 'workspace' as const,
    };

    expect(getCodexRuntimeSkills([skill])).toEqual([skill]);
    expect(promptTrailSkillToCodexInputItem(skill)).toEqual({
      type: 'skill',
      name: 'review',
      description: 'Review code',
      instructions: 'Prefer focused diffs.',
      skillId: undefined,
      path: '.codex/skills/review',
      materialize: 'workspace',
    });
  });

  it('resolves RuntimeSkill capabilities from Codex skills/list results', async () => {
    await expect(
      resolveCodexRuntimeSkills(
        {
          async listSkills() {
            return {
              skills: [
                {
                  name: 'review',
                  id: 'skill-review',
                  path: '.codex/skills/review',
                  description: 'Resolved review skill',
                  instructions: 'Resolved instructions',
                },
              ],
            };
          },
          async startThread() {
            return { threadId: 'thread-1' };
          },
          async startTurn() {
            return { finalAnswer: 'done' };
          },
        },
        [
          {
            kind: 'skill',
            name: 'review',
            description: 'Explicit description',
          },
        ],
      ),
    ).resolves.toEqual([
      {
        kind: 'skill',
        name: 'review',
        description: 'Explicit description',
        instructions: 'Resolved instructions',
        skillId: 'skill-review',
        path: '.codex/skills/review',
        metadata: {
          codexSkill: {
            name: 'review',
            id: 'skill-review',
            path: '.codex/skills/review',
            description: 'Resolved review skill',
            instructions: 'Resolved instructions',
          },
        },
      },
    ]);
  });

  it('maps MCP server capabilities to Codex runtime MCP config', () => {
    const server = {
      kind: 'mcp' as const,
      name: 'docs',
      transport: {
        kind: 'http' as const,
        url: 'https://mcp.example.com',
        headers: { authorization: 'Bearer test' },
      },
      tools: ['search', 'fetch'],
    };

    expect(promptTrailMcpToCodexMcpServer(server)).toEqual({
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { authorization: 'Bearer test' },
      tools: ['search', 'fetch'],
    });
    expect(
      getCodexMcpServerConfig([
        server,
        {
          kind: 'mcp',
          name: 'repo',
          transport: {
            kind: 'stdio',
            command: 'repo-mcp',
            args: ['--root', '/repo'],
            env: { NODE_ENV: 'test' },
          },
          tools: 'all',
        },
      ]),
    ).toEqual({
      docs: {
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { authorization: 'Bearer test' },
        tools: ['search', 'fetch'],
      },
      repo: {
        type: 'stdio',
        command: 'repo-mcp',
        args: ['--root', '/repo'],
        env: { NODE_ENV: 'test' },
        tools: 'all',
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
        channel: context.context?.channel,
      }),
    });
    const handler = createCodexToolRequestHandler(
      [tool] as PromptTrailTool<unknown, unknown>[],
      createSession(),
      undefined,
      undefined,
      { channel: 'claw-test' },
    );

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
          json: {
            query: 'capabilities',
            provider: 'codex',
            channel: 'claw-test',
          },
        },
      ],
      structuredContent: {
        query: 'capabilities',
        provider: 'codex',
        channel: 'claw-test',
      },
    });
  });

  it('uses approval handlers for Codex tool call requests', async () => {
    let executed = false;
    const tool = Tool.create({
      name: 'deleteRepo',
      description: 'Delete repo',
      inputSchema: z.object({ path: z.string() }),
      approval: 'always',
      execute: () => {
        executed = true;
        return { ok: true };
      },
    });
    const handler = createCodexToolRequestHandler(
      [tool] as PromptTrailTool<unknown, unknown>[],
      createSession(),
      undefined,
      async (request) => {
        expect(request).toMatchObject({
          provider: 'codex',
          action: 'tool.execute',
          capability: 'deleteRepo',
          input: { path: '/repo' },
        });
        return { type: 'deny', reason: 'too risky' };
      },
    );

    await expect(
      handler({
        id: 'call-approval',
        method: 'item/tool/call',
        params: { name: 'deleteRepo', input: { path: '/repo' } },
        raw: { method: 'item/tool/call' },
      }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'Tool execution denied: too risky' }],
      isError: true,
    });
    expect(executed).toBe(false);
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
    expect(
      codexInboundRequestToApprovalRequest({
        id: 'input-1',
        method: 'tool/requestUserInput',
        params: { question: 'Pick an option' },
        raw: { method: 'tool/requestUserInput' },
      }),
    ).toEqual({
      provider: 'codex',
      action: 'userInput',
      input: { question: 'Pick an option' },
      raw: { method: 'tool/requestUserInput' },
    });
    expect(
      normalizeCodexRuntimeEvent({
        id: 'input-2',
        method: 'tool/requestUserInput',
        params: { status: 'pending' },
      }),
    ).toMatchObject({
      type: 'approval.requested',
      id: 'input-2',
      action: 'userInput',
      status: 'pending',
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}
