import Anthropic from '@anthropic-ai/sdk';
import { applyAnthropicCacheControl } from './cache';
import type {
  ApprovalHandler,
  BuiltinTool,
  CapabilitySet,
  PromptTrailTool,
  RuntimeSkill,
} from './capabilities';
import { requireConfiguredCapabilityApprovals } from './capabilities';
import { contentPartsToAnthropicContent } from './content_parts';
import {
  mapAnthropicCompaction,
  mapAnthropicThinking,
} from './generation_options';
import { zodToJsonSchema } from './json_schema';
import { normalizeSchemaGenerationMode } from './llm_types';
import type {
  AnthropicProviderConfig,
  LLMOptions,
  SchemaGenerationOptions,
} from './llm_types';
import type { Message } from './message';
import { createAnthropicStreamNormalizer } from './provider_stream';
import { extractAnthropicReplayRequiredArtifacts } from './replay_pins';
import type { RetainLevel } from './runtime';
import type { Attrs, Session, Vars } from './session';
import { appendSkillInstructions, warnSkillInstructionLoss } from './skills';
import { executePromptTrailTool, isPromptTrailTool } from './tool';

export interface AnthropicToolUse {
  id: string;
  name: string;
  input: unknown;
  raw: unknown;
}

export interface AnthropicRequestContent {
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  system: unknown;
}

export interface AnthropicSkillUploadResult {
  skillId: string;
  version?: string;
  raw?: unknown;
}

export interface AnthropicSkillUploadClient {
  uploadSkill(skill: RuntimeSkill): Promise<AnthropicSkillUploadResult>;
}

export interface AnthropicSkillsHttpClientOptions {
  apiKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
}

const ANTHROPIC_SKILLS_BETA = 'skills-2025-10-02';
const ANTHROPIC_SKILLS_INVOCATION_BETA =
  'code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14';

export class AnthropicSkillsHttpClient implements AnthropicSkillUploadClient {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicSkillsHttpClientOptions) {
    this.apiKey = options.apiKey;
    this.baseURL = (options.baseURL ?? 'https://api.anthropic.com').replace(
      /\/+$/,
      '',
    );
    this.fetchImpl = options.fetch ?? fetch;
  }

  async uploadSkill(skill: RuntimeSkill): Promise<AnthropicSkillUploadResult> {
    const body = new FormData();
    body.append('display_title', skill.name);
    body.append(
      'files',
      new Blob([renderAnthropicSkillMarkdown(skill)], {
        type: 'text/markdown',
      }),
      `${sanitizeAnthropicSkillDirectoryName(skill.name)}/SKILL.md`,
    );

    const response = await this.fetchImpl(`${this.baseURL}/v1/skills`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': ANTHROPIC_SKILLS_BETA,
      },
      body,
    });
    if (!response.ok) {
      throw new Error(
        `Anthropic skill upload failed: ${response.status} ${response.statusText}`,
      );
    }

    const raw = (await response.json()) as Record<string, unknown>;
    const skillId =
      typeof raw.id === 'string'
        ? raw.id
        : typeof raw.skill_id === 'string'
          ? raw.skill_id
          : undefined;
    if (!skillId) {
      throw new Error('Anthropic skill upload response did not include an id.');
    }
    return {
      skillId,
      version:
        typeof raw.latest_version === 'string'
          ? raw.latest_version
          : typeof raw.version === 'string'
            ? raw.version
            : undefined,
      raw,
    };
  }
}

