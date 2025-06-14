import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { 
  CallToolResult, 
  ReadResourceResult, 
  GetPromptResult,
  ListToolsResult,
  ListResourcesResult,
  ListPromptsResult,
  ServerInfo
} from '@modelcontextprotocol/sdk/types.js';

export interface MCPConnectionOptions {
  type: 'stdio' | 'http';
  url?: string;
  command?: string;
  args?: string[];
  environment?: Record<string, string>;
}

export interface MCPToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface MCPResourceRead {
  uri: string;
}

export interface MCPPromptRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Wrapper for MCP client functionality
 */
export class MCPClientWrapper {
  private client: MCPClient;
  private connected = false;

  constructor(private options: {
    name: string;
    version: string;
  }) {
    this.client = new MCPClient(options);
  }

  /**
   * Connect to an MCP server
   */
  async connect(connection: MCPConnectionOptions): Promise<void> {
    if (this.connected) {
      throw new Error('Already connected to an MCP server');
    }

    let transport;
    if (connection.type === 'stdio') {
      if (!connection.command) {
        throw new Error('Command is required for stdio transport');
      }
      transport = new StdioClientTransport({
        command: connection.command,
        args: connection.args || [],
        env: connection.environment,
      });
    } else {
      if (!connection.url) {
        throw new Error('URL is required for HTTP transport');
      }
      transport = new StreamableHTTPClientTransport(new URL(connection.url));
    }

    await this.client.connect(transport);
    this.connected = true;
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }
    await this.client.close();
    this.connected = false;
  }

  /**
   * Get server information
   */
  async getServerInfo(): Promise<ServerInfo> {
    this.ensureConnected();
    return await this.client.getServerInfo();
  }

  /**
   * List available tools
   */
  async listTools(): Promise<ListToolsResult> {
    this.ensureConnected();
    return await this.client.listTools();
  }

  /**
   * Call a tool
   */
  async callTool(tool: MCPToolCall): Promise<CallToolResult> {
    this.ensureConnected();
    return await this.client.callTool({
      name: tool.name,
      arguments: tool.arguments || {},
    });
  }

  /**
   * List available resources
   */
  async listResources(): Promise<ListResourcesResult> {
    this.ensureConnected();
    return await this.client.listResources();
  }

  /**
   * Read a resource
   */
  async readResource(resource: MCPResourceRead): Promise<ReadResourceResult> {
    this.ensureConnected();
    return await this.client.readResource(resource);
  }

  /**
   * List available prompts
   */
  async listPrompts(): Promise<ListPromptsResult> {
    this.ensureConnected();
    return await this.client.listPrompts();
  }

  /**
   * Get a prompt
   */
  async getPrompt(prompt: MCPPromptRequest): Promise<GetPromptResult> {
    this.ensureConnected();
    return await this.client.getPrompt({
      name: prompt.name,
      arguments: prompt.arguments || {},
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('Not connected to an MCP server. Call connect() first.');
    }
  }
}

/**
 * Create an MCP client
 */
export function createMCPClient(options?: {
  name?: string;
  version?: string;
}): MCPClientWrapper {
  return new MCPClientWrapper({
    name: options?.name || 'prompttrail-mcp-client',
    version: options?.version || '1.0.0',
  });
}