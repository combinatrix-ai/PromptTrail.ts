import type { ModelConfig, Temperature, Tool } from '../../types';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

/**
 * OpenAI specific configuration
 */
export interface OpenAIConfig extends ModelConfig {
  apiKey: string;
  organizationId?: string;
  apiBase?: string;
  apiVersion?: string;
}

/**
 * OpenAI message format
 */
export type OpenAIMessage = ChatCompletionMessageParam;

/**
 * OpenAI tool format
 */
export type OpenAITool = ChatCompletionTool;

/**
 * OpenAI chat completion parameters
 */
export interface OpenAIChatCompletionParams {
  model: string;
  messages: ChatCompletionMessageParam[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatCompletionTool[];
  stream?: boolean;
}