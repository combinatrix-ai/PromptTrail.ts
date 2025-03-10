import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  Session,
  Tool,
  SchemaType,
  AssistantMetadata,
} from '../../types';
import { MCPClientWrapper } from './mcp';
import type { MCPServerConfig } from './mcp';
import type { InferSchemaType } from '../../tool';

interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
  id: string;
}

interface AnthropicResponse {
  content: Array<TextBlock | ToolUseBlock>;
}
import { Model } from '../base';
import type { AnthropicConfig, AnthropicTool } from './types';
import { ConfigurationError } from '../../types';
import { createMetadata } from '../../metadata';

export class AnthropicModel extends Model<AnthropicConfig> {
  private client: Anthropic;
  private mcpClients: MCPClientWrapper[] = [];
  private mcpTools: Tool<SchemaType>[] = [];

  constructor(config: AnthropicConfig) {
    super(config);
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.apiBase,
    });

    // Initialize MCP clients if configured
    if (config.mcpServers && config.mcpServers.length > 0) {
      this.initializeMcpClients(config.mcpServers);
    }
  }

  /**
   * Initialize MCP clients and load tools
   */
  private async initializeMcpClients(
    serverConfigs: readonly MCPServerConfig[],
  ): Promise<void> {
    for (const serverConfig of serverConfigs) {
      try {
        const mcpClient = new MCPClientWrapper(serverConfig);
        this.mcpClients.push(mcpClient);

        // Connect and load tools
        await mcpClient.connect();
        const tools = await mcpClient.loadTools();
        this.mcpTools.push(...tools);
      } catch (error) {
        console.error(
          `Failed to initialize MCP client for ${serverConfig.url}:`,
          error,
        );
      }
    }
  }

  /**
   * Get all tools, including MCP tools
   */
  getAllTools(): Tool<SchemaType>[] {
    const configTools = this.config.tools || [];
    return [...configTools, ...this.mcpTools];
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
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object',
        properties: tool.schema.properties,
        required: tool.schema.required || [],
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

    // Get all tools, including MCP tools
    const allTools = this.getAllTools();
    const formattedTools = allTools.map((tool) => this.formatTool(tool));
    const response = (await this.client.messages.create({
      model: this.config.modelName,
      messages,
      system,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens || 1024,
      tools: formattedTools as AnthropicTool[],
    })) as unknown as AnthropicResponse;

    const metadata = createMetadata<AssistantMetadata>();
    let content = '';

    for (const block of response.content) {
      switch (block.type) {
        case 'text':
          content += block.text;
          break;
        case 'tool_use':
          metadata.set('toolCalls', [
            {
              name: block.name,
              arguments: block.input,
              id: block.id,
            },
          ]);
          break;
      }
    }

    // If there are tool calls, execute them
    const toolCalls = metadata.get('toolCalls');
    if (toolCalls && toolCalls.length > 0) {
      await this.handleToolCalls(toolCalls);
    }

    return {
      type: 'assistant',
      content,
      metadata,
    };
  }

  /**
   * Handle tool calls from the model
   */
  private async handleToolCalls(
    toolCalls: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      const { name, arguments: args } = toolCall;

      // Find the tool
      const tool = this.getAllTools().find((t) => t.name === name);

      if (!tool) {
        console.error(`Tool not found: ${name}`);
        continue;
      }

      try {
        // Execute the tool
        const result = await tool.execute(args as InferSchemaType<SchemaType>);

        // Add the result to the session
        // Note: This would require modifying the Session interface to allow adding messages
        // For now, we'll just log the result
        console.log(`Tool ${name} executed with result:`, result);
      } catch (error) {
        console.error(`Error executing tool ${name}:`, error);
      }
    }
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
