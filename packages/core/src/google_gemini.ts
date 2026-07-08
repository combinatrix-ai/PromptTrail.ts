import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai';
import type {
  ApprovalHandler,
  BuiltinTool,
  CallToolResult,
  CapabilitySet,
  PromptTrailTool,
} from './capabilities';
import { requireConfiguredCapabilityApprovals } from './capabilities';
import { contentPartsToGeminiParts } from './content_parts';
import {
  deriveConversationBinding,
  getMessagesAfterBinding,
  type ConversationBinding,
} from './conversation';
import { mapGeminiThinkingConfig } from './generation_options';
import { zodToJsonSchema } from './json_schema';
import type {
  CompactionOptions,
  GoogleProviderConfig,
  LLMOptions,
  ProviderRetryOptions,
  SchemaGenerationOptions,
} from './llm_types';
import type { Message } from './message';
import { geminiStreamEventToPromptTrailEvents } from './provider_stream';
import { extractGeminiReplayRequiredArtifacts } from './replay_pins';
import type { RetainLevel } from './runtime';
import { Session } from './session';
import type { Vars } from './session';
import { appendSkillInstructions, warnSkillInstructionLoss } from './skills';
import { executePromptTrailTool, isPromptTrailTool } from './tool';

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args: unknown;
  raw: unknown;
}

export interface GeminiCacheClient {
  caches: {
    create(params: Record<string, unknown>): Promise<{ name?: string }>;
  };
  models?: {
    countTokens(
      params: Record<string, unknown>,
    ): Promise<{ totalTokens?: number }>;
  };
}

export interface GeminiCachedContentResolution {
  binding?: ConversationBinding;
  cachedContent?: string;
  metadataBinding?: ConversationBinding;
}

export async function generateGoogleGeminiText<TVars extends Vars>(
  session: Session<TVars>,
  options: LLMOptions & { provider: GoogleProviderConfig },
): Promise<Message> {
  return generateGoogleGeminiMessage(session, options);
}

export function getGoogleGenAIClientOptions(
  provider: GoogleProviderConfig,
): ConstructorParameters<typeof GoogleGenAI>[0] {
  return {
    apiKey: provider.apiKey,
    httpOptions: provider.baseURL ? { baseUrl: provider.baseURL } : undefined,
  };
}

export async function* streamGoogleGeminiEvents<TVars extends Vars>(
  session: Session<TVars>,
  options: LLMOptions & { provider: GoogleProviderConfig },
) {
  const ai = new GoogleGenAI(getGoogleGenAIClientOptions(options.provider));
  assertGeminiProviderCompactionUnsupported(options.compaction);
  const tools = getGeminiPromptTrailTools(options);
  await requireConfiguredCapabilityApprovals(
    getGeminiConfiguredCapabilities(options.capabilities),
    {
      provider: 'google',
      session,
      approvalHandler: options.approvalHandler,
    },
  );
  const toolDefinitions = getGeminiToolDefinitions(options);
  const binding = await resolveGeminiCachedContentBinding(
    ai as unknown as GeminiCacheClient,
    session,
    options,
    tools,
    toolDefinitions,
  );
  const contents = convertMessagesToGeminiContents(
    getMessagesAfterBinding(session, binding),
  );
  const stream = await withGoogleProviderRetry(
    () =>
      ai.models.generateContentStream({
        model: options.provider.modelName,
        contents: contents as any,
        config: buildGeminiGenerationConfig(
          session,
          options,
          tools,
          toolDefinitions,
          binding,
        ) as any,
      }),
    options.provider.retry,
  );

  yield* normalizeGeminiContentStream(stream as AsyncIterable<unknown>);
}

export async function* normalizeGeminiContentStream(
  stream: AsyncIterable<unknown>,
) {
  for await (const event of stream) {
    for (const normalized of geminiStreamEventToPromptTrailEvents(event)) {
      yield normalized;
    }
  }
}

export async function generateGoogleGeminiWithSchema<TVars extends Vars>(
  session: Session<TVars>,
  options: LLMOptions & { provider: GoogleProviderConfig },
  schemaOptions: SchemaGenerationOptions,
): Promise<Message & { structuredOutput?: unknown }> {
  const message = await generateGoogleGeminiMessage(session, options, {
    ...createGeminiStructuredOutputConfig(schemaOptions),
  });
  const parsed = schemaOptions.schema.safeParse(JSON.parse(message.content));
  if (!parsed.success) {
    throw new Error(`Schema validation failed: ${parsed.error.message}`);
  }

  return {
    ...message,
    content: JSON.stringify(parsed.data, null, 2),
    structuredOutput: parsed.data,
  };
}

