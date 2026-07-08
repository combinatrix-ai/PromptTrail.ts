// generate.ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  generateText as aiSdkGenerateText,
  streamText as aiSdkStreamText,
  LanguageModelV1,
  Output,
} from 'ai';
import {
  generateAnthropicMessagesText,
  generateAnthropicMessagesWithSchema,
  streamAnthropicMessagesEvents,
} from './anthropic_messages';
import {
  generateGoogleGeminiText,
  generateGoogleGeminiWithSchema,
  streamGoogleGeminiEvents,
} from './google_gemini';
import { normalizeSchemaGenerationMode } from './llm_types';
import type { LLMOptions, SchemaGenerationOptions } from './llm_types';
import type { Message } from './message';
import {
  generateOpenAIResponsesText,
  generateOpenAIResponsesWithSchema,
  streamOpenAIResponsesEvents,
} from './openai_responses';
import {
  createPromptTrailStreamState,
  reducePromptTrailStreamEvent,
  retainPromptTrailStreamMetadata,
  streamStateToAssistantMessage,
  type PromptTrailStreamEvent,
} from './stream';
import { contentPartsToAiSdkContent } from './content_parts';
import type { Session, Vars } from './session';
import { appendSkillInstructions, warnSkillInstructionLoss } from './skills';
import { toAiSdkToolSet } from './ai_sdk_tools';
import { Tool, executePromptTrailTool, isPromptTrailTool } from './tool';
import type { PromptTrailTool } from './capabilities';
import {
  runRuntimeMiddlewareWrapper,
  runRuntimeExecutionPhase,
  type ExecutionRuntimeState,
} from './interceptors';
import type { ExecutionEvent, ResolvedExecutionCommand } from './execution';
export type { SchemaGenerationOptions } from './llm_types';

/**
 * Convert Session to AI SDK compatible format
 */
export function convertSessionToAiSdkMessages(
  session: Session<any>,
  options?: Pick<LLMOptions, 'capabilities' | 'skillInjection'>,
): Array<{
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: Array<unknown>;
}> {
  const messages: Array<{
    role: string;
    content: unknown;
    tool_call_id?: string;
    tool_calls?: Array<unknown>;
  }> = [];

  // Build a map of tool results by their tool call ID for easy lookup
  const toolResultsMap = new Map<string, string>();
  for (const msg of session.messages) {
    if (msg.type === 'tool_result') {
      if (msg.toolCallId) {
        toolResultsMap.set(msg.toolCallId, msg.content);
      }
    }
  }

  const skillInjection = appendSkillInstructions(
    undefined,
    options?.capabilities,
    options?.skillInjection ?? 'warn',
  );
  warnSkillInstructionLoss(skillInjection.warnings);
  if (skillInjection.instructions) {
    messages.push({ role: 'system', content: skillInjection.instructions });
  }

  // Process messages in order, but handle tool results immediately after their assistant message
  for (const msg of session.messages) {
    if (msg.type === 'system') {
      messages.push({ role: 'system', content: msg.content });
    } else if (msg.type === 'user') {
      messages.push({
        role: 'user',
        content: msg.contentParts
          ? contentPartsToAiSdkContent(msg.contentParts)
          : msg.content,
      });
    } else if (msg.type === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // ai-sdk CoreMessages carry tool calls/results as typed content
        // parts, not OpenAI-style tool_calls/tool_call_id fields — the
        // string form fails ai-sdk's prompt validation on the next turn.
        const parts: unknown[] = [];
        const text = msg.contentParts
          ? contentPartsToAiSdkContent(msg.contentParts)
          : msg.content;
        if (Array.isArray(text)) {
          parts.push(...text);
        } else if (typeof text === 'string' && text.trim()) {
          parts.push({ type: 'text', text });
        }
        for (const toolCall of msg.toolCalls) {
          parts.push({
            type: 'tool-call',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.arguments,
          });
        }
        messages.push({ role: 'assistant', content: parts });

        const resultParts: unknown[] = [];
        for (const toolCall of msg.toolCalls) {
          const toolResult = toolResultsMap.get(toolCall.id);
          if (toolResult !== undefined) {
            resultParts.push({
              type: 'tool-result',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: parseToolResultContent(toolResult),
            });
          }
        }
        if (resultParts.length > 0) {
          messages.push({ role: 'tool', content: resultParts });
        }
      } else {
        messages.push({
          role: 'assistant',
          content: msg.contentParts
            ? contentPartsToAiSdkContent(msg.contentParts)
            : msg.content || ' ', // Ensure content is never empty for Anthropic compatibility
        });
      }
    }
    // Skip tool_result messages as they're handled above
  }

  return messages;
}

function parseToolResultContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * Create a provider based on the LLMOptions
 */
export function createProvider(options: LLMOptions): LanguageModelV1 {
  const providerConfig = options.provider;
  const sdkProviderOptions: Record<string, unknown> = {}; // Options specifically for createOpenAI/createAnthropic

  if (providerConfig.type === 'openai') {
    if (providerConfig.baseURL) {
      sdkProviderOptions.baseURL = providerConfig.baseURL;
    }
    if (providerConfig.organization) {
      sdkProviderOptions.organization = providerConfig.organization;
    }
    sdkProviderOptions.apiKey = providerConfig.apiKey;
    // Pass browser flag if set
    if (options.dangerouslyAllowBrowser) {
      sdkProviderOptions.dangerouslyAllowBrowser = true;
    }

    const openai = createOpenAI(sdkProviderOptions);
    return providerConfig.api === 'responses'
      ? openai.responses(providerConfig.modelName)
      : openai(providerConfig.modelName);
  } else if (providerConfig.type === 'anthropic') {
    if (providerConfig.baseURL) {
      sdkProviderOptions.baseURL = providerConfig.baseURL;
    }
    sdkProviderOptions.apiKey = providerConfig.apiKey;
    // Pass browser flag if set (Anthropic might support this too)
    if (options.dangerouslyAllowBrowser) {
      sdkProviderOptions.dangerouslyAllowBrowser = true;
    }

    const anthropic = createAnthropic(sdkProviderOptions);
    return anthropic(providerConfig.modelName);
  } else if (providerConfig.type === 'google') {
    const googleSdkOptions: {
      apiKey?: string;
      baseURL?: string;
      dangerouslyAllowBrowser?: boolean;
    } = {};
    if (providerConfig.apiKey) {
      googleSdkOptions.apiKey = providerConfig.apiKey;
    }
    if (providerConfig.baseURL) {
      googleSdkOptions.baseURL = providerConfig.baseURL;
    }
    // Note: Check if @ai-sdk/google's createGoogleGenerativeAI supports dangerouslyAllowBrowser.
    // The documentation for @ai-sdk/google didn't explicitly list it for createGoogleGenerativeAI.
    // For now, assuming it might be a common option or handled by the core AI SDK.
    // If it causes issues, it should be removed for the Google provider.
    if (options.dangerouslyAllowBrowser) {
      // googleSdkOptions.dangerouslyAllowBrowser = true; // Temporarily commenting out until confirmed
    }

    const googleProvider = createGoogleGenerativeAI(googleSdkOptions);
    return googleProvider(providerConfig.modelName);
  }

  throw new Error(
    `Unsupported provider type: ${(providerConfig as { type: string }).type}`,
  );
}

/**
 * Generate text using AI SDK
 * This is our main adapter function that maps our stable interface to the current AI SDK
 */
