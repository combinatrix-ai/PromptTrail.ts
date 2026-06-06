import { describe, expect, it } from 'vitest';
import {
  applyAnthropicCacheControl,
  cacheHintToAnthropicCacheControl,
} from '../../cache';

describe('cache hints', () => {
  it('maps PromptTrail cache hints to Anthropic cache_control', () => {
    expect(cacheHintToAnthropicCacheControl(true)).toEqual({
      type: 'ephemeral',
      ttl: '5m',
    });
    expect(cacheHintToAnthropicCacheControl('1h')).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(cacheHintToAnthropicCacheControl('persist')).toBeUndefined();
  });

  it('applies Anthropic cache_control to string content', () => {
    expect(applyAnthropicCacheControl('System prompt', '5m')).toEqual([
      {
        type: 'text',
        text: 'System prompt',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    ]);
  });

  it('applies Anthropic cache_control to the last content block', () => {
    expect(
      applyAnthropicCacheControl(
        [
          { type: 'text', text: 'Inspect this.' },
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com' },
          },
        ],
        '1h',
      ),
    ).toEqual([
      { type: 'text', text: 'Inspect this.' },
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
  });
});
