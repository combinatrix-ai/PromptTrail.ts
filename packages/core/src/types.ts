/**
 * Core type definitions for PromptTrail
 */
import type { Metadata } from './metadata';

/**
 * Message metadata types
 */
export interface ToolResultMetadata extends Record<string, unknown> {
  toolCallId: string;
}

/**
 * Represents the role of a message in a conversation
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool_result';

/**
 * Discriminated union type for different message types
 */
export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

/**
 * Base interface for message properties
 */
interface BaseMessage<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  content: string;
  metadata?: Metadata<T>;
}

export interface SystemMessage extends BaseMessage {
  type: 'system';
}

export interface UserMessage extends BaseMessage {
  type: 'user';
}

export interface AssistantMessage extends BaseMessage {
  type: 'assistant';
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
}

export interface ToolResultMessage extends BaseMessage<ToolResultMetadata> {
  type: 'tool_result';
  result: unknown;
}

/**
 * Schema type interface for defining JSON schema structures
 */
export interface SchemaType {
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
}

/**
 * Session interface for maintaining conversation state
 */
export interface Session<
  T extends { [key: string]: unknown } = Record<string, unknown>,
> {
  readonly messages: readonly Message[];
  readonly metadata: Metadata<T>;
  readonly print: boolean;
  addMessage(message: Message): Session<T>;
  updateMetadata<U extends Record<string, unknown>>(
    metadata: U,
  ): Session<T & U>;
  getLastMessage(): Message | undefined;
  getMessagesByType<U extends Message['type']>(
    type: U,
  ): Extract<Message, { type: U }>[];
  validate(): void;
  toJSON(): Record<string, unknown>;
}

/**
 * Provider types
 */
export type OpenAIProviderConfig = {
  type: 'openai';
  apiKey: string;
  modelName: string;
  baseURL?: string;
  organization?: string;
  dangerouslyAllowBrowser?: boolean;
};

export type AnthropicProviderConfig = {
  type: 'anthropic';
  apiKey: string;
  modelName: string;
  baseURL?: string;
};

export type ProviderConfig = OpenAIProviderConfig | AnthropicProviderConfig;

/**
 * MCP Server configuration for generate
 */
export interface GenerateMCPServerConfig {
  url: string;
  name?: string;
  version?: string;
  headers?: Record<string, string>;
}

/**
 * MCP Transport interface for generate
 */
export interface GenerateMCPTransport {
  url: string;
  name: string;
  version: string;
  headers: Record<string, string>;
}

/**
 * Error types
 */
export class PromptTrailError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'PromptTrailError';
  }
}

export class ValidationError extends PromptTrailError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}