export async function generateText<TVars extends Vars>(
  session: Session<TVars>,
  options: LLMOptions,
): Promise<Message> {
  if (
    options.provider.type === 'openai' &&
    options.provider.api === 'responses' &&
    options.provider.adapter !== 'ai-sdk'
  ) {
    return generateOpenAIResponsesText(session, {
      ...options,
      provider: options.provider,
    });
  }

  if (
    options.provider.type === 'anthropic' &&
    options.provider.adapter !== 'ai-sdk'
  ) {
    return generateAnthropicMessagesText(session, {
      ...options,
      provider: options.provider,
    });
  }

  if (
    options.provider.type === 'google' &&
    options.provider.adapter !== 'ai-sdk'
  ) {
    return generateGoogleGeminiText(session, {
      ...options,
      provider: options.provider,
    });
  }

  // Convert session to AI SDK message format
  const messages = convertSessionToAiSdkMessages(session, options);

  // Create the provider
  const provider = createProvider(options);

  // Generate text using AI SDK
  const result = await aiSdkGenerateText({
    model: provider as LanguageModelV1,
    messages: messages as [],
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    tools: toAiSdkToolSet(options.tools, {
      session,
      services: options.services,
      approvalHandler: options.approvalHandler,
    }),
    toolChoice: options.toolChoice,
    providerOptions: options.aiSdk?.providerOptions as any,
    ...options.aiSdk?.sdkOptions,
  });

  // If there are tool calls, add them directly to the message
  if (result.toolCalls && result.toolCalls.length > 0) {
    const formattedToolCalls = result.toolCalls.map(
      (tc: {
        toolName?: string;
        name?: string;
        args?: Record<string, unknown>;
        arguments?: Record<string, unknown>;
        toolCallId?: string;
        id?: string;
      }) => ({
        name: tc.toolName || tc.name || '',
        arguments: tc.args || tc.arguments || {},
        id: tc.toolCallId || tc.id || crypto.randomUUID(),
      }),
    );

    // Ensure content is never empty for Anthropic compatibility
    const content = result.text || ' ';

    return {
      type: 'assistant',
      content: content,
      toolCalls: formattedToolCalls,
      toolResults: result.toolResults, // Include tool results from ai-sdk
    } as any;
  }

  return {
    type: 'assistant',
    content: result.text || ' ', // Ensure content is never empty for Anthropic compatibility
  };
}

/**
 * Generate structured content using schema
 */
export async function generateWithSchema<TVars extends Vars>(
  session: Session<TVars>,
  options: LLMOptions,
  schemaOptions: SchemaGenerationOptions,
): Promise<Message & { structuredOutput?: unknown }> {
  const schemaMode = normalizeSchemaGenerationMode(schemaOptions.mode);
  assertExplicitNativeSchemaModeWhenToolsArePresent(options, schemaOptions);

  if (
    options.provider.type === 'openai' &&
    options.provider.api === 'responses' &&
    options.provider.adapter !== 'ai-sdk' &&
    schemaMode === 'native'
  ) {
    return generateOpenAIResponsesWithSchema(
      session,
      {
        ...options,
        provider: options.provider,
      },
      schemaOptions,
    );
  }

  if (
    options.provider.type === 'anthropic' &&
    options.provider.adapter !== 'ai-sdk'
  ) {
    return generateAnthropicMessagesWithSchema(
      session,
      {
        ...options,
        provider: options.provider,
      },
      schemaOptions,
    );
  }

  if (
    options.provider.type === 'google' &&
    options.provider.adapter !== 'ai-sdk'
  ) {
    return generateGoogleGeminiWithSchema(
      session,
      {
        ...options,
        provider: options.provider,
      },
      schemaOptions,
    );
  }

  const messages = convertSessionToAiSdkMessages(session, options);
  const provider = createProvider(options);

  if (schemaMode === 'native') {
    // Use AI SDK's experimental_output for structured generation
    const result = await aiSdkGenerateText({
      model: provider as LanguageModelV1,
      messages: messages as [],
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      topP: options.topP,
      topK: options.topK,
      experimental_output: Output.object({
        schema: schemaOptions.schema,
      }),
      providerOptions: options.aiSdk?.providerOptions as any,
      ...options.aiSdk?.sdkOptions,
    });

    // Validate the structured output
    const parsedOutput = schemaOptions.schema.safeParse(
      result.experimental_output,
    );
    if (!parsedOutput.success) {
      throw new Error(
        `Schema validation failed: ${parsedOutput.error.message}`,
      );
    }

    return {
      type: 'assistant',
      content: JSON.stringify(parsedOutput.data, null, 2),
      structuredOutput: parsedOutput.data,
    };
  } else {
    // Use tool-based generation (existing SchemaSource logic)
    const functionName =
      schemaOptions.functionName || 'generateStructuredOutput';
    const toolOptions: LLMOptions = {
      ...options,
      tools: {
        ...options.tools,
        [functionName]: Tool.create({
          name: functionName,
          description: 'Generate structured output according to schema',
          inputSchema: schemaOptions.schema,
          effect: { repeatable: true },
          execute: (input) => input,
        }),
      },
      toolChoice: 'required',
    };

    const response = await generateText(session, toolOptions);

    if (response.toolCalls?.some((tc) => tc.name === functionName)) {
      const toolCall = response.toolCalls.find(
        (tc) => tc.name === functionName,
      );

      if (toolCall) {
        const result = schemaOptions.schema.safeParse(toolCall.arguments);
        if (result.success) {
          return {
            type: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
            structuredOutput: result.data,
          };
        } else {
          throw new Error(`Schema validation failed: ${result.error.message}`);
        }
      }
    }

    throw new Error('No valid schema tool call found in response');
  }
}