export async function generateAnthropicMessagesText<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: AnthropicProviderConfig },
): Promise<Message<TAttrs>> {
  const resolvedOptions = await resolveAnthropicRuntimeCapabilities(
    session,
    options,
  );
  await requireConfiguredCapabilityApprovals(
    getAnthropicConfiguredCapabilities(resolvedOptions.capabilities),
    {
      provider: 'anthropic',
      session,
      approvalHandler: resolvedOptions.approvalHandler,
    },
  );
  const client = new Anthropic({
    apiKey: resolvedOptions.provider.apiKey,
    baseURL: resolvedOptions.provider.baseURL,
    dangerouslyAllowBrowser: resolvedOptions.dangerouslyAllowBrowser,
  });
  const tools = getAnthropicPromptTrailTools(resolvedOptions);
  const toolDefinitions = getAnthropicToolDefinitions(resolvedOptions);
  const requestContent = getAnthropicRequestContent(session, resolvedOptions);
  let messages: unknown[] = requestContent.messages;
  let response = await createAnthropicMessage(
    client,
    messages,
    requestContent.system,
    session,
    resolvedOptions,
    tools,
    toolDefinitions,
  );

  for (let i = 0; i < (resolvedOptions.maxCallLimit ?? 10); i++) {
    const toolUses = collectAnthropicToolUses(response.content);
    if (toolUses.length === 0) {
      break;
    }

    const toolResults = await Promise.all(
      toolUses.map((toolUse) =>
        createAnthropicToolResultBlock(
          toolUse,
          tools,
          session,
          resolvedOptions.approvalHandler,
        ),
      ),
    );
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ];
    response = await createAnthropicMessage(
      client,
      messages,
      requestContent.system,
      session,
      getAnthropicToolLoopContinuationOptions(resolvedOptions),
      tools,
      toolDefinitions,
    );
  }

  return {
    type: 'assistant',
    content: extractAnthropicText(response.content) || ' ',
    attrs: {
      anthropic: retainAnthropicMessageMetadata(
        response,
        resolvedOptions.retain ?? 'summary',
      ),
    } as unknown as TAttrs,
  };
}

export async function* streamAnthropicMessagesEvents<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: AnthropicProviderConfig },
) {
  const resolvedOptions = await resolveAnthropicRuntimeCapabilities(
    session,
    options,
  );
  await requireConfiguredCapabilityApprovals(
    getAnthropicConfiguredCapabilities(resolvedOptions.capabilities),
    {
      provider: 'anthropic',
      session,
      approvalHandler: resolvedOptions.approvalHandler,
    },
  );
  const client = new Anthropic({
    apiKey: resolvedOptions.provider.apiKey,
    baseURL: resolvedOptions.provider.baseURL,
    dangerouslyAllowBrowser: resolvedOptions.dangerouslyAllowBrowser,
  });
  const toolDefinitions = getAnthropicToolDefinitions(resolvedOptions);
  const requestContent = getAnthropicRequestContent(session, resolvedOptions);
  const stream = await client.messages.create(
    {
      model: resolvedOptions.provider.modelName,
      max_tokens: resolvedOptions.maxTokens ?? 1024,
      messages: requestContent.messages as any,
      system: requestContent.system,
      temperature: resolvedOptions.temperature,
      top_p: resolvedOptions.topP,
      thinking: mapAnthropicThinking(
        resolvedOptions.thinking,
        resolvedOptions.toolChoice,
      ) as any,
      context_management: mapAnthropicCompaction(
        resolvedOptions.compaction,
      ) as any,
      container: getAnthropicSkillsContainer(resolvedOptions),
      tools: toolDefinitions.length > 0 ? (toolDefinitions as any) : undefined,
      tool_choice: mapAnthropicToolChoice(resolvedOptions) as any,
      stream: true,
    } as any,
    getAnthropicRequestOptions(resolvedOptions) as any,
  );

  yield* normalizeAnthropicMessagesStream(
    stream as unknown as AsyncIterable<unknown>,
  );
}

export async function* normalizeAnthropicMessagesStream(
  stream: AsyncIterable<unknown>,
) {
  const normalizer = createAnthropicStreamNormalizer();
  for await (const event of stream) {
    for (const normalized of normalizer.consume(event)) {
      yield normalized;
    }
  }
}

