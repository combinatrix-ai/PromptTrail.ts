import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai';
import type { BuiltinTool, PromptTrailTool } from './capabilities';
import { contentPartsToGeminiParts } from './content_parts';
import {
  deriveConversationBinding,
  getMessagesAfterBinding,
  type ConversationBinding,
} from './conversation';
import { mapGeminiThinkingConfig } from './generation_options';
import { zodToJsonSchema } from './json_schema';
import type {
  GoogleProviderConfig,
  LLMOptions,
  SchemaGenerationOptions,
} from './llm_types';
import type { Message } from './message';
import { geminiStreamEventToPromptTrailEvents } from './provider_stream';
import { extractGeminiReplayRequiredArtifacts } from './replay_pins';
import type { RetainLevel } from './runtime';
import type { Attrs, Session, Vars } from './session';
import { appendSkillInstructions, warnSkillInstructionLoss } from './skills';
import { executePromptTrailTool, isPromptTrailTool } from './tool';

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args: unknown;
  raw: unknown;
}

export async function generateGoogleGeminiText<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: GoogleProviderConfig },
): Promise<Message<TAttrs>> {
  return generateGoogleGeminiMessage(session, options);
}

export async function* streamGoogleGeminiEvents<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: GoogleProviderConfig },
) {
  const ai = new GoogleGenAI({ apiKey: options.provider.apiKey });
  const tools = getGeminiPromptTrailTools(options);
  const toolDefinitions = getGeminiToolDefinitions(options);
  const binding =
    options.conversationBinding === 'auto'
      ? deriveConversationBinding(session, 'google')
      : undefined;
  const contents = convertMessagesToGeminiContents(
    getMessagesAfterBinding(session, binding),
  );
  const stream = await ai.models.generateContentStream({
    model: options.provider.modelName,
    contents: contents as any,
    config: buildGeminiGenerationConfig(
      session,
      options,
      tools,
      toolDefinitions,
      binding,
    ) as any,
  });

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

export async function generateGoogleGeminiWithSchema<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: GoogleProviderConfig },
  schemaOptions: SchemaGenerationOptions,
): Promise<Message<TAttrs> & { structuredOutput?: unknown }> {
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
    responseJsonSchema: zodToJsonSchema(schemaOptions.schema),
  };
}

async function generateGoogleGeminiMessage<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: GoogleProviderConfig },
  extraConfig: Record<string, unknown> = {},
): Promise<Message<TAttrs>> {
  const ai = new GoogleGenAI({ apiKey: options.provider.apiKey });
  const tools = getGeminiPromptTrailTools(options);
  const toolDefinitions = getGeminiToolDefinitions(options);
  const binding =
    options.conversationBinding === 'auto'
      ? deriveConversationBinding(session, 'google')
      : undefined;
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
    extraConfig,
  );

  for (let i = 0; i < (options.maxCallLimit ?? 10); i++) {
    const functionCalls = collectGeminiFunctionCalls(response);
    if (functionCalls.length === 0) {
      break;
    }

    const responseParts = await Promise.all(
      functionCalls.map((call) =>
        createGeminiFunctionResponsePart(call, tools, session),
      ),
    );
    contents = [
      ...contents,
      {
        role: 'model',
        parts: functionCalls.map((call) => ({ functionCall: call.raw })),
      },
      { role: 'user', parts: responseParts },
    ];
    response = await createGeminiContent(
      ai,
      contents,
      session,
      options,
      tools,
      toolDefinitions,
      binding,
      extraConfig,
    );
  }

  return {
    type: 'assistant',
    content: getGeminiText(response) || ' ',
    attrs: {
      google: retainGeminiResponseMetadata(
        response,
        options.retain ?? 'summary',
      ),
    } as unknown as TAttrs,
  };
}

async function createGeminiContent(
  ai: GoogleGenAI,
  contents: unknown[],
  session: Session<any, any>,
  options: LLMOptions & { provider: GoogleProviderConfig },
  tools: readonly PromptTrailTool[],
  toolDefinitions: readonly unknown[],
  binding?: ConversationBinding,
  extraConfig: Record<string, unknown> = {},
) {
  return ai.models.generateContent({
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
  });
}

export function buildGeminiGenerationConfig(
  session: Session<any, any>,
  options: LLMOptions & { provider: GoogleProviderConfig },
  tools: readonly PromptTrailTool[],
  toolDefinitions: readonly unknown[],
  binding?: ConversationBinding,
  extraConfig: Record<string, unknown> = {},
): Record<string, unknown> {
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

export function convertSessionToGeminiContents(
  session: Session<any, any>,
): Array<{ role: 'user' | 'model'; parts: unknown[] }> {
  return convertMessagesToGeminiContents(session.messages);
}

export function convertMessagesToGeminiContents(
  messages: readonly Message<any>[],
): Array<{ role: 'user' | 'model'; parts: unknown[] }> {
  return messages
    .filter(
      (message) => message.type === 'user' || message.type === 'assistant',
    )
    .map((message) => ({
      role: message.type === 'assistant' ? 'model' : 'user',
      parts: message.contentParts
        ? contentPartsToGeminiParts(message.contentParts)
        : [{ text: message.content }],
    }));
}

export function getGeminiSystemInstruction(
  session: Session<any, any>,
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
      raw: call,
    }));
}

export async function createGeminiFunctionResponsePart(
  call: GeminiFunctionCall,
  tools: readonly PromptTrailTool[],
  session: Session<any, any>,
) {
  const tool = tools.find((candidate) => candidate.name === call.name);
  const result = tool
    ? await executePromptTrailTool(tool, call.args, {
        session,
        provider: 'google',
        raw: call.raw,
      })
    : {
        content: [{ type: 'text', text: `Unknown tool: ${call.name}` }],
        isError: true,
      };

  return {
    functionResponse: {
      id: call.id ?? call.name,
      name: call.name,
      response: result,
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
