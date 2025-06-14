import { tool as aiTool, type Tool as AiSdkTool } from 'ai';
import { z } from 'zod';
import type { ToolInformation, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCPClientWrapper } from './client.js';
import { mcpToolSchemaToZod, type JsonSchema } from './schema-converter.js';

/**
 * Configuration for creating dynamic MCP tools
 */
export interface DynamicMCPToolConfig {
  namePrefix?: string;
  nameTransform?: (name: string) => string;
  customHandler?: (params: unknown, client: MCPClientWrapper) => Promise<unknown>;
  resultTransform?: (result: CallToolResult) => unknown;
  extractTextOnly?: boolean;
}

/**
 * Creates a dynamic PromptTrail tool from an MCP tool definition
 */
export class DynamicMCPTool {
  private zodSchema: z.ZodTypeAny;
  private aiSdkTool: AiSdkTool;

  constructor(
    private mcpToolInfo: ToolInformation,
    private mcpClient: MCPClientWrapper,
    private config: DynamicMCPToolConfig = {}
  ) {
    this.zodSchema = this.createZodSchema();
    this.aiSdkTool = this.createAiSdkTool();
  }

  /**
   * Get the AI SDK tool instance
   */
  getTool(): AiSdkTool {
    return this.aiSdkTool;
  }

  /**
   * Get the tool name (with prefix applied)
   */
  getToolName(): string {
    const name = this.config.nameTransform 
      ? this.config.nameTransform(this.mcpToolInfo.name)
      : this.mcpToolInfo.name;
    
    return this.config.namePrefix 
      ? `${this.config.namePrefix}${name}`
      : name;
  }

  /**
   * Get the original MCP tool information
   */
  getMCPToolInfo(): ToolInformation {
    return this.mcpToolInfo;
  }

  private createZodSchema(): z.ZodTypeAny {
    if (!this.mcpToolInfo.inputSchema) {
      return z.object({});
    }

    try {
      return mcpToolSchemaToZod(this.mcpToolInfo.inputSchema as JsonSchema);
    } catch (error) {
      console.warn(`Failed to convert schema for tool ${this.mcpToolInfo.name}:`, error);
      return z.object({}).passthrough(); // Fallback to permissive object
    }
  }

  private createAiSdkTool(): AiSdkTool {
    const toolName = this.getToolName();
    
    return aiTool({
      description: this.mcpToolInfo.description || `MCP tool: ${this.mcpToolInfo.name}`,
      parameters: this.zodSchema,
      execute: async (params: unknown) => {
        if (this.config.customHandler) {
          return await this.config.customHandler(params, this.mcpClient);
        }

        try {
          const result = await this.mcpClient.callTool({
            name: this.mcpToolInfo.name,
            arguments: params as Record<string, unknown>,
          });

          if (this.config.resultTransform) {
            return this.config.resultTransform(result);
          }

          if (this.config.extractTextOnly) {
            // Extract only text content
            const textContent = result.content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
            return textContent || 'No text content returned';
          }

          // Return the full result
          return result;
        } catch (error) {
          throw new Error(`MCP tool call failed for ${this.mcpToolInfo.name}: ${error.message}`);
        }
      },
    }) as AiSdkTool;
  }
}

/**
 * Factory for creating multiple dynamic MCP tools
 */
export class DynamicMCPToolFactory {
  constructor(
    private mcpClient: MCPClientWrapper,
    private globalConfig: DynamicMCPToolConfig = {}
  ) {}

  /**
   * Create a single dynamic tool from MCP tool information
   */
  createTool(
    mcpToolInfo: ToolInformation, 
    config: DynamicMCPToolConfig = {}
  ): DynamicMCPTool {
    const mergedConfig = { ...this.globalConfig, ...config };
    return new DynamicMCPTool(mcpToolInfo, this.mcpClient, mergedConfig);
  }

  /**
   * Create multiple tools from an array of MCP tool information
   */
  createTools(
    mcpToolInfos: ToolInformation[],
    config: DynamicMCPToolConfig = {}
  ): DynamicMCPTool[] {
    return mcpToolInfos.map(info => this.createTool(info, config));
  }

