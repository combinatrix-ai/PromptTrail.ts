import type { z } from 'zod';
import type {
  ApprovalHandler,
  CapabilitySet,
  PromptTrailTool,
} from './capabilities';

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
  retry?: ProviderRetryOptions;
}

export type ProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | GoogleProviderConfig;

export interface AiSdkAdapterOptions {
  providerOptions?: Record<string, Record<string, unknown>>;
  sdkOptions?: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'none' }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };

export interface AnthropicAdapterOptions {
  toolChoice?: AnthropicToolChoice;
}

export interface LLMOptions {
  provider: ProviderConfig;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  tools?: Record<string, PromptTrailTool<any, any>>;
  capabilities?: CapabilitySet;
  toolChoice?: 'auto' | 'required' | 'none';
  toolLoop?: 'vendor';
  dangerouslyAllowBrowser?: boolean;
  aiSdk?: AiSdkAdapterOptions;
  anthropic?: AnthropicAdapterOptions;
  maxCallLimit?: number;
  retain?: 'none' | 'summary' | 'full';
  conversationBinding?: 'off' | 'auto';
  skillInjection?: 'warn' | 'error' | 'silent';
  approvalHandler?: ApprovalHandler;
  services?: Record<string, unknown>;
  thinking?: ThinkingOptions;
  cacheKey?: string;
  cacheRetention?: 'in_memory' | '24h';
  compaction?: CompactionOptions;
}

export type SchemaGenerationMode = 'native' | 'tool' | 'structured_output';

export function normalizeSchemaGenerationMode(
  mode: SchemaGenerationMode | undefined,
): 'native' | 'tool' {
  return mode === 'tool' ? 'tool' : 'native';
}

export interface SchemaGenerationOptions {
  schema: z.ZodType;
  /**
   * `structured_output` is kept as a deprecated alias for `native`.
   */
  mode?: SchemaGenerationMode;
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

export interface ThinkingOptions {
  effort?: 'low' | 'medium' | 'high';
  budgetTokens?: number;
  summary?: boolean;
}

export interface CompactionOptions {
  mode: 'provider' | 'local' | 'off';
  threshold?: number;
  pauseAfterCompaction?: boolean;
}

export interface ProviderRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  retryableStatuses?: number[];
}
