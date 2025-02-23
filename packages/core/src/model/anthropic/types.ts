import type { ModelConfig, Temperature, Tool, SchemaType } from '../../types';

export interface AnthropicConfig extends ModelConfig {
  readonly apiKey: string;
  readonly apiBase?: string;
  readonly modelName: string;
  readonly temperature: Temperature;
  readonly maxTokens?: number;
  readonly tools?: readonly Tool<SchemaType>[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AnthropicToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  tool_calls?: AnthropicToolCall[];
}
