import type { Message } from './message';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
