import type { Metadata } from './metadata';

/**
 * Represents the role of a message in a conversation
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool_result';

/**
 * Base interface for all message types
 */
export interface Message<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  content: string;
  metadata?: Metadata<T>;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
  type: MessageRole;
}

/**
 * System message interface
 */
export interface SystemMessage extends Message {
  type: 'system';
}

/**
 * User message interface
 */
export interface UserMessage extends Message {
  type: 'user';
}

/**
 * Assistant message interface
 */
export interface AssistantMessage extends Message {
  type: 'assistant';
}