export async function generateAnthropicMessagesWithSchema<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: AnthropicProviderConfig },
  schemaOptions: SchemaGenerationOptions,
): Promise<Message<TAttrs> & { structuredOutput?: unknown }> {
  const resolvedOptions = await resolveAnthropicRuntimeCapabilities(
    session,
    options,
  );
  await requireConfiguredCapabilityApprovals(
    getAnthropicConfiguredCapabilities(resolvedOptions.capabilities),
    {
      provider: 'anthropic',
      session,
      approvalHandler: resolvedOptions.approvalHandler,
    },
  );
  const client = new Anthropic({
    apiKey: resolvedOptions.provider.apiKey,
    baseURL: resolvedOptions.provider.baseURL,
    dangerouslyAllowBrowser: resolvedOptions.dangerouslyAllowBrowser,
  });
  const tools = getAnthropicPromptTrailTools(resolvedOptions);
  const toolName = schemaOptions.functionName ?? 'generateStructuredOutput';

  if (normalizeSchemaGenerationMode(schemaOptions.mode) === 'native') {
    const response = await client.messages.create(
      buildAnthropicSchemaRequestBody(
        session,
        resolvedOptions,
        schemaOptions,
      ) as any,
      getAnthropicRequestOptions(resolvedOptions) as any,
    );
    const text = extractAnthropicText(response.content as unknown[]).trim();
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Anthropic structured output was not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const parsed = schemaOptions.schema.safeParse(output);
    if (!parsed.success) {
      throw new Error(`Schema validation failed: ${parsed.error.message}`);
    }

    return {
      type: 'assistant',
      content: JSON.stringify(parsed.data, null, 2),
      structuredOutput: parsed.data,
      attrs: {
        anthropic: retainAnthropicMessageMetadata(
          response,
          resolvedOptions.retain ?? 'summary',
        ),
      } as unknown as TAttrs,
    };
  }

  const requestContent = getAnthropicRequestContent(session, resolvedOptions);
  let messages: AnthropicRequestContent['messages'] = requestContent.messages;
  let forceStructuredTool = tools.length === 0;

  for (let i = 0; i < (resolvedOptions.maxCallLimit ?? 10); i++) {
    const response = await client.messages.create(
      buildAnthropicSchemaRequestBodyFromContent(
        { messages, system: requestContent.system },
        resolvedOptions,
        schemaOptions,
        forceStructuredTool ? 'force' : 'auto',
      ) as any,
      getAnthropicRequestOptions(resolvedOptions) as any,
    );

    const toolUses = collectAnthropicToolUses(response.content as unknown[]);
    const structuredToolUse = toolUses.find(
      (candidate) => candidate.name === toolName,
    );
    if (structuredToolUse) {
      const parsed = schemaOptions.schema.safeParse(structuredToolUse.input);
      if (!parsed.success) {
        throw new Error(`Schema validation failed: ${parsed.error.message}`);
      }

      return {
        type: 'assistant',
        content: JSON.stringify(parsed.data, null, 2),
        structuredOutput: parsed.data,
        attrs: {
          anthropic: retainAnthropicMessageMetadata(
            response,
            resolvedOptions.retain ?? 'summary',
          ),
        } as unknown as TAttrs,
      };
    }

    if (toolUses.length === 0) {
      throw new Error(
        `Anthropic structured output tool was not called: ${toolName}`,
      );
    }

    const toolResults = await Promise.all(
      toolUses.map((toolUse) =>
        createAnthropicToolResultBlock(
          toolUse,
          tools,
          session,
          resolvedOptions.approvalHandler,
        ),
      ),
    );
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ];
    forceStructuredTool = true;
  }

  throw new Error(
    `Anthropic structured output tool was not called within ${resolvedOptions.maxCallLimit ?? 10} calls: ${toolName}`,
  );
}

export function buildAnthropicSchemaRequestBody(
  session: Session<any, any>,
  options: LLMOptions & { provider: AnthropicProviderConfig },
  schemaOptions: SchemaGenerationOptions,
  toolChoice: 'auto' | 'force' = 'force',
): Record<string, unknown> {
  const requestContent = getAnthropicRequestContent(session, options);
  return buildAnthropicSchemaRequestBodyFromContent(
    requestContent,
    options,
    schemaOptions,
    toolChoice,
  );
}

export function buildAnthropicSchemaRequestBodyFromContent(
  requestContent: AnthropicRequestContent,
  options: LLMOptions & { provider: AnthropicProviderConfig },
  schemaOptions: SchemaGenerationOptions,
  toolChoice: 'auto' | 'force' = 'force',
): Record<string, unknown> {
  const base = {
    model: options.provider.modelName,
    max_tokens: options.maxTokens ?? 1024,
    messages: requestContent.messages,
    system: requestContent.system,
    temperature: options.temperature,
    top_p: options.topP,
    thinking: mapAnthropicThinking(options.thinking, 'required'),
    context_management: mapAnthropicCompaction(options.compaction),
    container: getAnthropicSkillsContainer(options),
  };

  if (normalizeSchemaGenerationMode(schemaOptions.mode) === 'native') {
    return {
      ...base,
      output_config: {
        format: {
          type: 'json_schema',
          schema: zodToJsonSchema(schemaOptions.schema),
        },
      },
    };
  }

  const toolName = schemaOptions.functionName ?? 'generateStructuredOutput';
  return {
    ...base,
    tools: [
      ...getAnthropicToolDefinitions(options),
      createAnthropicStructuredOutputTool(schemaOptions),
    ],
    tool_choice:
      toolChoice === 'force'
        ? { type: 'tool', name: toolName }
        : (mapAnthropicToolChoice(options) ?? { type: 'auto' }),
  };
}

