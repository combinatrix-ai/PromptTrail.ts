import { describe, expect, it } from 'vitest';
import {
  contentPartsToAiSdkContent,
  contentPartsToAnthropicContent,
  contentPartsToGeminiParts,
  contentPartsToOpenAIInput,
  contentPartsToText,
  createProviderFileContentPart,
  isProviderFileReferenceExpired,
  makeContentPartsPersistenceSafe,
  type ContentPart,
} from '../../content_parts';

describe('ContentPart provider serializers', () => {
  const parts: ContentPart[] = [
    { kind: 'text', text: 'Look at this: ' },
    {
      kind: 'image',
      mimeType: 'image/png',
      source: { type: 'bytes', data: new Uint8Array([1, 2, 3]) },
      detail: 'low',
      filename: 'chart.png',
    },
    {
      kind: 'file',
      mimeType: 'application/pdf',
      source: { type: 'uri', uri: 'https://example.com/report.pdf' },
      filename: 'report.pdf',
    },
    {
      kind: 'file',
      mimeType: 'text/plain',
      source: {
        type: 'providerFile',
        provider: 'openai',
        fileId: 'file-123',
      },
      filename: 'note.txt',
    },
  ];

  it('extracts text and strips bytes for persistence-safe copies', () => {
    expect(contentPartsToText(parts)).toBe('Look at this: ');
    expect(makeContentPartsPersistenceSafe(parts)).toEqual([
      parts[0],
      {
        ...parts[1],
        source: {
          type: 'uri',
          uri: 'prompttrail://omitted-bytes/chart.png',
        },
      },
      parts[2],
      parts[3],
    ]);
  });

  it('serializes parts for AI SDK messages', () => {
    expect(contentPartsToAiSdkContent(parts)).toEqual([
      { type: 'text', text: 'Look at this: ' },
      {
        type: 'image',
        image: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png',
        providerOptions: undefined,
      },
      {
        type: 'file',
        data: new URL('https://example.com/report.pdf'),
        mimeType: 'application/pdf',
        filename: 'report.pdf',
        providerOptions: undefined,
      },
      {
        type: 'file',
        data: 'file-123',
        mimeType: 'text/plain',
        filename: 'note.txt',
        providerOptions: { openai: { fileId: 'file-123' } },
      },
    ]);
  });

  it('serializes parts for OpenAI Responses input messages', () => {
    expect(contentPartsToOpenAIInput(parts)).toEqual([
      { type: 'input_text', text: 'Look at this: ' },
      {
        type: 'input_image',
        detail: 'low',
        file_data: 'AQID',
      },
      {
        type: 'input_file',
        filename: 'report.pdf',
        file_url: 'https://example.com/report.pdf',
      },
      {
        type: 'input_file',
        filename: 'note.txt',
        file_id: 'file-123',
      },
    ]);
  });

  it('serializes parts for Anthropic Messages content blocks', () => {
    expect(contentPartsToAnthropicContent(parts)).toEqual([
      { type: 'text', text: 'Look at this: ' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'AQID',
        },
      },
      {
        type: 'document',
        source: {
          type: 'url',
          url: 'https://example.com/report.pdf',
        },
        title: 'report.pdf',
      },
      {
        type: 'document',
        source: {
          type: 'file',
          file_id: 'file-123',
        },
        title: 'note.txt',
      },
    ]);
  });

  it('serializes parts for Gemini content parts', () => {
    expect(contentPartsToGeminiParts(parts)).toEqual([
      { text: 'Look at this: ' },
      {
        inlineData: {
          mimeType: 'image/png',
          data: 'AQID',
        },
      },
      {
        fileData: {
          mimeType: 'application/pdf',
          fileUri: 'https://example.com/report.pdf',
        },
      },
      {
        fileData: {
          mimeType: 'text/plain',
          fileUri: 'file-123',
        },
      },
    ]);
  });

  it('tracks provider file expiry metadata for Gemini uploads', () => {
    const part = createProviderFileContentPart({
      kind: 'file',
      mimeType: 'application/pdf',
      provider: 'google',
      fileId: 'files/gemini-123',
      filename: 'report.pdf',
      uploadedAt: '2026-06-06T00:00:00.000Z',
    });

    expect(part).toEqual({
      kind: 'file',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
      detail: undefined,
      source: {
        type: 'providerFile',
        provider: 'google',
        fileId: 'files/gemini-123',
        uploadedAt: '2026-06-06T00:00:00.000Z',
        expiresAt: '2026-06-08T00:00:00.000Z',
      },
    });
    expect(
      isProviderFileReferenceExpired(
        part,
        new Date('2026-06-07T23:59:59.999Z'),
      ),
    ).toBe(false);
    expect(
      isProviderFileReferenceExpired(part, new Date('2026-06-08T00:00:00Z')),
    ).toBe(true);
    expect(contentPartsToGeminiParts([part])).toEqual([
      {
        fileData: {
          mimeType: 'application/pdf',
          fileUri: 'files/gemini-123',
        },
      },
    ]);
  });

  it('treats non-expiring provider file refs as valid until expiry is known', () => {
    const part = createProviderFileContentPart({
      kind: 'file',
      mimeType: 'text/plain',
      provider: 'openai',
      fileId: 'file-openai-123',
    });

    expect(part.source).toEqual({
      type: 'providerFile',
      provider: 'openai',
      fileId: 'file-openai-123',
      uploadedAt: undefined,
      expiresAt: undefined,
    });
    expect(isProviderFileReferenceExpired(part)).toBe(false);
  });
});
