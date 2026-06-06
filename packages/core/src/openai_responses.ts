import OpenAI from 'openai';
import type { Message } from './message';
import type { Attrs, Session, Vars } from './session';
import type {
  LLMOptions,
  OpenAIProviderConfig,
  SchemaGenerationOptions,
} from './llm_types';
import type { RetainLevel } from './runtime';
import type {
  BuiltinTool,
  CapabilitySet,
  McpServer,
  PromptTrailTool,
  RuntimeSkill,
} from './capabilities';
import {
  deriveConversationBinding,
  getMessagesAfterBinding,
  type ConversationBinding,
} from './conversation';
import { contentPartsToOpenAIInput } from './content_parts';
import { mapOpenAIResponsesRequestOptions } from './generation_options';
import { zodToJsonSchema } from './json_schema';
import { extractOpenAIReplayRequiredArtifacts } from './replay_pins';
import { createOpenAIStreamNormalizer } from './provider_stream';
import { appendSkillInstructions, warnSkillInstructionLoss } from './skills';
import { executePromptTrailTool, isPromptTrailTool } from './tool';

export interface OpenAIResponsesFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export interface OpenAIResponsesFunctionCall {
  callId: string;
  name: string;
  arguments: unknown;
  raw: unknown;
}

export async function generateOpenAIResponsesText<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: OpenAIProviderConfig },
): Promise<Message<TAttrs>> {
  return generateOpenAIResponsesMessage(session, options);
}

export async function* streamOpenAIResponsesEvents<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: OpenAIProviderConfig },
  textFormat?: Record<string, unknown>,
) {
  const client = new OpenAI({
    apiKey: options.provider.apiKey,
    baseURL: options.provider.baseURL,
    organization: options.provider.organization,
    dangerouslyAllowBrowser:
      options.dangerouslyAllowBrowser ??
      options.provider.dangerouslyAllowBrowser,
  });
  const tools = getOpenAIPromptTrailTools(options);
  const toolDefinitions = getOpenAIResponsesToolDefinitions(options);
  const binding =
    options.conversationBinding === 'auto'
      ? deriveConversationBinding(session, 'openai')
      : undefined;
  const input: unknown[] = convertSessionToResponsesInput(session, binding);
  const instructions = getResponsesInstructions(session, options);
  const stream = await client.responses.create(
    buildOpenAIResponsesRequestBody(
      input,
      options,
      toolDefinitions,
      instructions,
      textFormat,
      binding,
      true,
    ) as any,
  );
  yield* normalizeOpenAIResponsesStream(
    stream as unknown as AsyncIterable<unknown>,
  );
}

export async function* normalizeOpenAIResponsesStream(
  stream: AsyncIterable<unknown>,
) {
  const normalizer = createOpenAIStreamNormalizer();
  for await (const event of stream as AsyncIterable<unknown>) {
    for (const normalized of normalizer.consume(event)) {
      yield normalized;
    }
  }
}

export async function generateOpenAIResponsesWithSchema<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: OpenAIProviderConfig },
  schemaOptions: SchemaGenerationOptions,
): Promise<Message<TAttrs> & { structuredOutput?: unknown }> {
  const message = await generateOpenAIResponsesMessage(session, options, {
    type: 'json_schema',
    name: schemaOptions.functionName ?? 'structured_output',
    schema: zodToJsonSchema(schemaOptions.schema, { openAiStrict: true }),
    strict: true,
  });
  const parsedOutput = schemaOptions.schema.safeParse(
    JSON.parse(message.content),
  );
  if (!parsedOutput.success) {
    throw new Error(`Schema validation failed: ${parsedOutput.error.message}`);
  }

  return {
    ...message,
    content: JSON.stringify(parsedOutput.data, null, 2),
    structuredOutput: parsedOutput.data,
  };
}

async function generateOpenAIResponsesMessage<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: OpenAIProviderConfig },
  textFormat?: Record<string, unknown>,
): Promise<Message<TAttrs>> {
  const client = new OpenAI({
    apiKey: options.provider.apiKey,
    baseURL: options.provider.baseURL,
    organization: options.provider.organization,
    dangerouslyAllowBrowser:
      options.dangerouslyAllowBrowser ??
      options.provider.dangerouslyAllowBrowser,
  });
  const tools = getOpenAIPromptTrailTools(options);
  const toolDefinitions = getOpenAIResponsesToolDefinitions(options);
  const binding =
    options.conversationBinding === 'auto'
      ? deriveConversationBinding(session, 'openai')
      : undefined;
  let input: unknown[] = convertSessionToResponsesInput(session, binding);
  const instructions = getResponsesInstructions(session, options);
  let response = await createOpenAIResponse(
    client,
    input,
    options,
    tools,
    toolDefinitions,
    instructions,
    textFormat,
    binding,
  );

  for (let i = 0; i < (options.maxCallLimit ?? 10); i++) {
    const functionCalls = collectOpenAIResponseFunctionCalls(response.output);
    if (functionCalls.length === 0) {
      break;
    }

    const toolOutputs = await Promise.all(
      functionCalls.map((call) =>
        createOpenAIToolOutputItem(call, tools, session),
      ),
    );
    input = [...input, ...(response.output as unknown[]), ...toolOutputs];
    response = await createOpenAIResponse(
      client,
      input,
      options,
      tools,
      toolDefinitions,
      instructions,
      textFormat,
      binding,
    );
  }

  return {
    type: 'assistant',
    content: response.output_text || ' ',
    attrs: {
      openai: retainOpenAIResponseMetadata(
        response,
        options.retain ?? 'summary',
      ),
    } as unknown as TAttrs,
  };
}

