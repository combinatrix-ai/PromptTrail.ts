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
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
}

/**
 * Discriminated union type for all message types
 */
export type Message = SystemMessage | UserMessage | AssistantMessage;