  /**
   * Create tools from the connected MCP server
   */
  async createToolsFromServer(options: {
    filter?: (tool: ToolInformation) => boolean;
    config?: DynamicMCPToolConfig;
  } = {}): Promise<DynamicMCPTool[]> {
    if (!this.mcpClient.isConnected()) {
      throw new Error('MCP client must be connected before creating tools');
    }

    const toolsList = await this.mcpClient.listTools();
    let tools = toolsList.tools;

    // Apply filter if provided
    if (options.filter) {
      tools = tools.filter(options.filter);
    }

    return this.createTools(tools, options.config);
  }

  /**
   * Create a tools object suitable for use with LLM providers
   */
  async createToolsObject(options: {
    filter?: (tool: ToolInformation) => boolean;
    config?: DynamicMCPToolConfig;
  } = {}): Promise<Record<string, AiSdkTool>> {
    const dynamicTools = await this.createToolsFromServer(options);
    const toolsObject: Record<string, AiSdkTool> = {};

    for (const dynamicTool of dynamicTools) {
      toolsObject[dynamicTool.getToolName()] = dynamicTool.getTool();
    }

    return toolsObject;
  }
}

/**
 * Utility functions for working with dynamic MCP tools
 */
export namespace DynamicMCPTools {
  /**
   * Create a factory with common configurations
   */
  export function createFactory(
    mcpClient: MCPClientWrapper,
    config?: DynamicMCPToolConfig
  ): DynamicMCPToolFactory {
    return new DynamicMCPToolFactory(mcpClient, config);
  }

  /**
   * Quick function to create all tools from an MCP server
   */
  export async function fromServer(
    mcpClient: MCPClientWrapper,
    options: {
      namePrefix?: string;
      filter?: (tool: ToolInformation) => boolean;
      extractTextOnly?: boolean;
    } = {}
  ): Promise<Record<string, AiSdkTool>> {
    const factory = new DynamicMCPToolFactory(mcpClient, {
      namePrefix: options.namePrefix,
      extractTextOnly: options.extractTextOnly ?? true,
    });

    return await factory.createToolsObject({
      filter: options.filter,
    });
  }

  /**
   * Create tools with custom naming conventions
   */
  export async function withNaming(
    mcpClient: MCPClientWrapper,
    options: {
      prefix?: string;
      transform?: (name: string) => string;
      filter?: (tool: ToolInformation) => boolean;
    } = {}
  ): Promise<Record<string, AiSdkTool>> {
    const factory = new DynamicMCPToolFactory(mcpClient, {
      namePrefix: options.prefix,
      nameTransform: options.transform,
      extractTextOnly: true,
    });

    return await factory.createToolsObject({
      filter: options.filter,
    });
  }

  /**
   * Create tools with custom result processing
   */
  export async function withResultTransform(
    mcpClient: MCPClientWrapper,
    resultTransform: (result: CallToolResult) => unknown,
    options: {
      filter?: (tool: ToolInformation) => boolean;
      namePrefix?: string;
    } = {}
  ): Promise<Record<string, AiSdkTool>> {
    const factory = new DynamicMCPToolFactory(mcpClient, {
      namePrefix: options.namePrefix,
      resultTransform,
    });

    return await factory.createToolsObject({
      filter: options.filter,
    });
  }

  /**
   * Create tools with custom handlers for specific tools
   */
  export async function withCustomHandlers(
    mcpClient: MCPClientWrapper,
    customHandlers: Record<string, (params: unknown, client: MCPClientWrapper) => Promise<unknown>>,
    options: {
      filter?: (tool: ToolInformation) => boolean;
      namePrefix?: string;
    } = {}
  ): Promise<Record<string, AiSdkTool>> {
    const factory = new DynamicMCPToolFactory(mcpClient);
    const toolsList = await mcpClient.listTools();
    let tools = toolsList.tools;

    if (options.filter) {
      tools = tools.filter(options.filter);
    }

    const toolsObject: Record<string, AiSdkTool> = {};

    for (const toolInfo of tools) {
      const config: DynamicMCPToolConfig = {
        namePrefix: options.namePrefix,
        extractTextOnly: true,
      };

      if (customHandlers[toolInfo.name]) {
        config.customHandler = customHandlers[toolInfo.name];
      }

      const dynamicTool = factory.createTool(toolInfo, config);
      toolsObject[dynamicTool.getToolName()] = dynamicTool.getTool();
    }

    return toolsObject;
  }
}