async function createOpenAIResponse(
  client: OpenAI,
  input: unknown[],
  options: LLMOptions & { provider: OpenAIProviderConfig },
  tools: readonly PromptTrailTool[],
  toolDefinitions: readonly unknown[],
  instructions: string | undefined,
  textFormat?: Record<string, unknown>,
  binding?: ConversationBinding,
) {
  return client.responses.create(
    buildOpenAIResponsesRequestBody(
      input,
      options,
      toolDefinitions,
      instructions,
      textFormat,
      binding,
    ) as any,
  );
}

export function buildOpenAIResponsesRequestBody(
  input: unknown[],
  options: LLMOptions & { provider: OpenAIProviderConfig },
  toolDefinitions: readonly unknown[],
  instructions: string | undefined,
  textFormat?: Record<string, unknown>,
  binding?: ConversationBinding,
  stream?: boolean,
): Record<string, unknown> {
  return {
    model: options.provider.modelName,
    input: input as any,
    instructions,
    previous_response_id: binding?.id,
    temperature: options.temperature,
    top_p: options.topP,
    max_output_tokens: options.maxTokens,
    text: textFormat ? { format: textFormat as any } : undefined,
    ...mapOpenAIResponsesRequestOptions(options),
    tools: toolDefinitions.length > 0 ? (toolDefinitions as any) : undefined,
    tool_choice: options.toolChoice as any,
    stream,
  };
}

export function convertSessionToResponsesInput(
  session: Session<any, any>,
  binding?: ConversationBinding,
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  return getMessagesAfterBinding(session, binding)
    .filter(
      (message) => message.type === 'user' || message.type === 'assistant',
    )
    .map((message) => ({
      role: message.type,
      content: message.contentParts
        ? contentPartsToOpenAIInput(message.contentParts)
        : message.content,
    }));
}

export function getResponsesInstructions(
  session: Session<any, any>,
  options?: Pick<LLMOptions, 'capabilities' | 'skillInjection'>,
): string | undefined {
  const instructions = session.messages
    .filter((message) => message.type === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const injected = appendSkillInstructions(
    instructions || undefined,
    getOpenAIInstructionCapabilities(options?.capabilities),
    options?.skillInjection ?? 'warn',
  );
  warnSkillInstructionLoss(injected.warnings);
  return injected.instructions || undefined;
}

export function getOpenAIPromptTrailTools(
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

export function getOpenAIResponsesToolDefinitions(
  options: Pick<LLMOptions, 'capabilities' | 'tools'>,
): unknown[] {
  const shellSkills = getOpenAIShellSkills(options.capabilities);
  return [
    ...getOpenAIPromptTrailTools(options).map(
      promptTrailToolToOpenAIResponsesTool,
    ),
    ...(options.capabilities ?? []).flatMap((capability) => {
      if (capability.kind === 'builtin') {
        return promptTrailBuiltinToOpenAIResponsesTool(capability, shellSkills);
      }
      if (capability.kind === 'mcp') {
        return promptTrailMcpToOpenAIResponsesTool(capability) ?? [];
      }
      return [];
    }),
  ];
}

export function promptTrailToolToOpenAIResponsesTool(
  tool: PromptTrailTool,
): OpenAIResponsesFunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.inputSchema, { openAiStrict: true }),
    strict: true,
  };
}

export function promptTrailBuiltinToOpenAIResponsesTool(
  tool: BuiltinTool,
  skills: readonly RuntimeSkill[] = [],
): Record<string, unknown> {
  if (isOpenAIShellBuiltin(tool) && skills.length > 0) {
    const config = tool.config ?? {};
    const currentEnvironment = isRecord(config.environment)
      ? config.environment
      : {};
    return {
      type: tool.name,
      ...config,
      environment: {
        ...currentEnvironment,
        skills: [
          ...(Array.isArray(currentEnvironment.skills)
            ? currentEnvironment.skills
            : []),
          ...skills.map(promptTrailSkillToOpenAIShellSkill),
        ],
      },
    };
  }

  return {
    type: tool.name,
    ...(tool.config ?? {}),
  };
}

