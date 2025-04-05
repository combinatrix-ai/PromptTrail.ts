import type { Metadata } from './metadata';

/**
 * Message Types
 * --------------------------------------------------------------------
 */

/**
 * Metadata type for tool result messages
 */
export interface IToolResultMetadata extends Record<string, unknown> {
  toolCallId: string;
}

/**
 * Represents the role of a message in a conversation
 */
export type TMessageRole = 'system' | 'user' | 'assistant' | 'tool_result';

/**
 * Base interface for all message types
 */
export interface IBaseMessage<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  content: string;
  metadata?: Metadata<T>;
}

/**
 * System message interface
 */
export interface ISystemMessage extends IBaseMessage {
  type: 'system';
}

/**
 * User message interface
 */
export interface IUserMessage extends IBaseMessage {
  type: 'user';
}

/**
 * Assistant message interface
 */
export interface IAssistantMessage extends IBaseMessage {
  type: 'assistant';
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
}

/**
 * Tool result message interface
 */
export interface IToolResultMessage extends IBaseMessage<IToolResultMetadata> {
  type: 'tool_result';
  result: unknown;
}

/**
 * Discriminated union type for all message types
 */
export type TMessage =
  | ISystemMessage
  | IUserMessage
  | IAssistantMessage
  | IToolResultMessage;

/**
 * Schema and Validation Types
 * --------------------------------------------------------------------
 */

/**
 * Schema type interface for defining JSON schema structures
 */
export interface ISchemaType {
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
}

/**
 * Session Types
 * --------------------------------------------------------------------
 */

/**
 * Session interface for maintaining conversation state
 */
export interface ISession<
  T extends { [key: string]: unknown } = Record<string, unknown>,
> {
  readonly messages: readonly TMessage[];
  readonly metadata: Metadata<T>;
  readonly print: boolean;
  addMessage(message: TMessage): ISession<T>;
  updateMetadata<U extends Record<string, unknown>>(
    metadata: U,
  ): ISession<T & U>;
  getLastMessage(): TMessage | undefined;
  getMessagesByType<U extends TMessage['type']>(
    type: U,
  ): Extract<TMessage, { type: U }>[];
  validate(): void;
  toJSON(): Record<string, unknown>;
}

/**
 * Provider Types
 * --------------------------------------------------------------------
 */

/**
 * OpenAI provider configuration
 */
export interface IOpenAIProviderConfig {
  type: 'openai';
  apiKey: string;
  modelName: string;
  baseURL?: string;
  organization?: string;
  dangerouslyAllowBrowser?: boolean;
}

/**
 * Anthropic provider configuration
 */
export interface IAnthropicProviderConfig {
  type: 'anthropic';
  apiKey: string;
  modelName: string;
  baseURL?: string;
}

/**
 * Provider configuration union type
 */
export type TProviderConfig = IOpenAIProviderConfig | IAnthropicProviderConfig;

/**
 * MCP Server and Transport Types
 * --------------------------------------------------------------------
 */

/**
 * MCP Server configuration for generate
 */
export interface IMCPServerConfig {
  url: string;
  name?: string;
  version?: string;
  headers?: Record<string, string>;
}

/**
 * MCP Transport interface for generate
 */
export interface IMCPTransport {
  url: string;
  name: string;
  version: string;
  headers: Record<string, string>;
}

/**
 * Error Types
 * --------------------------------------------------------------------
 */

/**
 * Base error class for PromptTrail errors
 */
export class PromptTrailError extends Error {
  /**
   * Creates a new PromptTrail error
   *
   * @param message - Error message
   * @param code - Error code
   */
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'PromptTrailError';
  }
}

/**
 * Error class for validation errors
 */
export class ValidationError extends PromptTrailError {
  /**
   * Creates a new validation error
   *
   * @param message - Error message
   */
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}