export function assertExplicitNativeSchemaModeWhenToolsArePresent(
  options: LLMOptions,
  schemaOptions: SchemaGenerationOptions,
): void {
  void options;
  void schemaOptions;
}

export function assertNativeStreamingToolLoopSupported(
  options: LLMOptions,
): void {
  void options;
}

/**
 * Generate text stream using AI SDK
 */
export async function* generateTextStream<TVars extends Vars>(
  session: Session<TVars>,
  options: LLMOptions,
  runtime?: ExecutionRuntimeState<TVars>,
): AsyncGenerator<Message, void, unknown> {
  assertNativeStreamingToolLoopSupported(options);

  if (
    options.provider.type === 'openai' &&
    options.provider.api === 'responses' &&
    options.provider.adapter !== 'ai-sdk'
  ) {
    const provider = options.provider;
    yield* streamPromptTrailToolLoop(session, options, {
      provider: 'openai',
      attrsKey: 'openai',
      runtime,
      events: (turnSession) =>
        streamOpenAIResponsesEvents(turnSession, {
          ...options,
          provider,
        }),
    });
    return;
  }

  if (
    options.provider.type === 'anthropic' &&
    options.provider.adapter !== 'ai-sdk'
  ) {
    const provider = options.provider;
    yield* streamPromptTrailToolLoop(session, options, {
      provider: 'anthropic',
      attrsKey: 'anthropic',
      runtime,
      events: (turnSession) =>
        streamAnthropicMessagesEvents(turnSession, {
          ...options,
          provider,
        }),
    });
    return;
  }

  if (
    options.provider.type === 'google' &&
    options.provider.adapter !== 'ai-sdk'
  ) {
    const provider = options.provider;
    yield* streamPromptTrailToolLoop(session, options, {
      provider: 'google',
      attrsKey: 'google',
      runtime,
      events: (turnSession) =>
        streamGoogleGeminiEvents(turnSession, {
          ...options,
          provider,
        }),
    });
    return;
  }

  // Convert session to AI SDK message format
  const messages = convertSessionToAiSdkMessages(session, options);

  // Create the provider
  const provider = createProvider(options);

  // Generate streaming text using AI SDK
  const stream = await aiSdkStreamText({
    model: provider as LanguageModelV1,
    messages: messages as [],
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    tools: toAiSdkToolSet(options.tools, {
      session,
      services: options.services,
      approvalHandler: options.approvalHandler,
    }),
    toolChoice: options.toolChoice,
    providerOptions: options.aiSdk?.providerOptions as any,
    ...options.aiSdk?.sdkOptions,
  });

  // Yield message chunks as they arrive
  for await (const chunk of stream.fullStream) {
    if (chunk.type === 'text-delta') {
      yield {
        type: 'assistant',
        content: chunk.textDelta || ' ', // Ensure content is never empty for Anthropic compatibility
      };
    } else if (chunk.type === 'tool-call') {
      // Add tool calls directly to the message
      const toolCall = {
        name: chunk.toolName,
        arguments: chunk.args || {},
        id: chunk.toolCallId || crypto.randomUUID(),
      };

      yield {
        type: 'assistant',
        content: ' ', // Ensure content is never empty for Anthropic compatibility
        toolCalls: [toolCall],
      };
    }
  }
}

