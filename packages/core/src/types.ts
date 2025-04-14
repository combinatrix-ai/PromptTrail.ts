import type { Metadata } from './metadata';

/**
 * Message Types
 * --------------------------------------------------------------------
 */

/**
 * Metadata type for tool result messages
 */
export interface ToolResultMetadata extends Record<string, unknown> {
  toolCallId: string;
}

// Keep old name for backward compatibility
export type IToolResultMetadata = ToolResultMetadata;

/**
 * Represents the role of a message in a conversation
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool_result';
export type TMessageRole = MessageRole; // Backward compatibility

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

// Keep old name for backward compatibility
export type IBaseMessage<
  T extends Record<string, unknown> = Record<string, unknown>,
> = BaseMessage<T>;

/**
 * System message interface
 */
export interface SystemMessage extends BaseMessage {
  type: 'system';
}
export type ISystemMessage = SystemMessage; // Backward compatibility

/**
 * User message interface
 */
export interface UserMessage extends BaseMessage {
  type: 'user';
}
export type IUserMessage = UserMessage; // Backward compatibility

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
export type IAssistantMessage = AssistantMessage; // Backward compatibility

/**
 * Tool result message interface
 */
export interface ToolResultMessage extends BaseMessage<ToolResultMetadata> {
  type: 'tool_result';
  result: unknown;
}
export type IToolResultMessage = ToolResultMessage; // Backward compatibility

/**
 * Discriminated union type for all message types
 */
export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;
export type TMessage = Message; // Backward compatibility

/**
 * Schema and Validation Types
 * --------------------------------------------------------------------
 */

/**
 * Schema type interface for defining JSON schema structures
 */
export interface SchemaType {
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
}
export type ISchemaType = SchemaType; // Backward compatibility

/**
 * Session Types
 * --------------------------------------------------------------------
 */

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
export type ISession<
  T extends { [key: string]: unknown } = Record<string, unknown>,
> = Session<T>; // Backward compatibility

/**
 * Provider Types
 * --------------------------------------------------------------------
 */

/**
 * OpenAI provider configuration
 */
export interface OpenAIProviderConfig {
  type: 'openai';
  apiKey: string;
  modelName: string;
  baseURL?: string;
  organization?: string;
  dangerouslyAllowBrowser?: boolean;
}
export type IOpenAIProviderConfig = OpenAIProviderConfig; // Backward compatibility

/**
 * Anthropic provider configuration
 */
export interface AnthropicProviderConfig {
  type: 'anthropic';
  apiKey: string;
  modelName: string;
  baseURL?: string;
}
export type IAnthropicProviderConfig = AnthropicProviderConfig; // Backward compatibility

/**
 * Provider configuration union type
 */
export type ProviderConfig = OpenAIProviderConfig | AnthropicProviderConfig;
export type TProviderConfig = ProviderConfig; // Backward compatibility

/**
 * MCP Server and Transport Types
 * --------------------------------------------------------------------
 */

/**
 * MCP Server configuration for generate
 */
export interface MCPServerConfig {
  url: string;
  name?: string;
  version?: string;
  headers?: Record<string, string>;
}
export type IMCPServerConfig = MCPServerConfig; // Backward compatibility

/**
 * MCP Transport interface for generate
 */
export interface MCPTransport {
  url: string;
  name: string;
  version: string;
  headers: Record<string, string>;
}
export type IMCPTransport = MCPTransport; // Backward compatibility

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