export function createGeminiStructuredOutputConfig(
  schemaOptions: SchemaGenerationOptions,
): Record<string, unknown> {
  return {
    responseMimeType: 'application/json',
    responseJsonSchema: zodToJsonSchema(schemaOptions.schema, {
      propertyOrdering: true,
    }),
  };
}

async function generateGoogleGeminiMessage<TVars extends Vars>(
  session: Session<TVars>,
  options: LLMOptions & { provider: GoogleProviderConfig },
  extraConfig: Record<string, unknown> = {},
): Promise<Message> {
  const ai = new GoogleGenAI(getGoogleGenAIClientOptions(options.provider));
  assertGeminiProviderCompactionUnsupported(options.compaction);
  const tools = getGeminiPromptTrailTools(options);
  await requireConfiguredCapabilityApprovals(
    getGeminiConfiguredCapabilities(options.capabilities),
    {
      provider: 'google',
      session,
      approvalHandler: options.approvalHandler,
    },
  );
  const toolDefinitions = getGeminiToolDefinitions(options);
  const cacheResolution = await resolveGeminiCachedContent(
    ai as unknown as GeminiCacheClient,
    session,
    options,
    tools,
    toolDefinitions,
  );
  const binding = cacheResolution.binding;
  let contents: unknown[] = convertMessagesToGeminiContents(
    getMessagesAfterBinding(session, binding),
  );
  let response = await createGeminiContent(
    ai,
    contents,
    session,
    options,
    tools,
    toolDefinitions,
    binding,
    getGeminiTurnExtraConfig(options, tools, extraConfig),
  );

  for (let i = 0; i < (options.maxCallLimit ?? 10); i++) {
    const functionCalls = collectGeminiFunctionCalls(response);
    if (functionCalls.length === 0) {
      break;
    }

    const responseParts = await Promise.all(
      functionCalls.map((call) =>
        createGeminiFunctionResponsePart(
          call,
          tools,
          session,
          options.approvalHandler,
          options.services,
        ),
      ),
    );
    contents = [
      ...contents,
      {
        role: 'model',
        parts: functionCalls.map((call) => call.raw),
      },
      { role: 'user', parts: responseParts },
    ];
    const continuationOptions = getGeminiToolLoopContinuationOptions(
      options,
      extraConfig,
    );
    response = await createGeminiContent(
      ai,
      contents,
      session,
      continuationOptions,
      tools,
      toolDefinitions,
      binding,
      getGeminiTurnExtraConfig(continuationOptions, tools, extraConfig),
    );
  }

  return {
    type: 'assistant',
    content: getGeminiText(response) || ' ',
    attrs: {
      google: attachGeminiCachedContentMetadata(
        retainGeminiResponseMetadata(response, options.retain ?? 'summary'),
        cacheResolution,
      ),
    },
  };
}

export function getGeminiToolLoopContinuationOptions(
  options: LLMOptions & { provider: GoogleProviderConfig },
  extraConfig: Record<string, unknown> = {},
): LLMOptions & { provider: GoogleProviderConfig } {
  if (isGeminiStructuredOutputConfig(extraConfig)) {
    return { ...options, toolChoice: 'none' };
  }
  return options.toolChoice === 'required'
    ? { ...options, toolChoice: 'auto' }
    : options;
}

export function getGeminiTurnExtraConfig(
  options: Pick<LLMOptions, 'toolChoice'>,
  tools: readonly PromptTrailTool[],
  extraConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (
    options.toolChoice === 'required' &&
    tools.length > 0 &&
    isGeminiStructuredOutputConfig(extraConfig)
  ) {
    return {};
  }
  return extraConfig;
}

function isGeminiStructuredOutputConfig(
  config: Record<string, unknown>,
): boolean {
  return (
    config.responseMimeType === 'application/json' ||
    config.responseJsonSchema !== undefined
  );
}

async function resolveGeminiCachedContentBinding(
  ai: GeminiCacheClient,
  session: Session<any>,
  options: LLMOptions & { provider: GoogleProviderConfig },
  tools: readonly PromptTrailTool[],
  toolDefinitions: readonly unknown[],
): Promise<ConversationBinding | undefined> {
  return (
    await resolveGeminiCachedContent(
      ai,
      session,
      options,
      tools,
      toolDefinitions,
    )
  ).binding;
}

