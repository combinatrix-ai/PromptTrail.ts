import OpenAI from 'openai';
import type {
  Message,
  Session,
  Tool,
  SchemaType,
  AssistantMessage,
  AssistantMetadata,
} from '../../types';
import { Model } from '../base';
import type { OpenAIConfig, OpenAITool } from './types';
import { ConfigurationError } from '../../types';
import { createMetadata } from '../../metadata';

export class OpenAIModel extends Model<OpenAIConfig> {
  private client: OpenAI;

  constructor(config: OpenAIConfig) {
    super(config);
    this.client = new OpenAI({
      apiKey: config.apiKey,
      organization: config.organizationId,
      baseURL: config.apiBase,
      dangerouslyAllowBrowser: config.dangerouslyAllowBrowser,
    });
  }

  protected validateConfig(): void {
    if (!this.config.apiKey) {
      throw new ConfigurationError('OpenAI API key is required');
    }
    if (!this.config.modelName) {
      throw new ConfigurationError('Model name is required');
    }
    if (
      this.config.temperature &&
      (this.config.temperature < 0 || this.config.temperature > 2)
    ) {
      throw new ConfigurationError('Temperature must be between 0 and 2');
    }
  }

  protected formatTool(tool: Tool<SchemaType>): OpenAITool {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.schema.properties,
          required: tool.schema.required || [],
        },
      },
    };
  }

  private convertToOpenAIMessages(
    session: Session,
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    let lastAssistantMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam | null =
      null;

    for (const msg of session.messages) {
      if (msg.type === 'system') {
        messages.push({ role: 'system', content: msg.content });
      } else if (msg.type === 'user') {
        messages.push({ role: 'user', content: msg.content });
      } else if (msg.type === 'assistant') {
        const toolCalls = msg.metadata?.get(
          'toolCalls',
        ) as AssistantMetadata['toolCalls'];
        if (toolCalls) {
          lastAssistantMessage = {
            role: 'assistant',
            content: msg.content,
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          };
          messages.push(lastAssistantMessage);
        } else {
          messages.push({ role: 'assistant', content: msg.content });
        }
      } else if (
        msg.type === 'tool_result' &&
        lastAssistantMessage?.tool_calls
      ) {
        // Only add tool results if there was a preceding assistant message with tool calls
        const toolCallId = msg.metadata?.get('toolCallId') as string;
        if (toolCallId) {
          messages.push({
            role: 'tool',
            content: msg.content,
            tool_call_id: toolCallId,
          });
        }
      }
    }

    return messages;
  }

  async send(session: Session): Promise<Message> {
    const messages = this.convertToOpenAIMessages(session);

    const params = {
      model: this.config.modelName,
      messages,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      tools: this.config.tools?.map((tool) => this.formatTool(tool)),
    };

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];

    if (!choice) {
      throw new Error('No response from OpenAI');
    }

    if (choice.message.tool_calls?.length) {
      // Handle tool calls
      const metadata: AssistantMetadata = {
        toolCalls: choice.message.tool_calls.map((call) => ({
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments),
          id: call.id,
        })),
      };

      const message: AssistantMessage = {
        type: 'assistant',
        content: choice.message.content || 'Tool Call Request',
        metadata: createMetadata<AssistantMetadata>({ initial: metadata }),
      };

      return message;
    }

    return {
      type: 'assistant',
      content: choice.message.content || '',
      metadata: createMetadata<AssistantMetadata>(),
    };
  }

  async *sendAsync(session: Session): AsyncGenerator<Message, void, unknown> {
    const messages = this.convertToOpenAIMessages(session);

    const stream = await this.client.chat.completions.create({
      model: this.config.modelName,
      messages,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      yield {
        type: 'assistant',
        content: delta,
        metadata: createMetadata<AssistantMetadata>(),
      };
    }
  }
}
