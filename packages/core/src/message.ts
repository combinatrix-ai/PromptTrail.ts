import type { ContentPart } from './content_parts';
import type { CacheHint } from './cache';

/**
 * Represents the role of a message in a conversation
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool_result';

/**
 * Base interface for all message types
 */
export interface BaseMessage {
  content: string;
  contentParts?: ContentPart[];
  cache?: CacheHint;
  attrs?: Readonly<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
  // Do **not** declare `type: MessageRole` here!
  // Because getMessagesByType etc will break.
  // Having the union ("system" | "user" | …) in the base
  // would make *every* message structurally compatible with
  // every role, so Extract<Message, { type: "user" }> collapses
  // to `never`.  Each specialised interface adds its own
  // literal `type` instead, keeping the union discriminated.
}

/**
 * System message interface
 */
export interface SystemMessage extends BaseMessage {
  type: 'system';
}

/**
 * User message interface
 */
export interface UserMessage extends BaseMessage {
  type: 'user';
}

/**
 * Assistant message interface
 */
export interface AssistantMessage extends BaseMessage {
  type: 'assistant';
}

/**
 * Tool result message interface
 */
export interface ToolResultMessage extends BaseMessage {
  type: 'tool_result';
  toolCallId?: string;
}

/**
 * Message interface that can be any of the above types
 */
export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export const Message = {
  create: (
    type: MessageRole,
    content: string,
    attrs?: Readonly<Record<string, unknown>>,
  ): Message => {
    switch (type) {
      case 'system':
        return { type: 'system', content, attrs };
      case 'user':
        return { type: 'user', content, attrs };
      case 'assistant':
        return { type: 'assistant', content, attrs };
      case 'tool_result':
        return { type: 'tool_result', content, attrs };
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  },

  setAttrs: (
    message: Message,
    attrs: Readonly<Record<string, unknown>>,
  ): Message => {
    return {
      ...message,
      attrs: { ...message.attrs, ...attrs },
    };
  },

  expandAttrs: (
    message: Message,
    attrs: Readonly<Record<string, unknown>>,
  ): Message => {
    const base = message.attrs ?? {};
    return {
      ...message,
      attrs: { ...base, ...attrs },
    };
  },

  setStructuredContent: <S extends Record<string, unknown>>(
    message: Message,
    structuredContent: S,
  ): Message => {
    return {
      ...message,
      structuredContent,
    };
  },

  setContent: (message: Message, content: string): Message => {
    return {
      ...message,
      content,
    };
  },

  system: (
    content: string,
    attrs?: Readonly<Record<string, unknown>>,
  ): Message => ({ type: 'system', content, attrs }),

  user: (
    content: string,
    attrs?: Readonly<Record<string, unknown>>,
  ): Message => ({
    type: 'user',
    content,
    attrs,
  }),

  assistant: (
    content: string,
    attrs?: Readonly<Record<string, unknown>>,
  ): Message => {
    return {
      type: 'assistant',
      content,
      attrs,
    };
  },
};