export async function resolveGeminiCachedContent(
  client: GeminiCacheClient,
  session: Session<any>,
  options: LLMOptions & { provider: GoogleProviderConfig },
  tools: readonly PromptTrailTool[] = getGeminiPromptTrailTools(options),
  toolDefinitions: readonly unknown[] = getGeminiToolDefinitions(options),
): Promise<GeminiCachedContentResolution> {
  const existingBinding = deriveConversationBinding(session, 'google');
  if (existingBinding) {
    return {
      binding: existingBinding,
      cachedContent: existingBinding.id,
      metadataBinding: existingBinding,
    };
  }

  const prefix = getGeminiCacheablePrefixSession(session, options);
  if (!prefix) {
    return {};
  }

  const createParams = buildGeminiCachedContentCreateParams(
    prefix.session,
    options,
    tools,
    toolDefinitions,
  );
  if (
    !(await shouldCreateGeminiCachedContent(
      client,
      createParams,
      options.provider.retry,
    ))
  ) {
    return {};
  }

  const cachedContent = await createGeminiCachedContent(
    client,
    createParams,
    options.provider.retry,
  );
  const binding = {
    provider: 'google' as const,
    id: cachedContent,
    messageIndex: prefix.messageIndex,
  };

  return {
    cachedContent,
    metadataBinding: binding,
    binding:
      prefix.messageIndex < session.messages.length - 1 ? binding : undefined,
  };
}

async function createGeminiContent(
  ai: GoogleGenAI,
  contents: unknown[],
  session: Session<any>,
  options: LLMOptions & { provider: GoogleProviderConfig },
  tools: readonly PromptTrailTool[],
  toolDefinitions: readonly unknown[],
  binding?: ConversationBinding,
  extraConfig: Record<string, unknown> = {},
) {
  return withGoogleProviderRetry(
    () =>
      ai.models.generateContent({
        model: options.provider.modelName,
        contents: contents as any,
        config: buildGeminiGenerationConfig(
          session,
          options,
          tools,
          toolDefinitions,
          binding,
          extraConfig,
        ) as any,
      }),
    options.provider.retry,
  );
}

export function buildGeminiGenerationConfig(
  session: Session<any>,
  options: LLMOptions & { provider: GoogleProviderConfig },
  tools: readonly PromptTrailTool[],
  toolDefinitions: readonly unknown[],
  binding?: ConversationBinding,
  extraConfig: Record<string, unknown> = {},
): Record<string, unknown> {
  assertGeminiProviderCompactionUnsupported(options.compaction);
  return {
    cachedContent: binding?.id,
    systemInstruction: binding
      ? undefined
      : getGeminiSystemInstruction(session, options),
    temperature: options.temperature,
    topP: options.topP,
    topK: options.topK,
    maxOutputTokens: options.maxTokens,
    thinkingConfig: mapGeminiThinkingConfig(options.thinking),
    tools:
      !binding && toolDefinitions.length > 0
        ? (toolDefinitions as any)
        : undefined,
    toolConfig:
      !binding && tools.length > 0 && options.toolChoice
        ? {
            functionCallingConfig: {
              mode: mapGeminiFunctionCallingMode(options.toolChoice),
              allowedFunctionNames:
                options.toolChoice === 'required'
                  ? tools.map((tool) => tool.name)
                  : undefined,
            },
          }
        : undefined,
    ...extraConfig,
  };
}

export function assertGeminiProviderCompactionUnsupported(
  compaction: CompactionOptions | undefined,
): void {
  if (compaction?.mode !== 'provider') {
    return;
  }
  throw new Error(
    'Gemini does not support provider compaction; use compaction mode "local" or "off".',
  );
}

export function buildGeminiCachedContentCreateParams(
  session: Session<any>,
  options: LLMOptions & { provider: GoogleProviderConfig },
  tools: readonly PromptTrailTool[] = getGeminiPromptTrailTools(options),
  toolDefinitions: readonly unknown[] = getGeminiToolDefinitions(options),
): Record<string, unknown> {
  return {
    model: options.provider.modelName,
    config: {
      displayName: options.cacheKey,
      contents: convertSessionToGeminiContents(session),
      systemInstruction: getGeminiSystemInstruction(session, options),
      tools: toolDefinitions.length > 0 ? (toolDefinitions as any) : undefined,
      toolConfig:
        tools.length > 0 && options.toolChoice
          ? {
              functionCallingConfig: {
                mode: mapGeminiFunctionCallingMode(options.toolChoice),
                allowedFunctionNames:
                  options.toolChoice === 'required'
                    ? tools.map((tool) => tool.name)
                    : undefined,
              },
            }
          : undefined,
    },
  };
}

