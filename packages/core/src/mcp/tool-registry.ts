import type { Tool } from '../tool.js';
import type { MCPToolInfo, MCPToolCreationResult } from './tool-factory.js';
import { MCPClientWrapper } from './client.js';

/**
 * Registry for managing created MCP tools
 */
export class MCPToolRegistry {
  private tools = new Map<string, MCPToolInfo>();
  private clients = new Map<string, MCPClientWrapper>();

  /**
   * Register tools from a creation result
   */
  register(
    clientId: string,
    client: MCPClientWrapper,
    result: MCPToolCreationResult
  ): void {
    this.clients.set(clientId, client);
    
    for (const toolInfo of result.toolInfo) {
      const key = `${clientId}:${toolInfo.promptTrailName}`;
      this.tools.set(key, toolInfo);
    }
  }

  /**
   * Get a specific tool by client ID and tool name
   */
  getTool(clientId: string, toolName: string): Tool | null {
    const key = `${clientId}:${toolName}`;
    const toolInfo = this.tools.get(key);
    return toolInfo?.tool || null;
  }

  /**
   * Get all tools for a specific client
   */
  getToolsForClient(clientId: string): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    
    for (const [key, toolInfo] of this.tools.entries()) {
      if (key.startsWith(`${clientId}:`)) {
        tools[toolInfo.promptTrailName] = toolInfo.tool;
      }
    }
    
    return tools;
  }

  /**
   * Get all tools across all clients
   */
  getAllTools(): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    
    for (const toolInfo of this.tools.values()) {
      tools[toolInfo.promptTrailName] = toolInfo.tool;
    }
    
    return tools;
  }

  /**
   * Get tool information
   */
  getToolInfo(clientId: string, toolName: string): MCPToolInfo | null {
    const key = `${clientId}:${toolName}`;
    return this.tools.get(key) || null;
  }

  /**
   * Get all tool information for a client
   */
  getToolInfoForClient(clientId: string): MCPToolInfo[] {
    const toolInfos: MCPToolInfo[] = [];
    
    for (const [key, toolInfo] of this.tools.entries()) {
      if (key.startsWith(`${clientId}:`)) {
        toolInfos.push(toolInfo);
      }
    }
    
    return toolInfos;
  }

  /**
   * List all registered clients
   */
  getClients(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Get a client by ID
   */
  getClient(clientId: string): MCPClientWrapper | null {
    return this.clients.get(clientId) || null;
  }

  /**
   * Check if a client is registered
   */
  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  /**
   * Check if a tool exists
   */
  hasTool(clientId: string, toolName: string): boolean {
    const key = `${clientId}:${toolName}`;
    return this.tools.has(key);
  }

  /**
   * Unregister all tools for a client
   */
  unregisterClient(clientId: string): void {
    // Remove client
    this.clients.delete(clientId);
    
    // Remove all tools for this client
    const keysToDelete: string[] = [];
    for (const key of this.tools.keys()) {
      if (key.startsWith(`${clientId}:`)) {
        keysToDelete.push(key);
      }
    }
    
    for (const key of keysToDelete) {
      this.tools.delete(key);
    }
  }

  /**
   * Unregister a specific tool
   */
  unregisterTool(clientId: string, toolName: string): boolean {
    const key = `${clientId}:${toolName}`;
    return this.tools.delete(key);
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.tools.clear();
    this.clients.clear();
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    totalClients: number;
    totalTools: number;
    toolsByClient: Record<string, number>;
  } {
    const toolsByClient: Record<string, number> = {};
    
    for (const clientId of this.clients.keys()) {
      toolsByClient[clientId] = 0;
    }
    
    for (const key of this.tools.keys()) {
      const clientId = key.split(':')[0];
      if (toolsByClient[clientId] !== undefined) {
        toolsByClient[clientId]++;
      }
    }
    
    return {
      totalClients: this.clients.size,
      totalTools: this.tools.size,
      toolsByClient,
    };
  }

  /**
   * Find tools by pattern across all clients
   */
  findTools(pattern: RegExp | string): MCPToolInfo[] {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    const matches: MCPToolInfo[] = [];
    
    for (const toolInfo of this.tools.values()) {
      if (regex.test(toolInfo.promptTrailName) || 
          regex.test(toolInfo.mcpName) ||
          regex.test(toolInfo.description)) {
        matches.push(toolInfo);
      }
    }
    
    return matches;
  }
}

/**
 * Global registry instance
 */
export const globalMCPToolRegistry = new MCPToolRegistry();