import Anthropic from '@anthropic-ai/sdk';
import { applyAnthropicCacheControl } from './cache';
import type {
  BuiltinTool,
  PromptTrailTool,
  RuntimeSkill,
} from './capabilities';
import { contentPartsToAnthropicContent } from './content_parts';
import {
  mapAnthropicCompaction,
  mapAnthropicThinking,
} from './generation_options';
import { zodToJsonSchema } from './json_schema';
import type {
  AnthropicProviderConfig,
  LLMOptions,
  SchemaGenerationOptions,
} from './llm_types';
import type { Message } from './message';
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

export async function generateAnthropicMessagesText<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: AnthropicProviderConfig },
): Promise<Message<TAttrs>> {
  const client = new Anthropic({
    apiKey: options.provider.apiKey,
    baseURL: options.provider.baseURL,
    dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
  });
  const tools = getAnthropicPromptTrailTools(options);
  const toolDefinitions = getAnthropicToolDefinitions(options);
  let messages: unknown[] = convertSessionToAnthropicMessages(session);
  let response = await createAnthropicMessage(
    client,
    messages,
    session,
    options,
    tools,
    toolDefinitions,
  );

  for (let i = 0; i < (options.maxCallLimit ?? 10); i++) {
    const toolUses = collectAnthropicToolUses(response.content);
    if (toolUses.length === 0) {
      break;
    }

    const toolResults = await Promise.all(
      toolUses.map((toolUse) =>
        createAnthropicToolResultBlock(toolUse, tools, session),
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
      session,
      options,
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
        options.retain ?? 'summary',
      ),
    } as unknown as TAttrs,
  };
}

export async function generateAnthropicMessagesWithSchema<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: AnthropicProviderConfig },
  schemaOptions: SchemaGenerationOptions,
): Promise<Message<TAttrs> & { structuredOutput?: unknown }> {
  const client = new Anthropic({
    apiKey: options.provider.apiKey,
    baseURL: options.provider.baseURL,
    dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
  });
  const toolName = schemaOptions.functionName ?? 'generateStructuredOutput';
  const structuredTool = createAnthropicStructuredOutputTool(schemaOptions);
  const response = await client.messages.create(
    {
      model: options.provider.modelName,
      max_tokens: options.maxTokens ?? 1024,
      messages: convertSessionToAnthropicMessages(session) as any,
      system: getAnthropicSystemPrompt(session, options),
      temperature: options.temperature,
      top_p: options.topP,
      thinking: mapAnthropicThinking(options.thinking, 'required') as any,
      context_management: mapAnthropicCompaction(options.compaction) as any,
      container: getAnthropicSkillsContainer(options),
      tools: [structuredTool as any],
      tool_choice: { type: 'tool', name: toolName } as any,
    } as any,
    getAnthropicRequestOptions(options) as any,
  );
  const toolUse = collectAnthropicToolUses(response.content).find(
    (candidate) => candidate.name === toolName,
  );
  if (!toolUse) {
    throw new Error(
      `Anthropic structured output tool was not called: ${toolName}`,
    );
  }

  const parsed = schemaOptions.schema.safeParse(toolUse.input);
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
        options.retain ?? 'summary',
      ),
    } as unknown as TAttrs,
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
      system: getAnthropicSystemPrompt(session, options),
      temperature: options.temperature,
      top_p: options.topP,
      thinking: mapAnthropicThinking(
        options.thinking,
        options.toolChoice,
      ) as any,
      context_management: mapAnthropicCompaction(options.compaction) as any,
      container: getAnthropicSkillsContainer(options),
      tools: toolDefinitions.length > 0 ? (toolDefinitions as any) : undefined,
      tool_choice: mapAnthropicToolChoice(options.toolChoice) as any,
    } as any,
    getAnthropicRequestOptions(options) as any,
  );
}

export function convertSessionToAnthropicMessages(
  session: Session<any, any>,
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  return session.messages
    .filter(
      (message) => message.type === 'user' || message.type === 'assistant',
    )
    .map((message) => ({
      role: message.type,
      content: applyAnthropicCacheControl(
        message.contentParts
          ? contentPartsToAnthropicContent(message.contentParts)
          : message.content,
        message.cache,
      ),
    }));
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
    options?.capabilities,
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
      'anthropic-beta':
        'code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14',
    },
  };
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

function mapAnthropicToolChoice(choice: LLMOptions['toolChoice']) {
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
