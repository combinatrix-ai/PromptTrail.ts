/**
 * Mock Anthropic model for testing
 *
 * This is a simplified mock implementation that uses our mock MCP client.
 */
import type { Message, Session, AssistantMetadata } from '../../../types';
import { createMetadata } from '../../../metadata';
import type { MCPServerConfig } from '../../../model/anthropic/mcp';
import { MockMCPClientWrapper } from '../mcp_client/mock_mcp_client';

/**
 * Mock Anthropic model for testing
 */
export class MockAnthropicModel {
  private mcpClients: MockMCPClientWrapper[] = [];

  constructor(
    private config: {
      apiKey: string;
      modelName: string;
      temperature: number;
      mcpServers?: MCPServerConfig[];
    },
  ) {
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
        const mcpClient = new MockMCPClientWrapper(serverConfig);
        this.mcpClients.push(mcpClient);

        // Connect and load tools
        await mcpClient.connect();
        await mcpClient.loadTools();
      } catch (error) {
        console.error(
          `Failed to initialize MCP client for ${serverConfig.url}:`,
          error,
        );
      }
    }
  }

  /**
   * Send a message to the model
   */
  async send(/* unused */): Promise<Message> {
    // Mock response with tool call
    const metadata = createMetadata<AssistantMetadata>();

    const toolCalls = [
      {
        name: 'calculator',
        arguments: {
          operation: 'add',
          a: 5,
          b: 3,
        },
        id: 'tool-1',
      },
    ];

    metadata.set('toolCalls', toolCalls);

    // If there are tool calls, execute them
    if (toolCalls && toolCalls.length > 0) {
      await this.handleToolCalls(toolCalls);
    }

    return {
      type: 'assistant',
      content: 'I can help with that!',
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
      id: string;
    }>,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      const { name, arguments: args } = toolCall;

      // Find the tool in any of the MCP clients
      let tool = null;
      for (const client of this.mcpClients) {
        const clientTool = client.getTool(name);
        if (clientTool) {
          tool = clientTool;
          break;
        }
      }

      if (!tool) {
        console.error(`Tool not found: ${name}`);
        continue;
      }

      try {
        // Execute the tool
        const result = await tool.execute(args as unknown as Parameters<typeof tool.execute>[0]);

        // Log the result
        console.log(`Tool ${name} executed with result:`, result);
      } catch (error) {
        console.error(`Error executing tool ${name}:`, error);
      }
    }
  }
}
