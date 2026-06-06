import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { promptTrailToolToAiSdkTool, toAiSdkToolSet } from '../../ai_sdk_tools';
import { createSession } from '../../session';
import { Tool } from '../../tool';

describe('ai-sdk tool adapter internals', () => {
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
