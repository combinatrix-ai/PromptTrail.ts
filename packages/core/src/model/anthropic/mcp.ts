/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Anthropic Model Context Protocol (MCP) integration for PromptTrail
 */
import type { Tool, SchemaType } from '../../tool';
import { createTool } from '../../tool';

// Define PropertySchema locally since it's not exported from tool.ts
type PropertySchema =
  | { type: 'string'; description: string }
  | { type: 'number'; description: string }
  | { type: 'boolean'; description: string };

/**
 * MCP server configuration
 */
export interface MCPServerConfig {
  url: string;
  name?: string;
  version?: string;
}

/**
 * MCP client wrapper for PromptTrail
 *
 * This is a simplified implementation that uses the MCP SDK
 * but handles the types internally to avoid dependency issues.
 */
export class MCPClientWrapper {
  // Define a minimal interface for the MCP client to avoid using 'any'
  private client: {
    connect: (transport: unknown) => Promise<void>;
    close: () => Promise<void>;
    listTools: () => Promise<{
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema: {
          properties: Record<string, unknown>;
          required?: string[];
        };
      }>;
    }>;
    callTool: (params: {
      name: string;
      arguments: unknown;
    }) => Promise<{
      isError: boolean;
      content?: Array<{
        type?: string;
        text?: string;
        resource?: { text?: string };
      }>;
    }>;
    readResource: (params: {
      uri: string;
    }) => Promise<{ contents?: Array<{ text?: string }> }>;
    listResources: () => Promise<{
      resources?: Array<{ uri: string; name: string; description?: string }>;
    }>;
    getPrompt: (params: {
      name: string;
      parameters: Record<string, unknown>;
    }) => Promise<{ messages?: Array<{ role: string; content: string }> }>;
  };
  private connected: boolean = false;
  private tools: Map<string, Tool<SchemaType>> = new Map();

  constructor(private config: MCPServerConfig) {
    // Dynamically import the MCP SDK to avoid type issues
    try {
      // In a real implementation, we would use proper imports
      // This is just a workaround for the current implementation

      const mcpSdk = require('@modelcontextprotocol/sdk');
      this.client = new mcpSdk.Client(
        {
          name: config.name || 'prompttrail-client',
          version: config.version || '1.0.0',
        },
        {
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
        },
      );
    } catch (error) {
      console.error('Failed to initialize MCP client:', error);
      throw new Error(
        'Failed to initialize MCP client. Make sure @modelcontextprotocol/sdk is installed.',
      );
    }
  }

  /**
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      const mcpSdk = require('@modelcontextprotocol/sdk');
      const transport = new mcpSdk.HttpClientTransport({
        url: this.config.url,
      });
      await this.client.connect(transport);
      this.connected = true;
    } catch (error) {
      console.error('Failed to connect to MCP server:', error);
      throw new Error(`Failed to connect to MCP server at ${this.config.url}`);
    }
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.close();
      this.connected = false;
    } catch (error) {
      console.error('Failed to disconnect from MCP server:', error);
    }
  }

  /**
   * Discover and load tools from the MCP server
   */
  async loadTools(): Promise<Tool<SchemaType>[]> {
    if (!this.connected) {
      await this.connect();
    }

    try {
      const toolDefs = await this.client.listTools();
      const mcpTools: Tool<SchemaType>[] = [];

      // Handle different response formats
      const tools = toolDefs.tools || [];

      for (const def of tools) {
        const tool = createTool({
          name: def.name,
          description: def.description || `MCP Tool: ${def.name}`,
          schema: {
            properties: def.inputSchema.properties as Record<
              string,
              PropertySchema
            >,
            required: def.inputSchema.required || [],
          },
          execute: async (args) => {
            try {
              const result = await this.client.callTool({
                name: def.name,
                arguments: args,
              });

              if (result.isError) {
                const errorMsg =
                  result.content
                    ?.map((c: { text?: string }) => c.text)
                    .filter(Boolean)
                    .join('\n') || 'Unknown error';

                return { result: { error: errorMsg } };
              }

              // Concatenate text outputs
              const outputText = result.content
                ?.map(
                  (c: {
                    type?: string;
                    text?: string;
                    resource?: { text?: string };
                  }) => {
                    if (c.type === 'text') return c.text;
                    if (c.type === 'resource' && c.resource?.text)
                      return c.resource.text;
                    return '';
                  },
                )
                .filter(Boolean)
                .join('\n');

              return { result: outputText || '' };
            } catch (error) {
              return {
                result: {
                  error: error instanceof Error ? error.message : String(error),
                },
              };
            }
          },
        });

        mcpTools.push(tool);
        this.tools.set(tool.name, tool);
      }

      return mcpTools;
    } catch (error) {
      console.error('Failed to load tools from MCP server:', error);
      throw new Error('Failed to load tools from MCP server');
    }
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): Tool<SchemaType> | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all loaded tools
   */
  getAllTools(): Tool<SchemaType>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Read a resource from the MCP server
   */
  async readResource(uri: string): Promise<string> {
    if (!this.connected) {
      await this.connect();
    }

    try {
      const result = await this.client.readResource({ uri });

      if (!result.contents || result.contents.length === 0) {
        return '';
      }

      return result.contents
        .map((content: { text?: string }) => content.text || '')
        .filter(Boolean)
        .join('\n');
    } catch (error) {
      throw new Error(
        `Failed to read resource ${uri}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * List available resources from the MCP server
   */
  async listResources(): Promise<
    { uri: string; name: string; description?: string }[]
  > {
    if (!this.connected) {
      await this.connect();
    }

    try {
      const result = await this.client.listResources();

      return (result.resources || []).map(
        (resource: { uri: string; name: string; description?: string }) => ({
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
        }),
      );
    } catch (error) {
      throw new Error(
        `Failed to list resources: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get a prompt from the MCP server
   */
  async getPrompt(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<{ role: string; content: string }[]> {
    if (!this.connected) {
      await this.connect();
    }

    try {
      const result = await this.client.getPrompt({
        name,
        parameters: params || {},
      });

      return (result.messages || []).map(
        (message: { role: string; content: string }) => ({
          role: message.role,
          content: message.content,
        }),
      );
    } catch (error) {
      throw new Error(
        `Failed to get prompt ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
