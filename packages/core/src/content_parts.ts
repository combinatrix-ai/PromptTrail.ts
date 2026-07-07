export type ProviderFileCleanupPolicy = 'caller' | 'prompttrail' | 'none';

export type ContentPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'image' | 'file' | 'audio';
      mimeType: string;
      source:
        | { type: 'bytes'; data: Uint8Array | string }
        | { type: 'uri'; uri: string }
        | {
            type: 'providerFile';
            provider: string;
            fileId: string;
            uploadedAt?: string;
            expiresAt?: string;
            cleanup: ProviderFileCleanupPolicy;
          };
      detail?: 'low' | 'high' | 'auto';
      filename?: string;
    };

export function createProviderFileContentPart(options: {
  kind: 'image' | 'file' | 'audio';
  mimeType: string;
  provider: string;
  fileId: string;
  filename?: string;
  uploadedAt?: string | Date;
  expiresAt?: string | Date;
  cleanup?: ProviderFileCleanupPolicy;
  detail?: 'low' | 'high' | 'auto';
}): Exclude<ContentPart, { kind: 'text' }> {
  const uploadedAt =
    options.uploadedAt instanceof Date
      ? options.uploadedAt.toISOString()
      : options.uploadedAt;
  const expiresAt =
    options.expiresAt instanceof Date
      ? options.expiresAt.toISOString()
      : (options.expiresAt ??
        defaultProviderFileExpiresAt(options.provider, uploadedAt));

  return {
    kind: options.kind,
    mimeType: options.mimeType,
    filename: options.filename,
    detail: options.detail,
    source: {
      type: 'providerFile',
      provider: options.provider,
      fileId: options.fileId,
      uploadedAt,
      expiresAt,
      cleanup: options.cleanup ?? 'caller',
    },
  };
}

export function isProviderFileReferenceExpired(
  part: ContentPart,
  now: Date = new Date(),
): boolean {
  if (part.kind === 'text' || part.source.type !== 'providerFile') {
    return false;
  }
  if (!part.source.expiresAt) {
    return false;
  }
  return Date.parse(part.source.expiresAt) <= now.getTime();
}

export function assertProviderFileReferenceUsable(
  part: ContentPart,
  now: Date = new Date(),
): void {
  if (part.kind === 'text' || part.source.type !== 'providerFile') {
    return;
  }
  if (!isProviderFileReferenceExpired(part, now)) {
    return;
  }
  throw new Error(
    `Provider file reference ${part.source.fileId} for ${part.source.provider} expired at ${part.source.expiresAt}; re-upload before sending.`,
  );
}

export function assertProviderFileReferenceUsableForProvider(
  part: ContentPart,
  provider: string,
  now: Date = new Date(),
): void {
  assertProviderFileReferenceUsable(part, now);
  if (part.kind === 'text' || part.source.type !== 'providerFile') {
    return;
  }
  if (part.source.provider === provider) {
    return;
  }
  throw new Error(
    `Provider file reference ${part.source.fileId} belongs to ${part.source.provider}, not ${provider}; re-upload before sending.`,
  );
}

export type AiSdkContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      image: Uint8Array | string | URL;
      mimeType?: string;
      providerOptions?: Record<string, unknown>;
    }
  | {
      type: 'file';
      data: Uint8Array | string | URL;
      mimeType: string;
      filename?: string;
      providerOptions?: Record<string, unknown>;
    };

export function contentPartsToText(parts: readonly ContentPart[]): string {
  return parts
    .filter(
      (part): part is Extract<ContentPart, { kind: 'text' }> =>
        part.kind === 'text',
    )
    .map((part) => part.text)
    .join('');
}

export function makeContentPartsPersistenceSafe(
  parts: readonly ContentPart[],
): ContentPart[] {
  return parts.map((part) => {
    if (part.kind === 'text' || part.source.type !== 'bytes') {
      return part;
    }

    return {
      ...part,
      source: {
        type: 'uri',
        uri: `prompttrail://omitted-bytes/${part.filename ?? part.kind}`,
      },
    };
  });
}

