import type { Message } from './message';
import type { RetainLevel } from './runtime';
import type { Attrs } from './session';

export type PromptTrailStreamEvent =
  | { type: 'text.delta'; index: number; delta: string }
  | { type: 'reasoning.delta'; index: number; delta: string }
  | { type: 'tool.start'; index: number; callId: string; name: string }
  | {
      type: 'tool.args.delta';
      index: number;
      callId: string;
      delta: string;
    }
  | {
      type: 'tool.args.done';
      index: number;
      callId: string;
      args: unknown;
    }
  | { type: 'message.done'; finishReason: string; usage?: unknown }
  | { type: 'error'; error: unknown };

export interface PromptTrailStreamToolState {
  index: number;
  callId: string;
  name?: string;
  argsText: string;
  args?: unknown;
}

export interface PromptTrailStreamState {
  text: string;
  reasoning: string;
  tools: Record<string, PromptTrailStreamToolState>;
  finishReason?: string;
  usage?: unknown;
  errors: unknown[];
  events: PromptTrailStreamEvent[];
}

export interface PromptTrailStreamMetadata {
  finishReason?: string;
  usage?: unknown;
  text?: StreamTextSummary;
  reasoning?: StreamTextSummary;
  tools?: StreamToolSummary[];
  errors?: unknown[];
  events?: unknown[];
}

export interface StreamTextSummary {
  preview: string;
  truncated?: true;
  fullLength?: number;
}

export interface StreamToolSummary {
  id: string;
  name?: string;
  arguments?: unknown;
}

export function createPromptTrailStreamState(): PromptTrailStreamState {
  return {
    text: '',
    reasoning: '',
    tools: {},
    errors: [],
    events: [],
  };
}

export function reducePromptTrailStreamEvent(
  state: PromptTrailStreamState,
  event: PromptTrailStreamEvent,
): PromptTrailStreamState {
  const next: PromptTrailStreamState = {
    ...state,
    tools: { ...state.tools },
    errors: [...state.errors],
    events: [...state.events, event],
  };

  switch (event.type) {
    case 'text.delta':
      next.text += event.delta;
      return next;
    case 'reasoning.delta':
      next.reasoning += event.delta;
      return next;
    case 'tool.start':
      next.tools[event.callId] = {
        index: event.index,
        callId: event.callId,
        name: event.name,
        argsText: next.tools[event.callId]?.argsText ?? '',
        args: next.tools[event.callId]?.args,
      };
      return next;
    case 'tool.args.delta':
      next.tools[event.callId] = {
        index: event.index,
        callId: event.callId,
        name: next.tools[event.callId]?.name,
        argsText: `${next.tools[event.callId]?.argsText ?? ''}${event.delta}`,
        args: next.tools[event.callId]?.args,
      };
      return next;
    case 'tool.args.done':
      next.tools[event.callId] = {
        index: event.index,
        callId: event.callId,
        name: next.tools[event.callId]?.name,
        argsText: next.tools[event.callId]?.argsText ?? '',
        args: event.args,
      };
      return next;
    case 'message.done':
      next.finishReason = event.finishReason;
      next.usage = event.usage;
      return next;
    case 'error':
      next.errors.push(event.error);
      return next;
  }
}

export function reducePromptTrailStreamEvents(
  events: readonly PromptTrailStreamEvent[],
): PromptTrailStreamState {
  return events.reduce(
    reducePromptTrailStreamEvent,
    createPromptTrailStreamState(),
  );
}

export function retainPromptTrailStreamMetadata(
  state: PromptTrailStreamState,
  retain: RetainLevel = 'summary',
): PromptTrailStreamMetadata {
  const metadata: PromptTrailStreamMetadata = {
    finishReason: state.finishReason,
    usage: state.usage,
  };
  if (retain === 'none') {
    return metadata;
  }

  metadata.text = summarizeStreamText(state.text);
  metadata.reasoning = summarizeStreamText(state.reasoning);
  metadata.tools = Object.values(state.tools)
    .sort((left, right) => left.index - right.index)
    .map((tool) => ({
      id: tool.callId,
      name: tool.name,
      arguments: normalizeToolArguments(tool),
    }));
  metadata.errors = state.errors.map(normalizeStreamError);
  metadata.events =
    retain === 'full'
      ? state.events
      : state.events.map(summarizePromptTrailStreamEvent);
  return metadata;
}

export function streamStateToAssistantMessage<TAttrs extends Attrs = Attrs>(
  state: PromptTrailStreamState,
  attrs?: TAttrs,
): Message<TAttrs> {
  const toolCalls = Object.values(state.tools)
    .sort((left, right) => left.index - right.index)
    .filter((tool) => tool.name)
    .map((tool) => ({
      id: tool.callId,
      name: tool.name!,
      arguments: normalizeToolArguments(tool),
    }));

  return {
    type: 'assistant',
    content: state.text || ' ',
    attrs,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function normalizeToolArguments(tool: PromptTrailStreamToolState) {
  if (tool.args !== undefined) {
    return isRecord(tool.args) ? tool.args : { value: tool.args };
  }
  if (!tool.argsText) {
    return {};
  }

  try {
    const parsed = JSON.parse(tool.argsText);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { value: tool.argsText };
  }
}

function summarizePromptTrailStreamEvent(event: PromptTrailStreamEvent) {
  switch (event.type) {
    case 'text.delta':
    case 'reasoning.delta':
    case 'tool.args.delta':
      return {
        ...event,
        delta: summarizeStreamText(event.delta),
      };
    case 'error':
      return {
        type: event.type,
        error: normalizeStreamError(event.error),
      };
    default:
      return event;
  }
}

function summarizeStreamText(text: string, maxPreviewLength = 500) {
  return text.length > maxPreviewLength
    ? {
        preview: text.slice(0, maxPreviewLength),
        truncated: true as const,
        fullLength: text.length,
      }
    : { preview: text };
}

function normalizeStreamError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