export async function createGeminiCachedContent(
  client: GeminiCacheClient,
  params: Record<string, unknown>,
  retry?: ProviderRetryOptions,
): Promise<string> {
  const cached = await withGoogleProviderRetry(
    () => client.caches.create(params),
    retry,
  );
  if (!cached.name) {
    throw new Error(
      'Gemini CachedContent create response did not include name.',
    );
  }
  return cached.name;
}

export async function shouldCreateGeminiCachedContent(
  client: GeminiCacheClient,
  params: Record<string, unknown>,
  retry?: ProviderRetryOptions,
): Promise<boolean> {
  const tokenCount = await countGeminiCachedContentTokens(
    client,
    params,
    retry,
  );
  if (tokenCount === undefined) {
    return false;
  }
  return tokenCount >= getGeminiExplicitCacheMinTokens(String(params.model));
}

export async function countGeminiCachedContentTokens(
  client: GeminiCacheClient,
  params: Record<string, unknown>,
  retry?: ProviderRetryOptions,
): Promise<number | undefined> {
  if (!client.models?.countTokens || typeof params.model !== 'string') {
    return undefined;
  }
  const config = asRecord(params.config);
  const contents = config?.contents;
  if (!contents) {
    return undefined;
  }
  const countConfig: Record<string, unknown> = {};
  if (config.tools) {
    countConfig.tools = config.tools;
  }
  const result = await withGoogleProviderRetry(
    () =>
      client.models!.countTokens({
        model: params.model,
        contents,
        config: Object.keys(countConfig).length > 0 ? countConfig : undefined,
      }),
    retry,
  );
  return typeof result.totalTokens === 'number'
    ? result.totalTokens
    : undefined;
}

export async function withGoogleProviderRetry<T>(
  operation: () => Promise<T>,
  retry: ProviderRetryOptions | undefined,
  sleep: (delayMs: number) => Promise<void> = sleepMs,
): Promise<T> {
  const maxRetries = retry?.maxRetries ?? 0;
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isGoogleRetryableError(error, retry)) {
        throw error;
      }
      const delayMs = getCappedRetryDelayMs(error, attempt, retry);
      await sleep(delayMs);
      attempt++;
    }
  }
}

function getCappedRetryDelayMs(
  error: unknown,
  attempt: number,
  retry: ProviderRetryOptions | undefined,
): number {
  const delayMs =
    getGoogleRetryDelayMs(error) ?? getBackoffDelayMs(attempt, retry);
  return Math.min(delayMs, retry?.maxDelayMs ?? 60000);
}

export function isGoogleRetryableError(
  error: unknown,
  retry: ProviderRetryOptions | undefined,
): boolean {
  const status = getGoogleErrorStatus(error);
  if (status === undefined) {
    return false;
  }
  const retryableStatuses = retry?.retryableStatuses ?? [
    429, 500, 502, 503, 504,
  ];
  return retryableStatuses.includes(status);
}

