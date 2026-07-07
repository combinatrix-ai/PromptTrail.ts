import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Tool,
  executePromptTrailTool,
  toolResultToCallToolResult,
} from '../../tool';

describe('Tool namespace', () => {
  describe('Tool.create', () => {
    it('creates a native PromptTrail tool', async () => {
      const testTool = Tool.create({
        name: 'upper',
        description: 'Test tool',
        inputSchema: z.object({
          input: z.string(),
        }),
        execute: async ({ input }, context) => {
          return {
            output: `${context.capability}:${input.toUpperCase()}`,
          };
        },
      });

      expect(testTool).toMatchObject({
        kind: 'tool',
        name: 'upper',
        description: 'Test tool',
      });
      expect(testTool.inputSchema.parse({ input: 'ok' })).toEqual({
        input: 'ok',
      });
      await expect(
        testTool.execute({ input: 'hello' }, { capability: testTool.name }),
      ).resolves.toEqual({ output: 'upper:HELLO' });
    });

    it('rejects the old parameters key', () => {
      expect(() =>
        Tool.create({
          name: 'echo',
          description: 'Test execution',
          parameters: z.object({
            message: z.string(),
            count: z.number(),
          }),
          execute: ({
            message,
            count,
          }: {
            message: string;
            count: number;
          }) => ({
            message,
            count,
          }),
        } as never),
      ).toThrow('Tool.create requires inputSchema.');
    });

    it('creates tools with inputSchema only', () => {
      const testTool = Tool.create({
        name: 'echo',
        description: 'Test execution',
        inputSchema: z.object({ message: z.string(), count: z.number() }),
        execute: ({ message, count }) => ({ message, count }),
      });

      expect(testTool.kind).toBe('tool');
      expect(testTool.name).toBe('echo');
      expect(testTool.inputSchema.parse({ message: 'x', count: 2 })).toEqual({
        message: 'x',
        count: 2,
      });
    });

    it('allows agent registration to supply the public tool name', () => {
      const testTool = Tool.create({
        description: 'Read data',
        inputSchema: z.object({ id: z.string() }),
        effect: { repeatable: true, kind: 'external-read' },
        execute: ({ id }) => ({ id }),
      });

      expect(testTool.name).toBe('tool');
      expect(testTool.effect).toEqual({
        repeatable: true,
        kind: 'external-read',
      });
      expect(testTool.metadata?.effect).toEqual({
        repeatable: true,
        kind: 'external-read',
      });
    });
  });

  describe('CallToolResult mapping', () => {
    it('maps string and object results to MCP-style tool results', () => {
      expect(toolResultToCallToolResult('done')).toEqual({
        content: [{ type: 'text', text: 'done' }],
      });

      expect(toolResultToCallToolResult({ ok: true })).toEqual({
        content: [{ type: 'json', json: { ok: true } }],
        structuredContent: { ok: true },
      });
    });

    it('normalizes thrown handler errors instead of propagating them', async () => {
      const failingTool = Tool.create({
        name: 'fail',
        description: 'Fail',
        inputSchema: z.object({ value: z.string() }),
        execute: () => {
          throw new Error('tool failed');
        },
      });

      await expect(
        executePromptTrailTool(failingTool, { value: 'x' }),
      ).resolves.toEqual({
        content: [{ type: 'text', text: 'tool failed' }],
        isError: true,
      });
    });

    it('runs approval handlers before executing tools', async () => {
      const approvedTool = Tool.create({
        name: 'approved',
        description: 'Approved',
        inputSchema: z.object({ value: z.string() }),
        approval: async (request) => {
          expect(request).toMatchObject({
            provider: 'openai',
            action: 'tool.execute',
            capability: 'approved',
            input: { value: 'x' },
          });
          return { type: 'approve' };
        },
        execute: ({ value }) => ({ value }),
      });

      await expect(
        executePromptTrailTool(
          approvedTool,
          { value: 'x' },
          { provider: 'openai' },
        ),
      ).resolves.toEqual({
        content: [{ type: 'json', json: { value: 'x' } }],
        structuredContent: { value: 'x' },
      });
    });

    it('uses the invoked capability name for approval and execution', async () => {
      const seen: string[] = [];
      const registeredTool = Tool.create({
        name: 'intrinsic',
        description: 'Registered under another key',
        inputSchema: z.object({ value: z.string() }),
        approval: async (request) => {
          seen.push(`approval:${request.capability}`);
          return { type: 'approve' };
        },
        execute: ({ value }, context) => {
          seen.push(`execute:${context.capability}`);
          return { value };
        },
      });

      await expect(
        executePromptTrailTool(
          registeredTool,
          { value: 'x' },
          { provider: 'openai', capability: 'registeredName' },
        ),
      ).resolves.toEqual({
        content: [{ type: 'json', json: { value: 'x' } }],
        structuredContent: { value: 'x' },
      });
      expect(seen).toEqual([
        'approval:registeredName',
        'execute:registeredName',
      ]);
    });

    it('returns tool errors when approval is denied', async () => {
      const deniedTool = Tool.create({
        name: 'denied',
        description: 'Denied',
        inputSchema: z.object({ value: z.string() }),
        approval: async () => ({ type: 'deny', reason: 'too risky' }),
        execute: () => ({ unreachable: true }),
      });

      await expect(
        executePromptTrailTool(deniedTool, { value: 'x' }),
      ).resolves.toEqual({
        content: [{ type: 'text', text: 'Tool execution denied: too risky' }],
        isError: true,
      });
    });

    it('requires a context approval handler for policy-based approvals', async () => {
      const needsApproval = Tool.create({
        name: 'needsApproval',
        description: 'Needs approval',
        inputSchema: z.object({ value: z.string() }),
        approval: 'always',
        execute: ({ value }) => ({ value }),
      });

      await expect(
        executePromptTrailTool(needsApproval, { value: 'x' }),
      ).resolves.toEqual({
        content: [
          {
            type: 'text',
            text: 'Tool execution denied: Tool "needsApproval" requires approval but no approval handler was provided.',
          },
        ],
        isError: true,
      });

      await expect(
        executePromptTrailTool(
          needsApproval,
          { value: 'x' },
          {
            provider: 'anthropic',
            approvalHandler: async () => ({ type: 'approve' }),
          },
        ),
      ).resolves.toEqual({
        content: [{ type: 'json', json: { value: 'x' } }],
        structuredContent: { value: 'x' },
      });
    });

    it('wraps keyed tool execution with resolved function keys', async () => {
      const events: string[] = [];
      const memo = new Map<string, unknown>();
      let executions = 0;
      const durableTool = Tool.create({
        name: 'charge',
        description: 'Charge',
        inputSchema: z.object({ id: z.string() }),
        effect: {
          idempotencyKey: (input) => `charge:${(input as { id: string }).id}`,
          retry: { maxAttempts: 2 },
        },
        execute: ({ id }, context) => {
          executions++;
          expect(context.effect).toEqual({
            idempotencyKey: expect.any(Function),
            retry: { maxAttempts: 2 },
          });
          expect(context.idempotencyKey).toBe(`charge:${id}`);
          return { id, executions };
        },
      });
      const durable = {
        async once<T>(name: string, dep: unknown, fn: () => T | Promise<T>) {
          const key = `${name}:${String(dep)}`;
          events.push(key);
          if (memo.has(key)) {
            return memo.get(key) as T;
          }
          const result = await fn();
          memo.set(key, result);
          return result;
        },
      };

      const first = await executePromptTrailTool(
        durableTool,
        { id: '1' },
        { durable },
      );
      const second = await executePromptTrailTool(
        durableTool,
        { id: '1' },
        { durable },
      );
      const third = await executePromptTrailTool(
        durableTool,
        { id: '2' },
        { durable },
      );

      expect(first.content).toEqual([
        { type: 'json', json: { id: '1', executions: 1 } },
      ]);
      expect(second.content).toEqual(first.content);
      expect(third.content).toEqual([
        { type: 'json', json: { id: '2', executions: 2 } },
      ]);
      expect(events).toEqual([
        'charge:charge:1',
        'charge:charge:1',
        'charge:charge:2',
      ]);
      expect(executions).toBe(2);
    });

    it('does not wrap repeatable tools in a durable boundary', async () => {
      const events: string[] = [];
      let executions = 0;
      const repeatableTool = Tool.create({
        name: 'lookup',
        description: 'Lookup',
        inputSchema: z.object({ id: z.string() }),
        effect: { repeatable: true },
        execute: ({ id }, context) => {
          executions++;
          expect(context.idempotencyKey).toBeUndefined();
          return { id, executions };
        },
      });

      const first = await executePromptTrailTool(
        repeatableTool,
        { id: '1' },
        {
          durable: {
            async once(name, dep, fn) {
              events.push(`${name}:${String(dep)}`);
              return fn();
            },
          },
        },
      );
      const second = await executePromptTrailTool(
        repeatableTool,
        { id: '1' },
        {
          durable: {
            async once(name, dep, fn) {
              events.push(`${name}:${String(dep)}`);
              return fn();
            },
          },
        },
      );

      expect(first.content).toEqual([
        { type: 'json', json: { id: '1', executions: 1 } },
      ]);
      expect(second.content).toEqual([
        { type: 'json', json: { id: '1', executions: 2 } },
      ]);
      expect(events).toEqual([]);
      expect(executions).toBe(2);
    });

    it('uses the invoked capability name for keyed durable boundaries', async () => {
      const events: string[] = [];
      const durableTool = Tool.create({
        description: 'Lookup',
        inputSchema: z.object({ id: z.string() }),
        effect: { idempotencyKey: 'lookup:1' },
        execute: ({ id }, context) => {
          expect(context.capability).toBe('lookup');
          expect(context.idempotencyKey).toBe('lookup:1');
          return { id };
        },
      });

      await executePromptTrailTool(
        durableTool,
        { id: '1' },
        {
          capability: 'lookup',
          durable: {
            async once(name, dep, fn) {
              events.push(`${name}:${String(dep)}`);
              return fn();
            },
          },
        },
      );

      expect(events).toEqual(['lookup:lookup:1']);
    });
  });
});
