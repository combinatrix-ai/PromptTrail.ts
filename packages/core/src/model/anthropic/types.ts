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
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}
