/**
 * Type definitions for @prompttrail/react
 * These types mirror the core package types but are defined locally to avoid dependency issues
 */

export type Metadata = Map<string, any>;

export interface InputSource {
  getInput: (context?: { metadata?: Metadata }) => Promise<string>;
}

export type MessageType = 'system' | 'user' | 'assistant' | 'tool_result';

export interface Message {
  type: MessageType;
  content: string;
  [key: string]: any;
}

export interface Session<T extends Record<string, unknown> = Record<string, unknown>> {
  messages: Message[];
  metadata: Metadata;
  addMessage: (message: Message) => Session<T>;
  getMessagesByType: <U extends Message['type']>(type: U) => Extract<Message, { type: U }>[];
  updateMetadata: (metadata: Partial<T>) => Session<T>;
}

export interface Template<TInput, TOutput> {
  execute: (session: Session<any>) => Promise<Session<any>>;
}