export async function* streamPromptTrailToolLoop(
  session: Session<any>,
  options: LLMOptions,
  config: {
    provider: 'openai' | 'anthropic' | 'google';
    attrsKey: string;
    events: (session: Session<any>) => AsyncIterable<PromptTrailStreamEvent>;
    runtime?: ExecutionRuntimeState<any>;
  },
): AsyncGenerator<Message, void, unknown> {
  const maxToolRounds = options.maxCallLimit ?? 10;
  let currentSession = session;

  for (let round = 0; ; round++) {
    let state = createPromptTrailStreamState();
    for await (const event of config.events(currentSession)) {
      state = reducePromptTrailStreamEvent(state, event);
      if (event.type === 'text.delta') {
        yield {
          type: 'assistant',
          content: event.delta || ' ',
        } as Message;
      }
    }

    const assistant = streamStateToAssistantMessage(
      state,
      createStreamMessageAttrs(state, {
        attrsKey: config.attrsKey,
        retain: options.retain,
      }),
    );
    yield assistant;

    const toolCalls = assistant.toolCalls ?? [];
    if (toolCalls.length === 0 || round >= maxToolRounds) {
      return;
    }

    let nextSession = currentSession.addMessage(assistant);
    if (config.runtime) {
      for (const call of toolCalls) {
        const executed = await executeStreamingToolCallWithRuntime(call, {
          provider: config.provider,
          tools: getPromptTrailToolList(options),
          session: nextSession,
          approvalHandler: options.approvalHandler,
          services: config.runtime.services,
          runtime: config.runtime,
        });
        yield executed.message as Message;
        nextSession = executed.session.addMessage(executed.message as Message);
      }
    } else {
      const toolResults = await Promise.all(
        toolCalls.map((call) =>
          executeStreamingToolCall(call, {
            provider: config.provider,
            tools: getPromptTrailToolList(options),
            session: currentSession,
            approvalHandler: options.approvalHandler,
            services: options.services,
          }),
        ),
      );
      for (const result of toolResults) {
        yield result as Message;
        nextSession = nextSession.addMessage(result as Message);
      }
    }
    currentSession = nextSession;
  }
}

async function executeStreamingToolCallWithRuntime(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  options: {
    provider: 'openai' | 'anthropic' | 'google';
    tools: readonly PromptTrailTool[];
    session: Session<any>;
    approvalHandler?: LLMOptions['approvalHandler'];
    services?: Record<string, unknown>;
    runtime: ExecutionRuntimeState<any>;
  },
): Promise<{ message: Message; session: Session<any> }> {
  const before = await runRuntimeExecutionPhase(options.runtime, {
    phase: 'beforeTool',
    session: options.session,
    request: call,
  });
  assertStreamingToolCommandSupported(before.command);
  const nextCall =
    (before.request as
      | { id: string; name: string; arguments: Record<string, unknown> }
      | undefined) ?? call;
  const openToolEvents: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }> = [];
  const closeToolEvents = async (
    type: 'tool.completed' | 'tool.failed',
    request: { id: string; name: string; arguments: Record<string, unknown> },
    error?: unknown,
    result?: Message,
  ) => {
    if (openToolEvents.length === 0) {
      await emitStreamingToolEvent(
        options.runtime,
        type,
        request,
        error,
        result,
      );
      return;
    }
    while (openToolEvents.length > 0) {
      const startedRequest = openToolEvents.shift()!;
      await emitStreamingToolEvent(
        options.runtime,
        type,
        startedRequest,
        error,
        result,
      );
    }
  };

  let wrappedRequest = nextCall;
  try {
    const wrappedTool = await runRuntimeMiddlewareWrapper(options.runtime, {
      phase: 'wrapToolCall',
      session: before.session,
      request: nextCall,
      call: async ({ session, request }) => {
        if (
          await emitStreamingToolEvent(options.runtime, 'tool.started', request)
        ) {
          openToolEvents.push(request);
        }
        return executeStreamingToolCall(request, {
          provider: options.provider,
          tools: options.tools,
          session,
          approvalHandler: options.approvalHandler,
          services: options.services,
        }) as Promise<Message>;
      },
    });
    assertStreamingToolCommandSupported(wrappedTool.command);
    wrappedRequest = wrappedTool.request;
    const message = wrappedTool.result;
    const after = await runRuntimeExecutionPhase(options.runtime, {
      phase: 'afterTool',
      session: wrappedTool.session,
      request: wrappedRequest,
      result: message,
    });
    assertStreamingToolCommandSupported(after.command);
    const resultMessage = (after.result as Message | undefined) ?? message;
    await closeToolEvents(
      isToolResultErrorMessage(resultMessage)
        ? 'tool.failed'
        : 'tool.completed',
      wrappedRequest,
      undefined,
      resultMessage,
    );
    return {
      message: resultMessage,
      session: after.session,
    };
  } catch (error) {
    await closeToolEvents('tool.failed', wrappedRequest, error);
    throw error;
  }
}

