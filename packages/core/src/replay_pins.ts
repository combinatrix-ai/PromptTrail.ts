export interface ReplayRequiredArtifact {
  provider: 'openai' | 'anthropic' | 'google';
  type: string;
  id?: string;
  artifact: unknown;
}

export function extractOpenAIReplayRequiredArtifacts(
  output: unknown[] | undefined,
): ReplayRequiredArtifact[] {
  return (output ?? []).flatMap((item) => {
    const record = asRecord(item);
    if (!record) {
      return [];
    }
    if (
      record.type === 'reasoning' &&
      typeof record.encrypted_content === 'string'
    ) {
      return [
        {
          provider: 'openai' as const,
          type: 'reasoning.encrypted_content',
          id: stringValue(record.id),
          artifact: {
            type: record.type,
            id: record.id,
            encrypted_content: record.encrypted_content,
          },
        },
      ];
    }
    if (record.type === 'compaction' || record.type === 'compact') {
      return [
        {
          provider: 'openai' as const,
          type: 'compaction',
          id: stringValue(record.id),
          artifact: record,
        },
      ];
    }
    return [];
  });
}

export function extractAnthropicReplayRequiredArtifacts(
  content: unknown[] | undefined,
): ReplayRequiredArtifact[] {
  return (content ?? []).flatMap((block) => {
    const record = asRecord(block);
    if (!record) {
      return [];
    }
    if (
      (record.type === 'thinking' || record.type === 'redacted_thinking') &&
      typeof record.signature === 'string'
    ) {
      return [
        {
          provider: 'anthropic' as const,
          type: `${record.type}.signature`,
          id: stringValue(record.id),
          artifact: record,
        },
      ];
    }
    if (record.type === 'compaction') {
      return [
        {
          provider: 'anthropic' as const,
          type: 'compaction',
          id: stringValue(record.id),
          artifact: record,
        },
      ];
    }
    return [];
  });
}

export function extractGeminiReplayRequiredArtifacts(
  response: unknown,
): ReplayRequiredArtifact[] {
  const candidates = asRecord(response)?.candidates;
  if (!Array.isArray(candidates)) {
    return [];
  }

  return candidates.flatMap((candidate, candidateIndex) => {
    const parts = asRecord(asRecord(candidate)?.content)?.parts;
    if (!Array.isArray(parts)) {
      return [];
    }
    return parts.flatMap((part, partIndex) => {
      const record = asRecord(part);
      if (!record || typeof record.thoughtSignature !== 'string') {
        return [];
      }
      return [
        {
          provider: 'google' as const,
          type: 'thoughtSignature',
          id: `${candidateIndex}:${partIndex}`,
          artifact: record,
        },
      ];
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
