import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Session } from '../../session';
import { Source } from '../../source';
import { Tool } from '../../tool';

const openAIAvailable =
  process.env.PROMPTTRAIL_RUN_REAL_API_TESTS === '1' &&
  !!process.env.OPENAI_API_KEY;

describe.skipIf(!openAIAvailable)('OpenAI Responses native integration', () => {
  it('generates text and stores response metadata', async () => {
    const output = await Source.llm()
      .openai({ adapter: 'native' })
      .model('gpt-5.4-nano')
      .temperature(0)
      .maxTokens(32)
      .getContent(
        Session.create({
          messages: [
            {
              type: 'system',
              content: 'Reply with exactly the requested text.',
            },
            { type: 'user', content: 'Reply exactly: PROMPTTRAIL_NATIVE_OK' },
          ],
        }),
      );

    expect(output.content.trim()).toBe('PROMPTTRAIL_NATIVE_OK');
    expect(output.metadata?.openai).toMatchObject({
      provider: 'openai',
      api: 'responses',
    });
    expect((output.metadata?.openai as any).responseId).toBeTruthy();
  }, 60_000);

  it('executes PromptTrail tools through the native Responses loop', async () => {
    const lookup = Tool.create({
      name: 'lookup',
      description: 'Lookup a fixed test value',
      inputSchema: z.object({
        key: z.string(),
      }),
      execute: async ({ key }) => ({ value: `tool:${key}` }),
    });

    const output = await Source.llm()
      .openai({ adapter: 'native' })
      .model('gpt-5.4-nano')
      .temperature(0)
      .maxTokens(64)
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
  }, 60_000);
});
