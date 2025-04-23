import type { Context } from './context';
import type { Message } from './message';
import type { TTransformFunction } from './templates/template_types';

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
  readonly context: Context<T>;
  readonly print: boolean;
  addMessage(message: Message): Session<T>;
  updateContext<U extends Record<string, unknown>>(context: U): Session<T & U>;
  getLastMessage(): Message | undefined;
  getMessagesByType<U extends Message['type']>(
    type: U,
  ): Extract<Message, { type: U }>[];
  validate(): void;
  toJSON(): Record<string, unknown>;
  toString(): string;
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
  type: 'mcp';
  serverName: string;
  toolName: string;
}

/**
 * Error Types
 * --------------------------------------------------------------------
 */

/**
 * Base error class for all PromptTrail errors
 */
export class PromptTrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptTrailError';
  }
}

/**
 * Error thrown when validation fails
 */
export class ValidationError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Error thrown when a template is invalid
 */
export class TemplateError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/**
 * Error thrown when a provider is invalid
 */
export class ProviderError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Error thrown when a schema is invalid
 */
export class SchemaError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/**
 * Error thrown when a content source is invalid
 */
export class ContentSourceError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'ContentSourceError';
  }
}

/**
 * Error thrown when a transform function is invalid
 */
export class TransformError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'TransformError';
  }
}

/**
 * Error thrown when a validator is invalid
 */
export class ValidatorError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidatorError';
  }
}

/**
 * Error thrown when a message is invalid
 */
export class MessageError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'MessageError';
  }
}

/**
 * Error thrown when a session is invalid
 */
export class SessionError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * Error thrown when a template is not found
 */
export class TemplateNotFoundError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateNotFoundError';
  }
}

/**
 * Error thrown when a provider is not found
 */
export class ProviderNotFoundError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotFoundError';
  }
}

/**
 * Error thrown when a schema is not found
 */
export class SchemaNotFoundError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaNotFoundError';
  }
}

/**
 * Error thrown when a content source is not found
 */
export class ContentSourceNotFoundError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'ContentSourceNotFoundError';
  }
}

/**
 * Error thrown when a transform function is not found
 */
export class TransformNotFoundError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'TransformNotFoundError';
  }
}

/**
 * Error thrown when a validator is not found
 */
export class ValidatorNotFoundError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidatorNotFoundError';
  }
}

/**
 * Error thrown when a message is not found
 */
export class MessageNotFoundError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'MessageNotFoundError';
  }
}

/**
 * Error thrown when a session is not found
 */
export class SessionNotFoundError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * Error thrown when a template is already registered
 */
export class TemplateAlreadyRegisteredError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateAlreadyRegisteredError';
  }
}

/**
 * Error thrown when a provider is already registered
 */
export class ProviderAlreadyRegisteredError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAlreadyRegisteredError';
  }
}

/**
 * Error thrown when a schema is already registered
 */
export class SchemaAlreadyRegisteredError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaAlreadyRegisteredError';
  }
}

/**
 * Error thrown when a content source is already registered
 */
export class ContentSourceAlreadyRegisteredError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'ContentSourceAlreadyRegisteredError';
  }
}

/**
 * Error thrown when a transform function is already registered
 */
export class TransformAlreadyRegisteredError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'TransformAlreadyRegisteredError';
  }
}

/**
 * Error thrown when a validator is already registered
 */
export class ValidatorAlreadyRegisteredError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidatorAlreadyRegisteredError';
  }
}

/**
 * Error thrown when a message is already registered
 */
export class MessageAlreadyRegisteredError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'MessageAlreadyRegisteredError';
  }
}

/**
 * Error thrown when a session is already registered
 */
export class SessionAlreadyRegisteredError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionAlreadyRegisteredError';
  }
}
