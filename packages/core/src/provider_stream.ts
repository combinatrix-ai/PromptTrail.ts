import type { PromptTrailStreamEvent } from './stream';

export interface ProviderStreamNormalizer {
  consume(event: unknown): PromptTrailStreamEvent[];
}

export function createOpenAIStreamNormalizer(): ProviderStreamNormalizer {
  const toolNamesByIndex = new Map<number, string>();
  const toolCallIdsByItemId = new Map<string, string>();
  const completedToolCallIds = new Set<string>();

  return {
    consume(event: unknown): PromptTrailStreamEvent[] {
      const raw = asRecord(event);
      if (!raw) {
        return [];
      }

      switch (raw.type) {
        case 'response.output_item.added': {
          const item = asRecord(raw.item);
          if (item?.type !== 'function_call') {
            return [];
          }
          const index = numberValue(raw.output_index) ?? 0;
          const callId = stringValue(item.call_id ?? item.id) ?? String(index);
          const name = stringValue(item.name) ?? '';
          const itemId = stringValue(item.id);
          toolNamesByIndex.set(index, name);
          if (itemId) {
            toolCallIdsByItemId.set(itemId, callId);
          }
          return [{ type: 'tool.start', index, callId, name }];
        }
        case 'response.output_text.delta':
          return [
            {
              type: 'text.delta',
              index: numberValue(raw.output_index) ?? 0,
              delta: stringValue(raw.delta) ?? '',
            },
          ];
        case 'response.reasoning_summary_text.delta':
          return [
            {
              type: 'reasoning.delta',
              index: numberValue(raw.output_index) ?? 0,
              delta: stringValue(raw.delta) ?? '',
            },
          ];
        case 'response.function_call_arguments.delta': {
          const index = numberValue(raw.output_index) ?? 0;
          return [
            {
              type: 'tool.args.delta',
              index,
              callId: openAICallId(raw, index),
              delta: stringValue(raw.delta) ?? '',
            },
          ];
        }
        case 'response.function_call_arguments.done': {
          const index = numberValue(raw.output_index) ?? 0;
          const callId = openAICallId(raw, index);
          completedToolCallIds.add(callId);
          return [
            {
              type: 'tool.args.done',
              index,
              callId,
              args: parseJsonValue(raw.arguments),
            },
          ];
        }
        case 'response.output_item.done': {
          const item = asRecord(raw.item);
          if (item?.type !== 'function_call') {
            return [];
          }
          const index = numberValue(raw.output_index) ?? 0;
          const callId =
            stringValue(item.call_id ?? item.id) ?? openAICallId(raw, index);
          if (completedToolCallIds.has(callId)) {
            return [];
          }
          completedToolCallIds.add(callId);
          return [
            {
              type: 'tool.args.done',
              index,
              callId,
              args: parseJsonValue(item.arguments),
            },
          ];
        }
        case 'response.completed': {
          const response = asRecord(raw.response);
          return [
            {
              type: 'message.done',
              finishReason:
                stringValue(response?.status ?? raw.status) ?? 'completed',
              usage: response?.usage ?? raw.usage,
            },
          ];
        }
        case 'response.failed':
        case 'response.incomplete':
        case 'response.error':
          return [{ type: 'error', error: raw.error ?? raw }];
      }

      return [];
    },
  };

  function openAICallId(raw: Record<string, unknown>, index: number): string {
    const itemId = stringValue(raw.item_id);
    if (itemId && toolCallIdsByItemId.has(itemId)) {
      return toolCallIdsByItemId.get(itemId)!;
    }
    const callId = stringValue(raw.call_id ?? itemId);
    if (callId) {
      return callId;
    }
    return toolNamesByIndex.has(index) ? `call-${index}` : String(index);
  }
}

export function createAnthropicStreamNormalizer(): ProviderStreamNormalizer {
  const toolCallsByIndex = new Map<number, { callId: string; name: string }>();

  return {
    consume(event: unknown): PromptTrailStreamEvent[] {
      const raw = asRecord(event);
      if (!raw) {
        return [];
      }

      switch (raw.type) {
        case 'content_block_start': {
          const index = numberValue(raw.index) ?? 0;
          const block = asRecord(raw.content_block);
          if (block?.type !== 'tool_use') {
            return [];
          }
          const callId = stringValue(block.id) ?? String(index);
          const name = stringValue(block.name) ?? '';
          toolCallsByIndex.set(index, { callId, name });
          return [{ type: 'tool.start', index, callId, name }];
        }
        case 'content_block_delta': {
          const index = numberValue(raw.index) ?? 0;
          const delta = asRecord(raw.delta);
          if (delta?.type === 'text_delta') {
            return [
              {
                type: 'text.delta',
                index,
                delta: stringValue(delta.text) ?? '',
              },
            ];
          }
          if (delta?.type === 'thinking_delta') {
            return [
              {
                type: 'reasoning.delta',
                index,
                delta: stringValue(delta.thinking) ?? '',
              },
            ];
          }
          if (delta?.type === 'input_json_delta') {
            const tool = toolCallsByIndex.get(index);
            return [
              {
                type: 'tool.args.delta',
                index,
                callId: tool?.callId ?? String(index),
                delta: stringValue(delta.partial_json) ?? '',
              },
            ];
          }
          return [];
        }
        case 'content_block_stop': {
          const index = numberValue(raw.index) ?? 0;
          const tool = toolCallsByIndex.get(index);
          if (!tool) {
            return [];
          }
          return [
            {
              type: 'tool.args.done',
              index,
              callId: tool.callId,
              args: undefined,
            },
          ];
        }
        case 'message_stop':
          return [
            {
              type: 'message.done',
              finishReason: stringValue(raw.stop_reason) ?? 'end_turn',
              usage: raw.usage,
            },
          ];
        case 'error':
          return [{ type: 'error', error: raw.error ?? raw }];
      }

      return [];
    },
  };
}

export function geminiStreamEventToPromptTrailEvents(
  event: unknown,
): PromptTrailStreamEvent[] {
  const raw = asRecord(event);
  if (!raw) {
    return [];
  }
  const events: PromptTrailStreamEvent[] = [];
  const parts = getGeminiParts(raw);
  parts.forEach((part, index) => {
    if (typeof part.text === 'string') {
      events.push({
        type: part.thought ? 'reasoning.delta' : 'text.delta',
        index,
        delta: part.text,
      });
    }
    const call = asRecord(part.functionCall);
    if (call) {
      const callId = stringValue(call.id ?? call.name) ?? String(index);
      const name = stringValue(call.name) ?? '';
      events.push({ type: 'tool.start', index, callId, name });
      events.push({
        type: 'tool.args.done',
        index,
        callId,
        args: call.args ?? {},
      });
    }
  });

  const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  const finishReason = stringValue(
    asRecord(candidates[0])?.finishReason ?? raw.finishReason,
  );
  if (finishReason) {
    events.push({
      type: 'message.done',
      finishReason,
      usage: raw.usageMetadata,
    });
  }

  return events;
}

function getGeminiParts(
  raw: Record<string, unknown>,
): Record<string, unknown>[] {
  const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  const firstCandidate = asRecord(candidates[0]);
  const content = asRecord(firstCandidate?.content ?? raw.content);
  const parts = content?.parts ?? raw.parts;
  return Array.isArray(parts) ? parts.filter(isRecord) : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
