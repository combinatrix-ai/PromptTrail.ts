import type { Attrs } from './tagged_record';

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