export function contentPartsToAiSdkContent(
  parts: readonly ContentPart[],
): AiSdkContentPart[] {
  return parts.map((part) => {
    if (part.kind === 'text') {
      return { type: 'text', text: part.text };
    }

    const source = contentPartSourceToAiSdkData(part);
    if (part.kind === 'image') {
      return {
        type: 'image',
        image: source.data,
        mimeType: part.mimeType,
        providerOptions: source.providerOptions,
      };
    }

    return {
      type: 'file',
      data: source.data,
      mimeType: part.mimeType,
      filename: part.filename,
      providerOptions: source.providerOptions,
    };
  });
}

export function contentPartsToOpenAIInput(
  parts: readonly ContentPart[],
): unknown[] {
  return parts.map((part) => {
    if (part.kind === 'text') {
      return { type: 'input_text', text: part.text };
    }
    if (part.kind === 'image') {
      return {
        type: 'input_image',
        detail: part.detail,
        ...openAIFileSource(part),
      };
    }
    return {
      type: 'input_file',
      filename: part.filename,
      ...openAIFileSource(part),
    };
  });
}

export function contentPartsToAnthropicContent(
  parts: readonly ContentPart[],
): unknown[] {
  return parts.map((part) => {
    if (part.kind === 'text') {
      return { type: 'text', text: part.text };
    }
    if (part.kind === 'image') {
      return {
        type: 'image',
        source: anthropicSource(part),
      };
    }
    return {
      type: 'document',
      source: anthropicSource(part),
      title: part.filename,
    };
  });
}

export function contentPartsToGeminiParts(
  parts: readonly ContentPart[],
): unknown[] {
  return parts.map((part) => {
    if (part.kind === 'text') {
      return { text: part.text };
    }
    if (part.source.type === 'uri') {
      return {
        fileData: {
          mimeType: part.mimeType,
          fileUri: part.source.uri,
        },
      };
    }
    if (part.source.type === 'providerFile') {
      assertProviderFileReferenceUsableForProvider(part, 'google');
      return {
        fileData: {
          mimeType: part.mimeType,
          fileUri: part.source.fileId,
        },
      };
    }
    return {
      inlineData: {
        mimeType: part.mimeType,
        data:
          typeof part.source.data === 'string'
            ? part.source.data
            : bytesToBase64(part.source.data),
      },
    };
  });
}

function contentPartSourceToAiSdkData(
  part: Exclude<ContentPart, { kind: 'text' }>,
): {
  data: Uint8Array | string | URL;
  providerOptions?: Record<string, unknown>;
} {
  if (part.source.type === 'providerFile') {
    assertProviderFileReferenceUsable(part);
    return {
      data: part.source.fileId,
      providerOptions: {
        [part.source.provider]: {
          fileId: part.source.fileId,
        },
      },
    };
  }
  if (part.source.type === 'uri') {
    return { data: new URL(part.source.uri) };
  }
  return { data: part.source.data };
}

function openAIFileSource(part: Exclude<ContentPart, { kind: 'text' }>) {
  if (part.source.type === 'providerFile') {
    assertProviderFileReferenceUsableForProvider(part, 'openai');
    return { file_id: part.source.fileId };
  }
  if (part.source.type === 'uri') {
    return part.kind === 'image'
      ? { image_url: part.source.uri }
      : { file_url: part.source.uri };
  }
  return {
    file_data:
      typeof part.source.data === 'string'
        ? part.source.data
        : bytesToBase64(part.source.data),
  };
}

function anthropicSource(part: Exclude<ContentPart, { kind: 'text' }>) {
  if (part.source.type === 'uri') {
    return {
      type: 'url',
      url: part.source.uri,
    };
  }
  if (part.source.type === 'providerFile') {
    assertProviderFileReferenceUsableForProvider(part, 'anthropic');
    return {
      type: 'file',
      file_id: part.source.fileId,
    };
  }
  return {
    type: 'base64',
    media_type: part.mimeType,
    data:
      typeof part.source.data === 'string'
        ? part.source.data
        : bytesToBase64(part.source.data),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function defaultProviderFileExpiresAt(
  provider: string,
  uploadedAt: string | undefined,
): string | undefined {
  if (provider !== 'google') {
    return undefined;
  }
  const uploadedTime = uploadedAt ? Date.parse(uploadedAt) : Date.now();
  if (Number.isNaN(uploadedTime)) {
    return undefined;
  }
  return new Date(uploadedTime + 48 * 60 * 60 * 1000).toISOString();
}
