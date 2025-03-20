import type { SchemaType } from '../../tool';
import type { AIProvider } from './model';

/**
 * AI SDK Tool representation
 */
export interface AISDKTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * AI SDK Tool call
 */
export interface AISDKToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * AI SDK Message format
 */
export interface AISDKMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * AI SDK Response format
 */
export interface AISDKResponse {
  text: string;
  toolCalls?: AISDKToolCall[];
}

/**
 * AI SDK Stream chunk types
 */
export type AISDKStreamChunk =
  | { type: 'text-delta'; textDelta: string }
  | { type: 'tool-call'; toolCall: AISDKToolCall }
  | { type: 'tool-result'; toolResult: unknown }
  | { type: 'error'; error: Error }
  | { type: 'finish' };
