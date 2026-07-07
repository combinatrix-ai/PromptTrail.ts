import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Session } from '../../session';
import { Source } from '../../source';
import { Tool } from '../../tool';

const googleAvailable =
  process.env.PROMPTTRAIL_RUN_REAL_API_TESTS === '1' &&
  !!process.env.GOOGLE_API_KEY;
const googleNativeConfig = {
  adapter: 'native' as const,
  retry: {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 75_000,
  },
};
const googleNativeTimeout = 420_000;

describe.skipIf(!googleAvailable)('Google Gemini native integration', () => {
  it(
    'generates text and stores response metadata',
    async () => {
      const output = await Source.llm({ thinking: { budgetTokens: 0 } })
        .google(googleNativeConfig)
        .model('gemini-3.1-flash-lite')
        .temperature(0)
        .maxTokens(128)
        .getContent(
          Session.create({
            messages: [
              {
                type: 'system',
                content: 'Reply with exactly the requested text.',
              },
              {
                type: 'user',
                content: 'Reply exactly: PROMPTTRAIL_GEMINI_NATIVE_OK',
              },
            ],
          }),
        );

      expect(output.content.trim()).toBe('PROMPTTRAIL_GEMINI_NATIVE_OK');
      expect(output.metadata?.google).toMatchObject({
        provider: 'google',
        api: 'gemini',
      });
    },
    googleNativeTimeout,
  );

  it(
    'executes PromptTrail tools through the native Gemini loop',
    async () => {
      const lookup = Tool.create({
        name: 'lookup',
        description: 'Lookup a fixed test value',
        inputSchema: z.object({ key: z.string() }),
        execute: async ({ key }) => ({ value: `tool:${key}` }),
      });

      const output = await Source.llm({ thinking: { budgetTokens: 0 } })
        .google(googleNativeConfig)
        .model('gemini-3.1-flash-lite')
        .temperature(0)
        .maxTokens(128)
        .withCapabilities([lookup])
        .toolChoice('required')
        .getContent(
          Session.create({
            messages: [
              {
                type: 'user',
                content:
                  'Call the lookup tool with key "native" and then reply exactly with the returned value.',
              },
            ],
          }),
        );

      expect(output.content.trim()).toBe('tool:native');
    },
    googleNativeTimeout,
  );

  it(
    'generates structured output through native responseJsonSchema',
    async () => {
      const output = await Source.llm({ thinking: { budgetTokens: 0 } })
        .google(googleNativeConfig)
        .model('gemini-3.1-flash-lite')
        .temperature(0)
        .maxTokens(128)
        .withSchema(
          z.object({
            status: z.literal('ok'),
            count: z.number(),
          }),
          { mode: 'native' },
        )
        .getContent(
          Session.create({
            messages: [
              {
                type: 'user',
                content: 'Return status ok and count 3.',
              },
            ],
          }),
        );

      expect(output.structuredOutput).toEqual({ status: 'ok', count: 3 });
    },
    googleNativeTimeout,
  );

  it(
    'runs a tool loop before native responseJsonSchema output',
    async () => {
      const lookup = Tool.create({
        name: 'lookup',
        description: 'Lookup a fixed test value',
        inputSchema: z.object({ key: z.string() }),
        execute: async ({ key }) => ({ value: `tool:${key}` }),
      });

      const output = await Source.llm({ thinking: { budgetTokens: 0 } })
        .google(googleNativeConfig)
        .model('gemini-3.1-flash-lite')
        .temperature(0)
        .maxTokens(256)
        .withCapabilities([lookup])
        .toolChoice('required')
        .withSchema(
          z.object({
            status: z.literal('ok'),
            value: z.literal('tool:schema'),
          }),
          { mode: 'native' },
        )
        .getContent(
          Session.create({
            messages: [
              {
                type: 'user',
                content:
                  'Call the lookup tool with key "schema". Then return status ok and the exact returned value.',
              },
            ],
          }),
        );

      expect(output.structuredOutput).toEqual({
        status: 'ok',
        value: 'tool:schema',
      });
    },
    googleNativeTimeout,
  );

  it(
    'ignores sub-threshold cache hints before calling Gemini',
    async () => {
      const output = await Source.llm({
        cacheKey: 'prompttrail-short-gemini-prefix',
        thinking: { budgetTokens: 0 },
      })
        .google(googleNativeConfig)
        .model('gemini-3.1-flash-lite')
        .temperature(0)
        .maxTokens(128)
        .getContent(
          Session.create({
            messages: [
              {
                type: 'system',
                content: 'Reply with exactly the requested text.',
              },
              {
                type: 'user',
                content: 'Short cached prefix.',
                cache: true,
              },
              {
                type: 'user',
                content: 'Reply exactly: PROMPTTRAIL_GEMINI_CACHE_NOOP_OK',
              },
            ],
          }),
        );

      expect(output.content.trim()).toBe('PROMPTTRAIL_GEMINI_CACHE_NOOP_OK');
      expect(output.metadata?.google).toMatchObject({
        provider: 'google',
        api: 'gemini',
      });
      expect(output.metadata?.google?.cachedContent).toBeUndefined();
      expect(output.metadata?.google?.cachedContentBinding).toBeUndefined();
    },
    googleNativeTimeout,
  );
});
