import type { Metadata } from './taggedRecord';

/**
 * Represents the role of a message in a conversation
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool_result';

/**
 * Base interface for all message types
 */
export interface BaseMessage<TMetadata extends Metadata> {
  content: string;
  metadata?: TMetadata;
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
export interface SystemMessage<TMetadata extends Metadata>
  extends BaseMessage<TMetadata> {
  type: 'system';
}

/**
 * User message interface
 */
export interface UserMessage<TMetadata extends Metadata>
  extends BaseMessage<TMetadata> {
  type: 'user';
}

/**
 * Assistant message interface
 */
export interface AssistantMessage<TMetadata extends Metadata>
  extends BaseMessage<TMetadata> {
  type: 'assistant';
}

/**
 * Tool result message interface
 */
export interface ToolResultMessage<TMetadata extends Metadata>
  extends BaseMessage<TMetadata> {
  type: 'tool_result';
}

/**
 * Message interface that can be any of the above types
 */
export type Message<TMetadata extends Metadata> =
  | SystemMessage<TMetadata>
  | UserMessage<TMetadata>
  | AssistantMessage<TMetadata>
  | ToolResultMessage<TMetadata>;
