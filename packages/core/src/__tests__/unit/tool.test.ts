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

    it('accepts the old parameters key while returning a native tool', () => {
      const testTool = Tool.create({
        name: 'echo',
        description: 'Test execution',
        parameters: z.object({
          message: z.string(),
          count: z.number(),
        }),
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
        activity: { kind: 'external-read' },
        execute: ({ id }) => ({ id }),
      });

      expect(testTool.name).toBe('tool');
      expect(testTool.activity).toEqual({ kind: 'external-read' });
      expect(testTool.metadata?.activity).toEqual({ kind: 'external-read' });
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

    it('wraps tool execution in a supplied durable activity boundary', async () => {
      const events: string[] = [];
      const durableTool = Tool.create({
        name: 'lookup',
        description: 'Lookup',
        inputSchema: z.object({ id: z.string() }),
        activity: { kind: 'external-read', retry: { maxAttempts: 2 } },
        execute: ({ id }, context) => {
          expect(context.activity).toEqual({
            kind: 'external-read',
            retry: { maxAttempts: 2 },
          });
          return { id };
        },
      });

      await expect(
        executePromptTrailTool(
          durableTool,
          { id: '1' },
          {
            durable: {
              async memo(_name, fn) {
                return fn();
              },
              async now() {
                return 0;
              },
              async randomId() {
                return 'id';
              },
              async activity(name, options, fn) {
                events.push(`${name}:${options.kind}`);
                return fn();
              },
            },
          },
        ),
      ).resolves.toEqual({
        content: [{ type: 'json', json: { id: '1' } }],
        structuredContent: { id: '1' },
      });
      expect(events).toEqual(['lookup:external-read']);
    });
  });
});