export function getGoogleRetryDelayMs(error: unknown): number | undefined {
  const details = getGoogleErrorDetails(error);
  for (const detail of details) {
    if (detail['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') {
      continue;
    }
    const retryDelay = detail.retryDelay;
    if (typeof retryDelay !== 'string') {
      continue;
    }
    const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
    if (!match) {
      continue;
    }
    return Math.ceil(Number(match[1]) * 1000);
  }
  return undefined;
}

function getBackoffDelayMs(
  attempt: number,
  retry: ProviderRetryOptions | undefined,
): number {
  const initialDelayMs = retry?.initialDelayMs ?? 1000;
  const maxDelayMs = retry?.maxDelayMs ?? 60000;
  return Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
}

function sleepMs(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function getGoogleErrorStatus(error: unknown): number | undefined {
  const directStatus = getNumberProperty(error, 'status');
  if (directStatus !== undefined) {
    return directStatus;
  }
  const parsed = parseGoogleErrorPayload(error);
  const payloadStatus = getNumberProperty(parsed?.error, 'code');
  if (payloadStatus !== undefined) {
    return payloadStatus;
  }
  const statusText = getStringProperty(parsed?.error, 'status');
  if (statusText === 'RESOURCE_EXHAUSTED') {
    return 429;
  }
  if (statusText === 'UNAVAILABLE') {
    return 503;
  }
  return undefined;
}

function getGoogleErrorDetails(error: unknown): Array<Record<string, unknown>> {
  const parsed = parseGoogleErrorPayload(error);
  const details = asRecord(parsed?.error)?.details;
  return Array.isArray(details)
    ? details.filter(
        (detail): detail is Record<string, unknown> =>
          !!detail && typeof detail === 'object',
      )
    : [];
}

function parseGoogleErrorPayload(
  error: unknown,
): Record<string, unknown> | undefined {
  const message = getStringProperty(error, 'message');
  if (!message) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(message);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  const record = asRecord(value);
  const property = record?.[key];
  return typeof property === 'number' ? property : undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  const property = record?.[key];
  return typeof property === 'string' ? property : undefined;
}

export function getGeminiExplicitCacheMinTokens(modelName: string): number {
  const normalized = modelName.toLowerCase().replace(/^models\//, '');
  if (normalized.startsWith('gemini-2.5-')) {
    return 2048;
  }
  return 4096;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

export function getGeminiCacheablePrefixSession(
  session: Session<any>,
  options: Pick<LLMOptions, 'capabilities'> = {},
):
  | {
      session: Session<any>;
      messageIndex: number;
    }
  | undefined {
  let lastCacheHintIndex = -1;
  session.messages.forEach((message, index) => {
    if (message.cache) {
      lastCacheHintIndex = index;
    }
  });

  const hasCachedCapability = (options.capabilities ?? []).some(
    (capability) => !!capability.cache,
  );
  if (lastCacheHintIndex < 0 && hasCachedCapability) {
    lastCacheHintIndex = session.messages.length - 1;
  }
  if (lastCacheHintIndex < 0) {
    return undefined;
  }

  return {
    session: new Session(
      session.messages.slice(0, lastCacheHintIndex + 1),
      session.vars,
      session.print,
      session.version,
      session.historyRewrittenAtVersion,
    ),
    messageIndex: lastCacheHintIndex,
  };
}

export function attachGeminiCachedContentMetadata(
  metadata: Record<string, unknown>,
  cache: GeminiCachedContentResolution,
): Record<string, unknown> {
  if (!cache.cachedContent) {
    return metadata;
  }
  return {
    ...metadata,
    cachedContent: metadata.cachedContent ?? cache.cachedContent,
    cachedContentBinding: cache.metadataBinding
      ? {
          id: cache.metadataBinding.id,
          messageIndex: cache.metadataBinding.messageIndex,
        }
      : undefined,
  };
}

export function convertSessionToGeminiContents(
  session: Session<any>,
): Array<{ role: 'user' | 'model'; parts: unknown[] }> {
  return convertMessagesToGeminiContents(session.messages);
}

export function convertMessagesToGeminiContents(
  messages: readonly Message[],
): Array<{ role: 'user' | 'model'; parts: unknown[] }> {
  const contents: Array<{ role: 'user' | 'model'; parts: unknown[] }> = [];
  const toolNamesByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.type === 'user' || message.type === 'assistant') {
      const parts = message.contentParts
        ? contentPartsToGeminiParts(message.contentParts)
        : [{ text: message.content }];
      const functionCalls =
        message.type === 'assistant'
          ? (message.toolCalls ?? []).map((call) => {
              toolNamesByCallId.set(call.id, call.name);
              return {
                functionCall: {
                  id: call.id,
                  name: call.name,
                  args: call.arguments,
                },
              };
            })
          : [];
      const replayRequired =
        message.type === 'assistant'
          ? getGeminiReplayRequiredParts(message)
          : [];
      contents.push({
        role: message.type === 'assistant' ? 'model' : 'user',
        parts:
          message.type === 'assistant'
            ? [
                ...replayRequired,
                ...(replayRequired.length > 0 || functionCalls.length > 0
                  ? filterEmptyGeminiTextParts(parts)
                  : parts),
                ...functionCalls,
              ]
            : parts,
      });
      continue;
    }

    if (message.type === 'tool_result') {
      const part = convertToolResultToGeminiPart(message, toolNamesByCallId);
      if (!part) {
        continue;
      }
      const previous = contents[contents.length - 1];
      if (previous?.role === 'user') {
        previous.parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
    }
  }
  return contents;
}

function filterEmptyGeminiTextParts(parts: unknown[]): unknown[] {
  return parts.filter((part) => {
    const record = part as Record<string, unknown> | undefined;
    return typeof record?.text === 'string' ? record.text.trim() !== '' : true;
  });
}

function convertToolResultToGeminiPart(
  message: Message,
  toolNamesByCallId: ReadonlyMap<string, string>,
): Record<string, unknown> | undefined {
  const callId =
    message.type === 'tool_result' ? message.toolCallId : undefined;
  if (!callId) {
    return undefined;
  }
  const name = toolNamesByCallId.get(callId) ?? callId;
  return {
    functionResponse: {
      id: callId,
      name,
      response: parseGeminiToolResultContent(message.content),
    },
  };
}

function parseGeminiToolResultContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return { content };
  }
}

function getGeminiReplayRequiredParts(message: Message): unknown[] {
  const google = message.attrs?.google as Record<string, unknown> | undefined;
  const replayRequired = google?.replayRequired;
  if (!Array.isArray(replayRequired)) {
    return [];
  }

  return replayRequired.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    return record.provider === 'google' && record.artifact
      ? [record.artifact]
      : [];
  });
}

