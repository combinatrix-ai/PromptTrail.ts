import { describe, expect, it, vi } from 'vitest';
import { tool as aiTool } from 'ai';
import { z } from 'zod';
import {
  aiSdkToolToPromptTrailTool,
  promptTrailToolToAiSdkTool,
  toAiSdkToolSet,
} from '../../ai_sdk_tools';
import { createSession } from '../../session';
import { executePromptTrailTool, Tool } from '../../tool';

describe('ai-sdk tool adapter internals', () => {
  it('converts executable ai-sdk Zod tools to PromptTrail tools', async () => {
    const execute = vi.fn().mockResolvedValue({ result: 'docs' });
    const aiSdkTool = aiTool({
      description: 'Search docs',
      parameters: z.object({ query: z.string() }),
      execute,
    });
    const promptTrailTool = aiSdkToolToPromptTrailTool('searchDocs', aiSdkTool);

    expect(promptTrailTool).toMatchObject({
      kind: 'tool',
      name: 'searchDocs',
      description: 'Search docs',
    });
    await expect(
      executePromptTrailTool(
        promptTrailTool,
        { query: 'capabilities' },
        { raw: { toolCallId: 'call-1' } },
      ),
    ).resolves.toEqual({
      content: [{ type: 'json', json: { result: 'docs' } }],
      structuredContent: { result: 'docs' },
    });
    expect(execute).toHaveBeenCalledWith(
      { query: 'capabilities' },
      {
        toolCallId: 'call-1',
        messages: [],
        abortSignal: undefined,
      },
    );
  });

  it('rejects ai-sdk provider-defined tools without executable Zod parameters', () => {
    expect(() =>
      aiSdkToolToPromptTrailTool('webSearch', {
        type: 'provider-defined',
        id: 'openai.web_search',
        args: {},
        parameters: {} as unknown as z.ZodTypeAny,
      }),
    ).toThrow(
      'ai-sdk tool "webSearch" must use a Zod parameters schema to convert to PromptTrailTool.',
    );

    expect(() =>
      aiSdkToolToPromptTrailTool(
        'deferred',
        aiTool({
          description: 'Deferred execution',
          parameters: z.object({ value: z.string() }),
        }),
      ),
    ).toThrow(
      'ai-sdk tool "deferred" must include execute to convert to PromptTrailTool.',
    );
  });

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
      context: { channel: 'claw-test' },
    }) as unknown as {
      execute: (input: unknown, raw: unknown) => Promise<unknown>;
    };

    await expect(
      aiSdkTool.execute({ query: 'docs' }, { toolCallId: 'call-1' }),
    ).resolves.toEqual({
      content: [{ type: 'json', json: { result: 'success' } }],
      structuredContent: { result: 'success' },
    });
    expect(execute).toHaveBeenCalledWith(
      { query: 'docs' },
      {
        session,
        provider: 'ai-sdk',
        context: { channel: 'claw-test' },
        capability: 'search',
        raw: { toolCallId: 'call-1' },
      },
    );
  });

  it('applies PromptTrail approval policy on the ai-sdk path', async () => {
    const promptTrailTool = Tool.create({
      name: 'deleteFile',
      description: 'Delete a file',
      inputSchema: z.object({ path: z.string() }),
      approval: 'always',
      execute: () => ({ deleted: true }),
    });

    const aiSdkTool = promptTrailToolToAiSdkTool(promptTrailTool, {
      provider: 'ai-sdk',
      approvalHandler: async () => ({ type: 'deny', reason: 'no writes' }),
    }) as unknown as {
      execute: (input: unknown, raw: unknown) => Promise<unknown>;
    };

    await expect(
      aiSdkTool.execute({ path: 'important.txt' }, { toolCallId: 'call-1' }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'Tool execution denied: no writes' }],
      isError: true,
    });
  });

  it('builds an ai-sdk tool set only from PromptTrail tools', () => {
    const promptTrailTool = Tool.create({
      name: 'native',
      description: 'Native',
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => value,
    });

    const toolSet = toAiSdkToolSet({
      native: promptTrailTool,
    });

    expect(toolSet?.native).toBeDefined();
  });
});
