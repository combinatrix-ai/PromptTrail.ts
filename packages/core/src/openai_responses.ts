import OpenAI from 'openai';
import type { Message } from './message';
import type { Attrs, Session, Vars } from './session';
import type { LLMOptions, OpenAIProviderConfig } from './llm_types';
import type { RetainLevel } from './runtime';

export async function generateOpenAIResponsesText<
  TVars extends Vars,
  TAttrs extends Attrs,
>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions & { provider: OpenAIProviderConfig },
): Promise<Message<TAttrs>> {
  const client = new OpenAI({
    apiKey: options.provider.apiKey,
    baseURL: options.provider.baseURL,
    organization: options.provider.organization,
    dangerouslyAllowBrowser:
      options.dangerouslyAllowBrowser ??
      options.provider.dangerouslyAllowBrowser,
  });
  const response = await client.responses.create({
    model: options.provider.modelName,
    input: convertSessionToResponsesInput(session),
    instructions: getResponsesInstructions(session),
    temperature: options.temperature,
    top_p: options.topP,
    max_output_tokens: options.maxTokens,
  });

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

export function convertSessionToResponsesInput(
  session: Session<any, any>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return session.messages
    .filter(
      (message) => message.type === 'user' || message.type === 'assistant',
    )
    .map((message) => ({
      role: message.type,
      content: message.content,
    }));
}

export function getResponsesInstructions(
  session: Session<any, any>,
): string | undefined {
  const instructions = session.messages
    .filter((message) => message.type === 'system')
    .map((message) => message.content)
    .join('\n\n');
  return instructions || undefined;
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