export function createAnthropicStructuredOutputTool(
  schemaOptions: SchemaGenerationOptions,
) {
  return {
    name: schemaOptions.functionName ?? 'generateStructuredOutput',
    description: 'Generate structured output according to the JSON schema.',
    input_schema: zodToJsonSchema(schemaOptions.schema),
  };
}

async function createAnthropicMessage(
  client: Anthropic,
  messages: unknown[],
  system: unknown,
  session: Session<any, any>,
  options: LLMOptions & { provider: AnthropicProviderConfig },
  tools: readonly PromptTrailTool[],
  toolDefinitions: readonly unknown[],
) {
  return client.messages.create(
    {
      model: options.provider.modelName,
      max_tokens: options.maxTokens ?? 1024,
      messages: messages as any,
      system,
      temperature: options.temperature,
      top_p: options.topP,
      thinking: mapAnthropicThinking(
        options.thinking,
        options.toolChoice,
      ) as any,
      context_management: mapAnthropicCompaction(options.compaction) as any,
      container: getAnthropicSkillsContainer(options),
      tools: toolDefinitions.length > 0 ? (toolDefinitions as any) : undefined,
      tool_choice: mapAnthropicToolChoice(options) as any,
    } as any,
    getAnthropicRequestOptions(options) as any,
  );
}

export function convertSessionToAnthropicMessages(
  session: Session<any, any>,
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const message of session.messages) {
    if (message.type === 'user' || message.type === 'assistant') {
      messages.push({
        role: message.type,
        content: convertMessageToAnthropicContent(message),
      });
      continue;
    }

    if (message.type === 'tool_result') {
      const block = convertToolResultToAnthropicBlock(message);
      if (!block) {
        continue;
      }
      const previous = messages[messages.length - 1];
      if (previous?.role === 'user' && Array.isArray(previous.content)) {
        previous.content.push(block);
      } else {
        messages.push({ role: 'user', content: [block] });
      }
    }
  }
  return messages;
}

function convertMessageToAnthropicContent(message: Message<any>): unknown {
  const baseContent = message.contentParts
    ? contentPartsToAnthropicContent(message.contentParts)
    : message.content;
  if (message.type !== 'assistant') {
    return applyAnthropicCacheControl(baseContent, message.cache);
  }

  const replayRequired = getAnthropicReplayRequiredContentBlocks(message);
  const toolUseBlocks = (message.toolCalls ?? []).map((call) => ({
    type: 'tool_use',
    id: call.id,
    name: call.name,
    input: call.arguments,
  }));
  if (replayRequired.length === 0 && toolUseBlocks.length === 0) {
    return applyAnthropicCacheControl(baseContent, message.cache);
  }

  const contentBlocks = [
    ...replayRequired,
    ...(Array.isArray(baseContent)
      ? baseContent
      : typeof baseContent === 'string' && baseContent.trim() === ''
        ? []
        : [{ type: 'text', text: baseContent }]),
    ...toolUseBlocks,
  ];
  return applyAnthropicCacheControl(contentBlocks, message.cache);
}

function convertToolResultToAnthropicBlock(
  message: Message<any>,
): Record<string, unknown> | undefined {
  const callId = getToolResultCallId(message);
  if (!callId) {
    return undefined;
  }
  return {
    type: 'tool_result',
    tool_use_id: callId,
    content: message.content,
  };
}

function getToolResultCallId(message: Message<any>): string | undefined {
  const attrs = message.attrs as Record<string, unknown> | undefined;
  return typeof attrs?.toolCallId === 'string' ? attrs.toolCallId : undefined;
}

