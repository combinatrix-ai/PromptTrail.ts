import type { Attrs } from './session';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool_result';

export interface BaseMessage<TAttrs extends Attrs = Attrs> {
  content: string;
  attrs?: TAttrs;
  structuredContent?: Record<string, unknown>;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
}

export interface SystemMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'system';
}

export interface UserMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'user';
}

export interface AssistantMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'assistant';
}

export interface ToolResultMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'tool_result';
}

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
    return { type, content, attrs } as Message<M>;
  },

  setAttrs: <M extends Attrs = Attrs>(
    message: Message<M>,
    attrs: M,
  ): Message<M> => ({
    ...message,
    attrs: { ...message.attrs, ...attrs } as M,
  }),

  expandAttrs: <
    M extends Record<string, unknown>,
    U extends Record<string, unknown>,
  >(
    message: Message<Attrs<M>>,
    attrs: U,
  ): Message<Attrs<Omit<M, keyof U> & U>> => ({
    ...message,
    attrs: { ...(message.attrs ?? {}), ...attrs } as Attrs<
      Omit<M, keyof U> & U
    >,
  }),

  setStructuredContent: <
    M extends Attrs = Attrs,
    S extends Record<string, unknown> = Record<string, unknown>,
  >(
    message: Message<M>,
    structuredContent: S,
  ): Message<M> => ({
    ...message,
    structuredContent,
  }),

  setContent: <M extends Attrs = Attrs>(
    message: Message<M>,
    content: string,
  ): Message<M> => ({
    ...message,
    content,
  }),

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
  ): Message<M> => ({ type: 'assistant', content, attrs }),
};
