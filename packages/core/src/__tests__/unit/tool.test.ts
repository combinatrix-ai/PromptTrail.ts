import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Tool,
  aiSdkToolToPromptTrailTool,
  executePromptTrailTool,
  promptTrailToolToAiSdkTool,
  toAiSdkToolSet,
  toolResultToCallToolResult,
} from '../../tool';
import { createSession } from '../../session';

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
  });

  describe('ai-sdk adapters', () => {
    it('converts PromptTrail tools to ai-sdk tools with execution context', async () => {
      const session = createSession();
      const execute = vi.fn().mockResolvedValue({ result: 'success' });
      const promptTrailTool = Tool.create({
        name: 'search',
        description: 'Search',
        inputSchema: z.object({ query: z.string() }),
        execute,
      });

      const aiSdkTool = promptTrailToolToAiSdkTool(promptTrailTool, {
        session,
        provider: 'ai-sdk',
      }) as unknown as {
        execute: (input: unknown, raw: unknown) => Promise<unknown>;
      };

      await expect(
        aiSdkTool.execute({ query: 'docs' }, { toolCallId: 'call-1' }),
      ).resolves.toEqual({ result: 'success' });
      expect(execute).toHaveBeenCalledWith(
        { query: 'docs' },
        {
          session,
          provider: 'ai-sdk',
          capability: 'search',
          raw: { toolCallId: 'call-1' },
        },
      );
    });

    it('converts ai-sdk tools to PromptTrail tools', async () => {
      const aiSdkTool = promptTrailToolToAiSdkTool(
        Tool.create({
          name: 'double',
          description: 'Double a value',
          inputSchema: z.object({ value: z.number() }),
          execute: ({ value }) => ({ value: value * 2 }),
        }),
      );

      const promptTrailTool = aiSdkToolToPromptTrailTool('double', aiSdkTool);

      expect(promptTrailTool).toMatchObject({
        kind: 'tool',
        name: 'double',
        description: 'Double a value',
      });
      await expect(
        promptTrailTool.execute({ value: 3 }, { raw: { id: 'call-2' } }),
      ).resolves.toEqual({ value: 6 });
    });

    it('builds an ai-sdk tool set from mixed tool records', () => {
      const promptTrailTool = Tool.create({
        name: 'native',
        description: 'Native',
        inputSchema: z.object({ value: z.string() }),
        execute: ({ value }) => value,
      });
      const aiSdkTool = promptTrailToolToAiSdkTool(promptTrailTool);

      const toolSet = toAiSdkToolSet({
        native: promptTrailTool,
        existing: aiSdkTool,
      });

      expect(toolSet?.native).toBeDefined();
      expect(toolSet?.existing).toBe(aiSdkTool);
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
  });
});
