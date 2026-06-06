import type { z } from 'zod';
import type { CapabilitySet } from './capabilities';

export interface OpenAIProviderConfig {
  type: 'openai';
  apiKey: string;
  modelName: string;
  api?: 'chat' | 'responses';
  adapter?: 'native' | 'ai-sdk';
  baseURL?: string;
  organization?: string;
  dangerouslyAllowBrowser?: boolean;
}

export interface AnthropicProviderConfig {
  type: 'anthropic';
  apiKey: string;
  modelName: string;
  adapter?: 'native' | 'ai-sdk';
  baseURL?: string;
}

export interface GoogleProviderConfig {
  type: 'google';
  apiKey?: string;
  modelName: string;
  adapter?: 'native' | 'ai-sdk';
  baseURL?: string;
}

export type ProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | GoogleProviderConfig;

export interface LLMOptions {
  provider: ProviderConfig;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  tools?: Record<string, unknown>;
  capabilities?: CapabilitySet;
  toolChoice?: 'auto' | 'required' | 'none';
  dangerouslyAllowBrowser?: boolean;
  providerOptions?: Record<string, Record<string, unknown>>;
  sdkOptions?: Record<string, unknown>;
  maxCallLimit?: number;
  retain?: 'none' | 'summary' | 'full';
  conversationBinding?: 'off' | 'auto';
}

export interface SchemaGenerationOptions {
  schema: z.ZodType;
  mode?: 'tool' | 'structured_output';
  functionName?: string;
}

export interface ModelOutput {
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
  toolResults?: Array<{
    toolCallId: string;
    result: unknown;
  }>;
  structuredOutput?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
