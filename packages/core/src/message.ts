import type { MessageMetadata } from './session';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool_result';

export interface BaseMessage<
  TMetadata extends MessageMetadata = Record<string, any>,
> {
  content: string;
  attrs?: TMetadata;
  structuredContent?: Record<string, unknown>;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
}

export interface SystemMessage<
  TMetadata extends MessageMetadata = Record<string, any>,
> extends BaseMessage<TMetadata> {
  type: 'system';
}

export interface UserMessage<
  TMetadata extends MessageMetadata = Record<string, any>,
> extends BaseMessage<TMetadata> {
  type: 'user';
}

export interface AssistantMessage<
  TMetadata extends MessageMetadata = Record<string, any>,
> extends BaseMessage<TMetadata> {
  type: 'assistant';
}

export interface ToolResultMessage<
  TMetadata extends MessageMetadata = Record<string, any>,
> extends BaseMessage<TMetadata> {
  type: 'tool_result';
}

export type Message<TMetadata extends MessageMetadata = Record<string, any>> =
  | SystemMessage<TMetadata>
  | UserMessage<TMetadata>
  | AssistantMessage<TMetadata>
  | ToolResultMessage<TMetadata>;

export const Message = {
  create: <M extends MessageMetadata = Record<string, any>>(
    type: MessageRole,
    content: string,
    attrs?: M,
  ): Message<M> => {
    return { type, content, attrs } as Message<M>;
  },

  seTMetadata: <M extends MessageMetadata = MessageMetadata>(
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
    message: Message<MessageMetadata<M>>,
    attrs: U,
  ): Message<MessageMetadata<Omit<M, keyof U> & U>> => ({
    ...message,
    attrs: { ...(message.attrs ?? {}), ...attrs } as MessageMetadata<
      Omit<M, keyof U> & U
    >,
  }),

  setStructuredContent: <
    M extends MessageMetadata = MessageMetadata,
    S extends Record<string, unknown> = Record<string, unknown>,
  >(
    message: Message<M>,
    structuredContent: S,
  ): Message<M> => ({
    ...message,
    structuredContent,
  }),

  setContent: <M extends MessageMetadata = MessageMetadata>(
    message: Message<M>,
    content: string,
  ): Message<M> => ({
    ...message,
    content,
  }),

  system: <M extends MessageMetadata = MessageMetadata>(
    content: string,
    attrs?: M,
  ): Message<M> => ({ type: 'system', content, attrs }),

  user: <M extends MessageMetadata = MessageMetadata>(
    content: string,
    attrs?: M,
  ): Message<M> => ({
    type: 'user',
    content,
    attrs,
  }),

  assistant: <M extends MessageMetadata = MessageMetadata>(
    content: string,
    attrs?: M,
  ): Message<M> => ({ type: 'assistant', content, attrs }),
};
