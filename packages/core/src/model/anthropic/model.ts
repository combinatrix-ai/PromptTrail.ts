import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  Session,
  Tool,
  SchemaType,
  AssistantMessage,
  AssistantMetadata,
  Temperature,
  createTemperature,
} from '../../types';
import { Model } from '../base';
import type { AnthropicConfig, AnthropicTool } from './types';
import { ConfigurationError } from '../../types';
import { createMetadata } from '../../metadata';

export class AnthropicModel extends Model<AnthropicConfig> {
  private client: Anthropic;

  constructor(config: AnthropicConfig) {
    super(config);
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.apiBase,
    });
  }

  protected validateConfig(): void {
    if (!this.config.apiKey) {
      throw new ConfigurationError('Anthropic API key is required');
    }
    if (!this.config.modelName) {
      throw new ConfigurationError('Model name is required');
    }
    if (
      this.config.temperature &&
      (this.config.temperature < 0 || this.config.temperature > 1)
    ) {
      throw new ConfigurationError('Temperature must be between 0 and 1');
    }
  }

  protected formatTool(tool: Tool<SchemaType>): AnthropicTool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters:
          tool.schema.type === 'object'
            ? {
                type: 'object',
                properties: tool.schema.properties,
                required: tool.schema.required,
                description: tool.schema.description,
              }
            : {
                type: tool.schema.type,
                description: tool.schema.description,
              },
      },
    };
  }

  private convertToAnthropicMessages(session: Session): {
    messages: Anthropic.MessageParam[];
    system?: string;
  } {
    const messages: Anthropic.MessageParam[] = [];
    let systemMessage: string | undefined;

    for (const msg of session.messages) {
      if (msg.type === 'system') {
        systemMessage = msg.content;
      } else if (msg.type === 'user') {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: msg.content }],
        });
      } else if (msg.type === 'assistant') {
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: msg.content }],
        });
      }
    }

    return { messages, system: systemMessage };
  }

  async send(session: Session): Promise<Message> {
    const { messages, system } = this.convertToAnthropicMessages(session);

    const response = await this.client.messages.create({
      model: this.config.modelName,
      messages,
      system,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens || 1024,
    });

    if (!response.content[0] || response.content[0].type !== 'text') {
      throw new Error('Unexpected response format from Anthropic');
    }

    return {
      type: 'assistant',
      content: response.content[0].text,
      metadata: createMetadata(),
    };
  }

  async *sendAsync(session: Session): AsyncGenerator<Message, void, unknown> {
    const { messages, system } = this.convertToAnthropicMessages(session);

    const stream = await this.client.messages.create({
      model: this.config.modelName,
      messages,
      system,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens || 1024,
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && 'text' in chunk.delta) {
        yield {
          type: 'assistant',
          content: chunk.delta.text,
          metadata: createMetadata(),
        };
      }
    }
  }
}