function getAnthropicReplayRequiredContentBlocks(
  message: Message<any>,
): unknown[] {
  const attrs = message.attrs as Record<string, unknown> | undefined;
  const anthropic = attrs?.anthropic as Record<string, unknown> | undefined;
  const replayRequired = anthropic?.replayRequired;
  if (!Array.isArray(replayRequired)) {
    return [];
  }

  return replayRequired.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    return record.provider === 'anthropic' && record.artifact
      ? [record.artifact]
      : [];
  });
}

export function getAnthropicRequestContent(
  session: Session<any, any>,
  options?: Pick<LLMOptions, 'capabilities' | 'skillInjection'>,
): AnthropicRequestContent {
  return limitAnthropicCacheControlBreakpoints({
    messages: convertSessionToAnthropicMessages(session),
    system: getAnthropicSystemPrompt(session, options),
  });
}

export function limitAnthropicCacheControlBreakpoints<T>(
  content: T,
  maxBreakpoints = 4,
): T {
  const breakpoints: Array<{
    block: Record<string, unknown>;
    priority: number;
    order: number;
  }> = [];
  collectAnthropicCacheControlBreakpoints(content, breakpoints);
  if (breakpoints.length <= maxBreakpoints) {
    return content;
  }

  const keep = new Set(
    breakpoints
      .slice()
      .sort(
        (left, right) =>
          right.priority - left.priority || left.order - right.order,
      )
      .slice(0, maxBreakpoints)
      .map((breakpoint) => breakpoint.block),
  );

  for (const breakpoint of breakpoints) {
    if (!keep.has(breakpoint.block)) {
      delete breakpoint.block.cache_control;
    }
  }

  return content;
}

function collectAnthropicCacheControlBreakpoints(
  value: unknown,
  breakpoints: Array<{
    block: Record<string, unknown>;
    priority: number;
    order: number;
  }>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAnthropicCacheControlBreakpoints(item, breakpoints);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  if (record.cache_control && typeof record.cache_control === 'object') {
    breakpoints.push({
      block: record,
      priority: anthropicCacheControlPriority(record.cache_control),
      order: breakpoints.length,
    });
  }
  for (const child of Object.values(record)) {
    collectAnthropicCacheControlBreakpoints(child, breakpoints);
  }
}

function anthropicCacheControlPriority(cacheControl: unknown): number {
  const ttl = (cacheControl as Record<string, unknown>).ttl;
  if (ttl === '1h') {
    return 2;
  }
  if (ttl === '5m') {
    return 1;
  }
  return 0;
}

export function getAnthropicSystemPrompt(
  session: Session<any, any>,
  options?: Pick<LLMOptions, 'capabilities' | 'skillInjection'>,
): unknown {
  const systemMessages = session.messages.filter(
    (message) => message.type === 'system',
  );
  const system = systemMessages.some((message) => message.cache)
    ? systemMessages.map((message) =>
        applyAnthropicCacheControl(message.content, message.cache),
      )
    : systemMessages.map((message) => message.content).join('\n\n');
  const injected = appendSkillInstructions(
    typeof system === 'string' && system ? system : undefined,
    getAnthropicInstructionCapabilities(options?.capabilities),
    options?.skillInjection ?? 'warn',
  );
  warnSkillInstructionLoss(injected.warnings);
  if (Array.isArray(system)) {
    return [
      ...system.flatMap((content) => (Array.isArray(content) ? content : [])),
      ...(injected.instructions
        ? [{ type: 'text', text: injected.instructions }]
        : []),
    ];
  }
  return injected.instructions || undefined;
}

function getAnthropicInstructionCapabilities(
  capabilities: CapabilitySet | undefined,
): CapabilitySet | undefined {
  return capabilities?.filter(
    (capability) =>
      capability.kind !== 'skill' || typeof capability.skillId !== 'string',
  );
}

