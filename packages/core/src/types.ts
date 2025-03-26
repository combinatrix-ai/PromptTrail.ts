/**
 * Core type definitions for PromptTrail
 */
import type { GenerateOptions } from './generate_options';
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
 * Type guard functions for message types
 */
export const isSystemMessage = (message: Message): message is SystemMessage =>
  message.type === 'system';

export const isUserMessage = (message: Message): message is UserMessage =>
  message.type === 'user';

export const isAssistantMessage = (
  message: Message,
): message is AssistantMessage => message.type === 'assistant';

export const isToolResultMessage = (
  message: Message,
): message is ToolResultMessage => message.type === 'tool_result';

// Temperature is now just a regular number

/**
 * Model configuration interface
 */
export interface ModelConfig {
  readonly modelName: string;
  readonly temperature: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly repetitionPenalty?: number;
  readonly tools?: Record<string, unknown>;
}

// Define SchemaType interface since tool.ts is empty
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
  name: string;
  version: string;
}

/**
 * MCP Transport interface for generate
 */
export interface GenerateMCPTransport {
  send(message: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Generate options interface
 */
export interface GenerateOptionsConfig {
  provider: ProviderConfig;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  tools?: Record<string, unknown>;
  toolChoice?: 'auto' | 'required' | 'none';
  mcpServers?: GenerateMCPServerConfig[];
  sdkOptions?: Record<string, unknown>;
}

/**
 * Template related types
 */
export type TemplateArgs =
  | { content: string; generateOptions?: never }
  | GenerateOptionsConfig
  | string
  | GenerateOptions;

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

export class ConfigurationError extends PromptTrailError {
  constructor(message: string) {
    super(message, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
  }
}
