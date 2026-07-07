import { describe, expect, it } from 'vitest';
import {
  mapAnthropicCompaction,
  mapAnthropicThinking,
  mapOpenAICompaction,
  mapGeminiThinkingConfig,
  mapOpenAIReasoning,
  mapOpenAIResponsesRequestOptions,
} from '../../generation_options';

describe('provider generation option mapping', () => {
  it('maps common thinking and cache hints to OpenAI Responses request fields', () => {
    expect(
      mapOpenAIResponsesRequestOptions({
        thinking: { effort: 'low', summary: true },
        cacheKey: 'stable-prefix',
        cacheRetention: '24h',
        compaction: { mode: 'provider', threshold: 0.8 },
      }),
    ).toEqual({
      reasoning: { effort: 'low', summary: 'auto' },
      prompt_cache_key: 'stable-prefix',
      prompt_cache_retention: '24h',
      context_management: { compact_threshold: 0.8 },
    });
  });

  it('omits unset OpenAI thinking fields', () => {
    expect(mapOpenAIReasoning({ budgetTokens: 4096 })).toBeUndefined();
    expect(mapOpenAIResponsesRequestOptions({})).toEqual({});
  });

  it('maps budgeted thinking to Anthropic extended thinking', () => {
    expect(
      mapAnthropicThinking(
        { effort: 'high', budgetTokens: 4096, summary: true },
        'auto',
      ),
    ).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
    });
  });

  it('rejects Anthropic thinking with required tool choice', () => {
    expect(() =>
      mapAnthropicThinking({ budgetTokens: 4096 }, 'required'),
    ).toThrow(
      'Anthropic thinking is only compatible with auto or none tool choice.',
    );
  });

  it('maps common thinking to Gemini thinkingConfig', () => {
    expect(
      mapGeminiThinkingConfig({ budgetTokens: 2048, summary: true }),
    ).toEqual({
      thinkingBudget: 2048,
      includeThoughts: true,
    });
  });

  it('maps provider compaction only when explicitly enabled', () => {
    expect(
      mapOpenAICompaction({ mode: 'local', threshold: 0.8 }),
    ).toBeUndefined();
    expect(mapOpenAICompaction({ mode: 'provider', threshold: 0.8 })).toEqual({
      compact_threshold: 0.8,
    });
    expect(
      mapAnthropicCompaction({
        mode: 'provider',
        threshold: 12000,
        pauseAfterCompaction: true,
      }),
    ).toEqual({
      edits: [
        {
          type: 'compact_20260112',
          trigger: { type: 'input_tokens', value: 12000 },
          pause_after_compaction: true,
        },
      ],
    });
  });
});