export function getAnthropicPromptTrailTools(
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

export function getAnthropicToolDefinitions(
  options: Pick<LLMOptions, 'capabilities' | 'tools'>,
): unknown[] {
  const nativeSkills = getAnthropicNativeSkills(options.capabilities);
  return [
    ...getAnthropicPromptTrailTools(options).map(
      promptTrailToolToAnthropicTool,
    ),
    ...(nativeSkills.length > 0
      ? [{ type: 'code_execution_20250825', name: 'code_execution' }]
      : []),
    ...(options.capabilities ?? []).flatMap((capability) =>
      capability.kind === 'builtin'
        ? promptTrailBuiltinToAnthropicTool(capability)
        : [],
    ),
  ];
}

export function getAnthropicConfiguredCapabilities(
  capabilities: CapabilitySet | undefined,
): CapabilitySet {
  return (capabilities ?? []).filter(
    (capability) => capability.kind === 'builtin',
  );
}

export function getAnthropicToolLoopContinuationOptions<T extends LLMOptions>(
  options: T,
): T {
  return options.toolChoice === 'required'
    ? { ...options, toolChoice: 'auto' }
    : options;
}

export function getAnthropicNativeSkills(
  capabilities: LLMOptions['capabilities'],
): RuntimeSkill[] {
  return (capabilities ?? []).filter(
    (capability): capability is RuntimeSkill =>
      capability.kind === 'skill' && typeof capability.skillId === 'string',
  );
}

export function getAnthropicSkillsContainer(
  options: Pick<LLMOptions, 'capabilities'>,
): Record<string, unknown> | undefined {
  const skills = getAnthropicNativeSkills(options.capabilities).map(
    promptTrailSkillToAnthropicContainerSkill,
  );
  return skills.length > 0 ? { skills } : undefined;
}

export function promptTrailSkillToAnthropicContainerSkill(
  skill: RuntimeSkill,
): Record<string, unknown> {
  const source =
    typeof skill.metadata?.source === 'string'
      ? skill.metadata.source
      : skill.skillId?.startsWith('skill_')
        ? 'custom'
        : 'anthropic';
  return {
    type: source,
    skill_id: skill.skillId,
    version:
      typeof skill.metadata?.version === 'string'
        ? skill.metadata.version
        : 'latest',
  };
}

export function getAnthropicRequestOptions(
  options: Pick<LLMOptions, 'capabilities'>,
): Record<string, unknown> | undefined {
  if (getAnthropicNativeSkills(options.capabilities).length === 0) {
    return undefined;
  }

  return {
    headers: {
      'anthropic-beta': ANTHROPIC_SKILLS_INVOCATION_BETA,
    },
  };
}

export async function resolveAnthropicRuntimeCapabilities(
  session: Session<any, any>,
  options: LLMOptions & { provider: AnthropicProviderConfig },
  uploadClient: AnthropicSkillUploadClient = new AnthropicSkillsHttpClient({
    apiKey: options.provider.apiKey,
    baseURL: options.provider.baseURL,
  }),
): Promise<LLMOptions & { provider: AnthropicProviderConfig }> {
  const capabilities = await uploadAnthropicTemporarySkills({
    capabilities: options.capabilities,
    approvalHandler: options.approvalHandler,
    session,
    uploadClient,
  });
  return capabilities === options.capabilities
    ? options
    : { ...options, capabilities };
}

export async function uploadAnthropicTemporarySkills(options: {
  capabilities: CapabilitySet | undefined;
  approvalHandler: ApprovalHandler | undefined;
  session: Session<any, any>;
  uploadClient: AnthropicSkillUploadClient;
}): Promise<CapabilitySet | undefined> {
  const skills = (options.capabilities ?? []).filter(
    (capability): capability is RuntimeSkill =>
      capability.kind === 'skill' &&
      capability.materialize === 'temporary' &&
      typeof capability.skillId !== 'string',
  );
  if (skills.length === 0) {
    return options.capabilities;
  }
  if (!options.approvalHandler) {
    throw new Error('Anthropic skill upload requires an approvalHandler.');
  }

  const uploaded = new Map<RuntimeSkill, RuntimeSkill>();
  for (const skill of skills) {
    const decision = await options.approvalHandler(
      {
        provider: 'anthropic',
        action: 'uploadSkill',
        capability: skill.name,
        risk: 'external',
        input: {
          endpoint: '/v1/skills',
          skill,
        },
      },
      options.session,
    );
    if (decision.type === 'deny') {
      throw new Error(
        `Anthropic skill upload denied${decision.reason ? `: ${decision.reason}` : ''}`,
      );
    }
    if (decision.type === 'ask-user') {
      throw new Error(decision.question);
    }

    const result = await options.uploadClient.uploadSkill(skill);
    uploaded.set(skill, {
      ...skill,
      skillId: result.skillId,
      metadata: {
        ...skill.metadata,
        source: 'custom',
        ...(result.version ? { version: result.version } : {}),
        upload: result.raw,
      },
    });
  }

  return (options.capabilities ?? []).map(
    (capability) => uploaded.get(capability as RuntimeSkill) ?? capability,
  );
}

export function renderAnthropicSkillMarkdown(skill: RuntimeSkill): string {
  const lines = [
    `# ${skill.name}`,
    '',
    skill.description,
    '',
    '## Instructions',
    '',
    skill.instructions || '',
    '',
  ];
  return lines.filter((line) => line !== undefined).join('\n');
}

export function sanitizeAnthropicSkillDirectoryName(name: string): string {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) {
    throw new Error('Anthropic skill name cannot be empty.');
  }
  return sanitized;
}