export function getGeminiSystemInstruction(
  session: Session<any>,
  options?: Pick<LLMOptions, 'capabilities' | 'skillInjection'>,
): string | undefined {
  const system = session.messages
    .filter((message) => message.type === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const injected = appendSkillInstructions(
    system || undefined,
    options?.capabilities,
    options?.skillInjection ?? 'warn',
  );
  warnSkillInstructionLoss(injected.warnings);
  return injected.instructions || undefined;
}

export function getGeminiPromptTrailTools(
  options: Pick<LLMOptions, 'capabilities' | 'tools'>,
): PromptTrailTool[] {
  const tools = new Map<string, PromptTrailTool>();
  for (const capability of options.capabilities ?? []) {
    if (isPromptTrailTool(capability)) {
      tools.set(capability.name, capability);
    }
  }
  for (const [name, tool] of Object.entries(options.tools ?? {})) {
    if (isPromptTrailTool(tool)) {
      tools.set(tool.name || name, tool);
    }
  }
  return [...tools.values()];
}

export function getGeminiToolDefinitions(
  options: Pick<LLMOptions, 'capabilities' | 'tools'>,
): unknown[] {
  const promptTrailTools = getGeminiPromptTrailTools(options);
  return [
    ...(promptTrailTools.length > 0
      ? [
          {
            functionDeclarations: promptTrailTools.map(
              promptTrailToolToGeminiTool,
            ),
          },
        ]
      : []),
    ...(options.capabilities ?? []).flatMap((capability) =>
      capability.kind === 'builtin'
        ? promptTrailBuiltinToGeminiTool(capability)
        : [],
    ),
  ];
}

export function getGeminiConfiguredCapabilities(
  capabilities: CapabilitySet | undefined,
): CapabilitySet {
  return (capabilities ?? []).filter(
    (capability) => capability.kind === 'builtin',
  );
}

export function promptTrailToolToGeminiTool(tool: PromptTrailTool) {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: zodToJsonSchema(tool.inputSchema),
  };
}

export function promptTrailBuiltinToGeminiTool(
  tool: BuiltinTool,
): Record<string, unknown> {
  const key = geminiBuiltinToolKey(tool.name);
  return { [key]: tool.config ?? {} };
}

function geminiBuiltinToolKey(name: string): string {
  if (name === 'google_search') {
    return 'googleSearch';
  }
  if (name === 'code_execution') {
    return 'codeExecution';
  }
  if (name === 'url_context') {
    return 'urlContext';
  }
  return name;
}

export function collectGeminiFunctionCalls(
  response: unknown,
): GeminiFunctionCall[] {
  const candidateCalls = collectGeminiFunctionCallParts(response);
  if (candidateCalls.length > 0) {
    return candidateCalls;
  }

  const calls = (response as { functionCalls?: unknown[] }).functionCalls ?? [];
  return calls
    .filter(
      (call): call is Record<string, unknown> =>
        !!call && typeof call === 'object',
    )
    .map((call) => ({
      id: typeof call.id === 'string' ? call.id : undefined,
      name: String(call.name),
      args: call.args ?? {},
      raw: { functionCall: call },
    }));
}

