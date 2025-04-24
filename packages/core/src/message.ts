import type { Metadata } from './metadata';

/**
 * Represents the role of a message in a conversation
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool_result';

/**
 * Base interface for all message types
 */
export interface BaseMessage<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  content: string;
  metadata?: Metadata<T>;
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
}

/**
 * Message interface that can be any of the above types
 */
export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

