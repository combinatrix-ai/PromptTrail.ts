import type { Attrs } from './session';

/**
 * Represents the role of a message in a conversation
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool_result';

/**
 * Base interface for all message types
 */
export interface BaseMessage<TAttrs extends Attrs = Attrs> {
  content: string;
  attrs?: TAttrs;
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
export interface SystemMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'system';
}

/**
 * User message interface
 */
export interface UserMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'user';
}

/**
 * Assistant message interface
 */
export interface AssistantMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'assistant';
}

/**
 * Tool result message interface
 */
export interface ToolResultMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'tool_result';
}

/**
 * Message interface that can be any of the above types
 */
export type Message<TAttrs extends Attrs = Attrs> =
  | SystemMessage<TAttrs>
  | UserMessage<TAttrs>
  | AssistantMessage<TAttrs>
  | ToolResultMessage<TAttrs>;

export const Message = {
  create: <M extends Attrs = Attrs>(
    type: MessageRole,
    content: string,
    attrs?: M,
  ): Message<M> => {
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

  setAttrs: <M extends Attrs = Attrs>(
    message: Message<M>,
    attrs: M,
  ): Message<M> => {
    return {
      ...message,
      attrs: { ...message.attrs, ...attrs } as M,
    };
  },

  expandAttrs: <
    M extends Record<string, unknown>,
    U extends Record<string, unknown>,
  >(
    message: Message<Attrs<M>>,
    attrs: U,
  ): Message<Attrs<Omit<M, keyof U> & U>> => {
    const base = message.attrs ?? ({} as M);
    return {
      ...message,
      attrs: { ...base, ...attrs } as Attrs<Omit<M, keyof U> & U>,
    };
  },

  setStructuredContent: <
    M extends Attrs = Attrs,
    S extends Record<string, unknown> = Record<string, unknown>,
  >(
    message: Message<M>,
    structuredContent: S,
  ): Message<M> => {
    return {
      ...message,
      structuredContent,
    };
  },

  setContent: <M extends Attrs = Attrs>(
    message: Message<M>,
    content: string,
  ): Message<M> => {
    return {
      ...message,
      content,
    };
  },

  system: <M extends Attrs = Attrs>(
    content: string,
    attrs?: M,
  ): Message<M> => ({ type: 'system', content, attrs }),

  user: <M extends Attrs = Attrs>(content: string, attrs?: M): Message<M> => ({
    type: 'user',
    content,
    attrs,
  }),

  assistant: <M extends Attrs = Attrs>(
    content: string,
    attrs?: M,
  ): Message<M> => {
    return {
      type: 'assistant',
      content,
      attrs,
    };
  },
};
