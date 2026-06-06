import type {
  CompactionOptions,
  LLMOptions,
  ThinkingOptions,
} from './llm_types';

export function mapOpenAIResponsesRequestOptions(
  options: Pick<
    LLMOptions,
    'cacheKey' | 'cacheRetention' | 'thinking' | 'compaction'
  >,
): Record<string, unknown> {
  return (
    omitUndefined({
      reasoning: mapOpenAIReasoning(options.thinking),
      prompt_cache_key: options.cacheKey,
      prompt_cache_retention: options.cacheRetention,
      context_management: mapOpenAICompaction(options.compaction),
    }) ?? {}
  );
}

export function mapOpenAIReasoning(
  thinking: ThinkingOptions | undefined,
): Record<string, unknown> | undefined {
  if (!thinking) {
    return undefined;
  }

  return omitUndefined({
    effort: thinking.effort,
    summary: thinking.summary ? 'auto' : undefined,
  });
}

export function mapAnthropicThinking(
  thinking: ThinkingOptions | undefined,
  toolChoice?: LLMOptions['toolChoice'],
): Record<string, unknown> | undefined {
  if (!thinking?.budgetTokens) {
    return undefined;
  }
  if (toolChoice === 'required') {
    throw new Error(
      'Anthropic thinking is only compatible with auto or none tool choice.',
    );
  }

  return {
    type: 'enabled',
    budget_tokens: thinking.budgetTokens,
  };
}

export function mapOpenAICompaction(
  compaction: CompactionOptions | undefined,
): Record<string, unknown> | undefined {
  if (compaction?.mode !== 'provider') {
    return undefined;
  }

  return omitUndefined({
    compact_threshold: compaction.threshold,
  });
}

export function mapAnthropicCompaction(
  compaction: CompactionOptions | undefined,
): Record<string, unknown> | undefined {
  if (compaction?.mode !== 'provider') {
    return undefined;
  }

  return {
    edits: [
      omitUndefined({
        type: 'compact_20260112',
        trigger:
          compaction.threshold === undefined
            ? undefined
            : {
                type: 'input_tokens',
                value: compaction.threshold,
              },
        pause_after_compaction: compaction.pauseAfterCompaction,
      })!,
    ],
  };
}

export function mapGeminiThinkingConfig(
  thinking: ThinkingOptions | undefined,
): Record<string, unknown> | undefined {
  if (!thinking) {
    return undefined;
  }

  return omitUndefined({
    thinkingBudget: thinking.budgetTokens,
    includeThoughts: thinking.summary,
  });
}

function omitUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const entries = Object.entries(value).filter(
    ([, entry]) => entry !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