export function getOpenAIShellSkills(
  capabilities: CapabilitySet | undefined,
): RuntimeSkill[] {
  const hasShell = (capabilities ?? []).some(
    (capability) =>
      capability.kind === 'builtin' && isOpenAIShellBuiltin(capability),
  );
  if (!hasShell) {
    return [];
  }

  return (capabilities ?? []).filter(
    (capability): capability is RuntimeSkill =>
      capability.kind === 'skill' &&
      (typeof capability.skillId === 'string' ||
        typeof capability.path === 'string'),
  );
}

export function promptTrailSkillToOpenAIShellSkill(
  skill: RuntimeSkill,
): Record<string, unknown> {
  if (isRecord(skill.metadata?.openai)) {
    return skill.metadata.openai;
  }
  if (skill.skillId) {
    return { id: skill.skillId, name: skill.name };
  }
  return { path: skill.path, name: skill.name };
}

export function getOpenAIInstructionCapabilities(
  capabilities: CapabilitySet | undefined,
): CapabilitySet | undefined {
  const mounted = new Set(
    getOpenAIShellSkills(capabilities).map((skill) => skill.name),
  );
  return capabilities?.filter(
    (capability) =>
      capability.kind !== 'skill' || !mounted.has(capability.name),
  );
}

function isOpenAIShellBuiltin(tool: BuiltinTool): boolean {
  return (
    tool.name === 'shell' ||
    tool.name === 'hosted_shell' ||
    tool.name === 'local_shell'
  );
}

export function promptTrailMcpToOpenAIResponsesTool(
  server: McpServer,
): Record<string, unknown> | undefined {
  if (server.transport.kind !== 'http') {
    return undefined;
  }

  return {
    type: 'mcp',
    server_label: server.name,
    server_url: server.transport.url,
    headers: server.transport.headers,
    allowed_tools: server.tools === 'all' ? undefined : server.tools,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function collectOpenAIResponseFunctionCalls(
  output: unknown[] | undefined,
): OpenAIResponsesFunctionCall[] {
  return (output ?? [])
    .filter(
      (item): item is Record<string, unknown> =>
        !!item &&
        typeof item === 'object' &&
        (item as Record<string, unknown>).type === 'function_call',
    )
    .map((item) => ({
      callId: String(item.call_id),
      name: String(item.name),
      arguments: parseFunctionCallArguments(item.arguments),
      raw: item,
    }));
}

export async function createOpenAIToolOutputItem(
  call: OpenAIResponsesFunctionCall,
  tools: readonly PromptTrailTool[],
  session: Session<any, any>,
): Promise<Record<string, unknown>> {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) {
    return {
      type: 'function_call_output',
      call_id: call.callId,
      output: JSON.stringify({
        content: [{ type: 'text', text: `Unknown tool: ${call.name}` }],
        isError: true,
      }),
    };
  }

  const result = await executePromptTrailTool(tool, call.arguments, {
    session,
    provider: 'openai',
    raw: call.raw,
  });
  return {
    type: 'function_call_output',
    call_id: call.callId,
    output: JSON.stringify(result),
  };
}

export function retainOpenAIResponseMetadata(
  response: {
    id: string;
    status?: string;
    output?: unknown[];
    usage?: unknown;
    error?: unknown;
    incomplete_details?: unknown;
  },
  retain: RetainLevel,
): Record<string, unknown> {
  const base = {
    provider: 'openai',
    api: 'responses',
    responseId: response.id,
    status: response.status,
    error: response.error ?? undefined,
    incompleteDetails: response.incomplete_details ?? undefined,
    replayRequired: extractOpenAIReplayRequiredArtifacts(response.output),
  };

  if (retain === 'none') {
    return base;
  }

  if (retain === 'full') {
    return {
      ...base,
      usage: response.usage,
      outputItems: response.output,
      raw: response,
    };
  }

  return {
    ...base,
    usage: response.usage,
    outputItems: response.output?.map((item) =>
      summarizeOpenAIOutputItem(item),
    ),
  };
}

function summarizeOpenAIOutputItem(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== 'object') {
    return { type: typeof item, preview: String(item) };
  }

  const record = item as Record<string, unknown>;
  const content = record.content;
  const preview =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(extractOutputContentPreview).join('')
        : undefined;

  return {
    type: record.type,
    id: record.id,
    status: record.status,
    preview: preview && preview.length > 500 ? preview.slice(0, 500) : preview,
    truncated: preview && preview.length > 500 ? true : undefined,
    fullLength: preview && preview.length > 500 ? preview.length : undefined,
  };
}

function extractOutputContentPreview(content: unknown): string {
  if (!content || typeof content !== 'object') {
    return '';
  }
  const record = content as Record<string, unknown>;
  return typeof record.text === 'string' ? record.text : '';
}

function parseFunctionCallArguments(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
