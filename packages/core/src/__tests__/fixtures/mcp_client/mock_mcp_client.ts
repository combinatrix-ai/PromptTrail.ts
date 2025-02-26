/**
 * Mock MCP client for testing
 *
 * This is a simplified mock implementation that doesn't rely on the actual MCP SDK.
 * It provides a similar interface but uses HTTP directly.
 */
import type { Tool, SchemaType } from '../../../tool';
import { createTool } from '../../../tool';
import type { MCPServerConfig } from '../../../model/anthropic/mcp';
import * as http from 'http';

/**
 * Mock MCP client wrapper for testing
 */
export class MockMCPClientWrapper {
  private connected: boolean = false;
  private tools: Map<string, Tool<SchemaType>> = new Map();
  private baseUrl: string;

  constructor(private config: MCPServerConfig) {
    this.baseUrl = config.url;
  }

  /**
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      // Just a simple ping to check if the server is running
      await this.makeRequest('ping', {});
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
    this.connected = false;
  }

  /**
   * Discover and load tools from the MCP server
   */
  async loadTools(): Promise<Tool<SchemaType>[]> {
    if (!this.connected) {
      await this.connect();
    }

    try {
      const response = await this.makeRequest('listTools', {});
      const toolDefs = response.tools || [];
      const mcpTools: Tool<SchemaType>[] = [];

      for (const def of toolDefs) {
        const tool = createTool({
          name: def.name,
          description: def.description || `MCP Tool: ${def.name}`,
          schema: {
            properties: def.inputSchema.properties as Record<string, any>,
            required: def.inputSchema.required || [],
          },
          execute: async (args) => {
            try {
              const result = await this.makeRequest('callTool', {
                name: def.name,
                arguments: args,
              });

              if (result.isError) {
                const errorMsg =
                  result.content
                    ?.map((c: any) => c.text)
                    .filter(Boolean)
                    .join('\n') || 'Unknown error';

                return { result: { error: errorMsg } };
              }

              // Concatenate text outputs
              const outputText = result.content
                ?.map((c: any) => {
                  if (c.type === 'text') return c.text;
                  if (c.type === 'resource' && c.resource?.text)
                    return c.resource.text;
                  return '';
                })
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
      const result = await this.makeRequest('readResource', { uri });

      if (!result.contents || result.contents.length === 0) {
        return '';
      }

      return result.contents
        .map((content: any) => content.text || '')
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
      const result = await this.makeRequest('listResources', {});

      return (result.resources || []).map((resource: any) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
      }));
    } catch (error) {
      throw new Error(
        `Failed to list resources: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Make a request to the MCP server
   */
  private makeRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: Date.now(),
      });

      const url = new URL(this.baseUrl);

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      };

      const req = http.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            if (method === 'ping') {
              // Special case for ping
              resolve({});
              return;
            }

            const parsedData = JSON.parse(responseData);

            if (parsedData.error) {
              reject(new Error(parsedData.error));
              return;
            }

            resolve(parsedData);
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(data);
      req.end();
    });
  }
}