function collectGeminiFunctionCallParts(
  response: unknown,
): GeminiFunctionCall[] {
  const candidates = (response as { candidates?: unknown[] }).candidates ?? [];
  return candidates.flatMap((candidate) => {
    const content = (candidate as Record<string, unknown> | undefined)?.content;
    const parts = (content as Record<string, unknown> | undefined)?.parts;
    if (!Array.isArray(parts)) {
      return [];
    }

    return parts.flatMap((part) => {
      const record = part as Record<string, unknown> | undefined;
      const functionCall = record?.functionCall as
        | Record<string, unknown>
        | undefined;
      if (!functionCall) {
        return [];
      }

      return [
        {
          id: typeof functionCall.id === 'string' ? functionCall.id : undefined,
          name: String(functionCall.name),
          args: functionCall.args ?? {},
          raw: part,
        },
      ];
    });
  });
}

export async function createGeminiFunctionResponsePart(
  call: GeminiFunctionCall,
  tools: readonly PromptTrailTool[],
  session: Session<any>,
  approvalHandler?: ApprovalHandler,
  services?: Record<string, unknown>,
) {
  const tool = tools.find((candidate) => candidate.name === call.name);
  // Native Gemini tools run outside any durable boundary by design
  // (vendor loop); ctx.idempotencyKey still reaches the tool for remote dedup.
  const result: CallToolResult = tool
    ? await executePromptTrailTool(tool, call.args, {
        session,
        services,
        provider: 'google',
        approvalHandler,
        raw: call.raw,
      })
    : {
        content: [
          { type: 'text' as const, text: `Unknown tool: ${call.name}` },
        ],
        isError: true,
      };

  return {
    functionResponse: {
      id: call.id ?? call.name,
      name: call.name,
      response: result.structuredContent ?? {
        content: result.content,
        isError: result.isError,
      },
    },
  };
}

export function retainGeminiResponseMetadata(
  response: unknown,
  retain: RetainLevel,
): Record<string, unknown> {
  const record = response as Record<string, unknown>;
  const base = {
    provider: 'google',
    api: 'gemini',
    finishReason: getGeminiFinishReason(response),
    cachedContent: getGeminiCachedContent(response),
    replayRequired: extractGeminiReplayRequiredArtifacts(response),
  };
  if (retain === 'none') {
    return base;
  }
  if (retain === 'full') {
    return {
      ...base,
      usage: record.usageMetadata,
      candidates: record.candidates,
      raw: response,
    };
  }
  return {
    ...base,
    usage: record.usageMetadata,
    candidates: Array.isArray(record.candidates)
      ? record.candidates.map((candidate) =>
          summarizeGeminiCandidate(candidate),
        )
      : undefined,
  };
}

function getGeminiText(response: unknown): string | undefined {
  const text = (response as { text?: string }).text;
  return typeof text === 'string' ? text : undefined;
}

function getGeminiFinishReason(response: unknown): string | undefined {
  const candidates = (response as { candidates?: unknown[] }).candidates;
  const first = candidates?.[0] as Record<string, unknown> | undefined;
  return typeof first?.finishReason === 'string'
    ? first.finishReason
    : undefined;
}

function getGeminiCachedContent(response: unknown): string | undefined {
  const record = response as Record<string, unknown>;
  if (typeof record.cachedContent === 'string') {
    return record.cachedContent;
  }
  const cachedContent = record.cachedContent as
    | Record<string, unknown>
    | undefined;
  return typeof cachedContent?.name === 'string'
    ? cachedContent.name
    : undefined;
}

function summarizeGeminiCandidate(candidate: unknown): Record<string, unknown> {
  if (!candidate || typeof candidate !== 'object') {
    return { preview: String(candidate) };
  }
  const record = candidate as Record<string, unknown>;
  return {
    finishReason: record.finishReason,
    safetyRatings: record.safetyRatings,
  };
}

function mapGeminiFunctionCallingMode(choice: LLMOptions['toolChoice']) {
  if (choice === 'required') {
    return FunctionCallingConfigMode.ANY;
  }
  if (choice === 'none') {
    return FunctionCallingConfigMode.NONE;
  }
  return FunctionCallingConfigMode.AUTO;
}
