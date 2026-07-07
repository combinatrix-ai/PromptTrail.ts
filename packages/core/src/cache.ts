export type CacheHint = true | '5m' | '1h' | 'persist';

export function cacheHintToAnthropicCacheControl(
  hint: CacheHint | undefined,
): Record<string, unknown> | undefined {
  if (!hint || hint === 'persist') {
    return undefined;
  }

  return {
    type: 'ephemeral',
    ttl: hint === true ? '5m' : hint,
  };
}

export function applyAnthropicCacheControl(
  content: unknown,
  hint: CacheHint | undefined,
): unknown {
  const cacheControl = cacheHintToAnthropicCacheControl(hint);
  if (!cacheControl) {
    return content;
  }

  if (typeof content === 'string') {
    return [
      {
        type: 'text',
        text: content,
        cache_control: cacheControl,
      },
    ];
  }

  if (Array.isArray(content)) {
    const blocks = content.map((block) =>
      isRecord(block) ? { ...block } : block,
    );
    for (let index = blocks.length - 1; index >= 0; index--) {
      if (isRecord(blocks[index])) {
        blocks[index] = {
          ...blocks[index],
          cache_control: cacheControl,
        };
        return blocks;
      }
    }
  }

  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