async function executeStreamingToolCall(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  options: {
    provider: 'openai' | 'anthropic' | 'google';
    tools: readonly PromptTrailTool[];
    session: Session<any>;
    approvalHandler?: LLMOptions['approvalHandler'];
    services?: Record<string, unknown>;
  },
): Promise<Message> {
  const tool = options.tools.find((candidate) => candidate.name === call.name);
  const result = tool
    ? await executePromptTrailTool(tool, call.arguments, {
        session: options.session,
        services: options.services,
        provider: options.provider,
        capability: call.name,
        approvalHandler: options.approvalHandler,
        raw: call,
      })
    : {
        content: [
          { type: 'text' as const, text: `Unknown tool: ${call.name}` },
        ],
        isError: true,
      };
  return {
    type: 'tool_result',
    content: JSON.stringify(result),
    toolCallId: call.id,
    attrs: {
      toolCallName: call.name,
    },
  };
}

function assertStreamingToolCommandSupported(
  command: ResolvedExecutionCommand,
): void {
  if (command.type === 'none') {
    return;
  }
  throw new Error(
    `streamPromptTrailToolLoop does not support execution command ${command.type} yet.`,
  );
}

async function emitStreamingToolEvent(
  runtime: ExecutionRuntimeState<any>,
  type: 'tool.started' | 'tool.completed' | 'tool.failed',
  call: { id: string; name: string; arguments: Record<string, unknown> },
  error?: unknown,
  result?: Message,
): Promise<boolean> {
  if (!runtime.emitEvent || !runtime.nextEventSeq) {
    return false;
  }
  const seq = runtime.nextEventSeq();
  const event: ExecutionEvent = {
    id: `tool:${seq}`,
    type,
    at: new Date().toISOString(),
    seq,
    source: 'tool',
    stepId: call.id,
    idempotencyKey: `${call.id}:${type}`,
    raw: { call, result },
    toolCallId: call.id,
    name: call.name,
  };
  if (error !== undefined) {
    event.error = error;
  }
  await runtime.emitEvent(event);
  return true;
}

function isToolResultErrorMessage(message: Message): boolean {
  if (message.type !== 'tool_result' || typeof message.content !== 'string') {
    return false;
  }
  try {
    const result = JSON.parse(message.content) as unknown;
    return (
      typeof result === 'object' &&
      result !== null &&
      (result as Record<string, unknown>).isError === true
    );
  } catch {
    return false;
  }
}

function getPromptTrailToolList(options: LLMOptions): PromptTrailTool[] {
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

export async function* promptTrailStreamEventsToMessages(
  events: AsyncIterable<PromptTrailStreamEvent>,
  options: { attrsKey?: string; retain?: LLMOptions['retain'] } = {},
): AsyncGenerator<Message, void, unknown> {
  let state = createPromptTrailStreamState();
  for await (const event of events) {
    state = reducePromptTrailStreamEvent(state, event);
    if (event.type === 'text.delta') {
      yield {
        type: 'assistant',
        content: event.delta || ' ',
      } as Message;
    } else if (event.type === 'tool.args.done') {
      yield streamStateToAssistantMessage(
        state,
        createStreamMessageAttrs(state, options),
      );
    } else if (event.type === 'message.done') {
      yield streamStateToAssistantMessage(
        state,
        createStreamMessageAttrs(state, options),
      );
    }
  }
}

function createStreamMessageAttrs(
  state: ReturnType<typeof createPromptTrailStreamState>,
  options: { attrsKey?: string; retain?: LLMOptions['retain'] },
): Readonly<Record<string, unknown>> | undefined {
  if (!options.attrsKey) {
    return undefined;
  }
  return {
    [options.attrsKey]: retainPromptTrailStreamMetadata(
      state,
      options.retain ?? 'summary',
    ),
  };
}