export function promptTrailToolToAnthropicTool(tool: PromptTrailTool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema),
  };
}

export function promptTrailBuiltinToAnthropicTool(
  tool: BuiltinTool,
): Record<string, unknown> {
  return {
    type: tool.name,
    name: tool.name,
    ...(tool.config ?? {}),
  };
}

export function collectAnthropicToolUses(
  content: unknown[],
): AnthropicToolUse[] {
  return content
    .filter(
      (block): block is Record<string, unknown> =>
        !!block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'tool_use',
    )
    .map((block) => ({
      id: String(block.id),
      name: String(block.name),
      input: block.input ?? {},
      raw: block,
    }));
}

export async function createAnthropicToolResultBlock(
  toolUse: AnthropicToolUse,
  tools: readonly PromptTrailTool[],
  session: Session<any, any>,
  approvalHandler?: ApprovalHandler,
) {
  const tool = tools.find((candidate) => candidate.name === toolUse.name);
  if (!tool) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      is_error: true,
      content: `Unknown tool: ${toolUse.name}`,
    };
  }

  const result = await executePromptTrailTool(tool, toolUse.input, {
    session,
    provider: 'anthropic',
    approvalHandler,
    raw: toolUse.raw,
  });
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    is_error: result.isError,
    content: JSON.stringify(result),
  };
}

export function retainAnthropicMessageMetadata(
  response: {
    id: string;
    stop_reason?: string | null;
    model?: string;
    usage?: unknown;
    content?: unknown[];
  },
  retain: RetainLevel,
): Record<string, unknown> {
  const base = {
    provider: 'anthropic',
    api: 'messages',
    responseId: response.id,
    stopReason: response.stop_reason,
    model: response.model,
    replayRequired: extractAnthropicReplayRequiredArtifacts(response.content),
  };
  if (retain === 'none') {
    return base;
  }
  if (retain === 'full') {
    return {
      ...base,
      usage: response.usage,
      content: response.content,
      raw: response,
    };
  }
  return {
    ...base,
    usage: response.usage,
    content: response.content?.map((block) => summarizeAnthropicContent(block)),
  };
}

function extractAnthropicText(content: unknown[]): string {
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return '';
      }
      const record = block as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string'
        ? record.text
        : '';
    })
    .join('');
}

function summarizeAnthropicContent(block: unknown): Record<string, unknown> {
  if (!block || typeof block !== 'object') {
    return { type: typeof block, preview: String(block) };
  }
  const record = block as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text : undefined;
  return {
    type: record.type,
    id: record.id,
    name: record.name,
    preview: text && text.length > 500 ? text.slice(0, 500) : text,
    truncated: text && text.length > 500 ? true : undefined,
    fullLength: text && text.length > 500 ? text.length : undefined,
  };
}

export function mapAnthropicToolChoice(
  options: Pick<LLMOptions, 'toolChoice' | 'anthropic'>,
) {
  if (options.anthropic?.toolChoice) {
    return options.anthropic.toolChoice;
  }
  const choice = options.toolChoice;
  if (choice === 'required') {
    return { type: 'any' };
  }
  if (choice === 'none') {
    return { type: 'none' };
  }
  if (choice === 'auto') {
    return { type: 'auto' };
  }
  return undefined;
}
