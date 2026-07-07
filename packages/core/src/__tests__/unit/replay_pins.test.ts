import { describe, expect, it } from 'vitest';
import {
  extractAnthropicReplayRequiredArtifacts,
  extractGeminiReplayRequiredArtifacts,
  extractOpenAIReplayRequiredArtifacts,
} from '../../replay_pins';

describe('replay-required artifact extraction', () => {
  it('extracts OpenAI encrypted reasoning and compaction items', () => {
    expect(
      extractOpenAIReplayRequiredArtifacts([
        {
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: 'encrypted',
          summary: [{ text: 'short' }],
        },
        { type: 'compaction', id: 'cmp_1', encrypted_content: 'compact' },
      ]),
    ).toEqual([
      {
        provider: 'openai',
        type: 'reasoning.encrypted_content',
        id: 'rs_1',
        artifact: {
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: 'encrypted',
        },
      },
      {
        provider: 'openai',
        type: 'compaction',
        id: 'cmp_1',
        artifact: {
          type: 'compaction',
          id: 'cmp_1',
          encrypted_content: 'compact',
        },
      },
    ]);
  });

  it('extracts Anthropic signed thinking and compaction blocks', () => {
    expect(
      extractAnthropicReplayRequiredArtifacts([
        { type: 'thinking', id: 'think-1', thinking: 'x', signature: 'sig' },
        { type: 'compaction', id: 'compact-1', content: 'opaque' },
      ]),
    ).toEqual([
      {
        provider: 'anthropic',
        type: 'thinking.signature',
        id: 'think-1',
        artifact: {
          type: 'thinking',
          id: 'think-1',
          thinking: 'x',
          signature: 'sig',
        },
      },
      {
        provider: 'anthropic',
        type: 'compaction',
        id: 'compact-1',
        artifact: {
          type: 'compaction',
          id: 'compact-1',
          content: 'opaque',
        },
      },
    ]);
  });

  it('extracts Gemini thought signatures from candidate parts', () => {
    expect(
      extractGeminiReplayRequiredArtifacts({
        candidates: [
          {
            content: {
              parts: [
                { text: 'visible' },
                { text: 'thought', thought: true, thoughtSignature: 'sig' },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      {
        provider: 'google',
        type: 'thoughtSignature',
        id: '0:1',
        artifact: {
          text: 'thought',
          thought: true,
          thoughtSignature: 'sig',
        },
      },
    ]);
  });
});
