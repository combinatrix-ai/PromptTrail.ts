import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilitySet } from '../../capabilities';
import { Session } from '../../session';
import { Source } from '../../source';
import { Tool } from '../../tool';

const anthropicAvailable =
  process.env.PROMPTTRAIL_RUN_REAL_API_TESTS === '1' &&
  !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!anthropicAvailable)(
  'Anthropic Messages native integration',
  () => {
    it('generates text and stores response metadata', async () => {
      const output = await Source.llm()
        .anthropic({ adapter: 'native' })
        .model('claude-haiku-4-5')
        .temperature(0)
        .maxTokens(32)
        .getContent(
          Session.create({
            messages: [
              {
                type: 'system',
                content: 'Reply with exactly the requested text.',
              },
              {
                type: 'user',
                content: 'Reply exactly: PROMPTTRAIL_ANTHROPIC_NATIVE_OK',
              },
            ],
          }),
        );

      expect(output.content.trim()).toBe('PROMPTTRAIL_ANTHROPIC_NATIVE_OK');
      expect(output.metadata?.anthropic).toMatchObject({
        provider: 'anthropic',
        api: 'messages',
      });
    }, 60_000);

    it('executes PromptTrail tools through the native Messages loop', async () => {
      const lookup = Tool.create({
        name: 'lookup',
        description: 'Lookup a fixed test value',
        inputSchema: z.object({ key: z.string() }),
        execute: async ({ key }) => ({ value: `tool:${key}` }),
      });

      const output = await Source.llm()
        .anthropic({ adapter: 'native' })
        .model('claude-haiku-4-5')
        .temperature(0)
        .maxTokens(64)
        .withCapabilities([lookup] as CapabilitySet)
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
    }, 60_000);

    it('generates structured output through the native forced-tool path', async () => {
      const output = await Source.llm()
        .anthropic({ adapter: 'native' })
        .model('claude-haiku-4-5')
        .temperature(0)
        .maxTokens(64)
        .withSchema(
          z.object({
            status: z.literal('ok'),
            count: z.number(),
          }),
          { mode: 'tool', functionName: 'StructuredResult' },
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
    }, 60_000);

    it('runs a tool loop before native forced-tool structured output', async () => {
      const lookup = Tool.create({
        name: 'lookup',
        description: 'Lookup a fixed test value',
        inputSchema: z.object({ key: z.string() }),
        execute: async ({ key }) => ({ value: `tool:${key}` }),
      });

      const output = await Source.llm()
        .anthropic({ adapter: 'native' })
        .model('claude-haiku-4-5')
        .temperature(0)
        .maxTokens(128)
        .withCapabilities([lookup] as CapabilitySet)
        .toolChoice('required')
        .withSchema(
          z.object({
            status: z.literal('ok'),
            value: z.string(),
          }),
          { mode: 'tool', functionName: 'StructuredResult' },
        )
        .getContent(
          Session.create({
            messages: [
              {
                type: 'user',
                content:
                  'First call lookup with key "schema-loop". Then return structured output with status ok and value set to the lookup result value.',
              },
            ],
          }),
        );

      expect(output.structuredOutput).toEqual({
        status: 'ok',
        value: 'tool:schema-loop',
      });
    }, 60_000);

    it('generates structured output through native output_config', async () => {
      const output = await Source.llm()
        .anthropic({ adapter: 'native' })
        .model('claude-haiku-4-5')
        .temperature(0)
        .maxTokens(64)
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
    }, 60_000);
  },
);
