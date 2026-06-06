import { describe, expect, it } from 'vitest';
import {
  mapAnthropicThinking,
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
      }),
    ).toEqual({
      reasoning: { effort: 'low', summary: 'auto' },
      prompt_cache_key: 'stable-prefix',
      prompt_cache_retention: '24h',
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
});
