import type { Tool } from '../tool.js';
import type { ToolInformation } from '@modelcontextprotocol/sdk/types.js';
import { MCPClientWrapper } from './client.js';
import { 
  DynamicMCPToolFactory,
  DynamicMCPTool,
  type DynamicMCPToolConfig
} from './dynamic-tool.js';

/**
 * High-level options for MCP tool creation
 */
export interface MCPToolFactoryOptions {
  /** Prefix to add to all tool names */
  namePrefix?: string;
  
  /** Transform function for tool names */
  nameTransform?: (name: string) => string;
  
  /** Filter function to include/exclude tools */
  filter?: (tool: ToolInformation) => boolean;
  
  /** Whether to extract only text content from tool results (default: true) */
  extractTextOnly?: boolean;
  
  /** Custom result transformation function */
  resultTransform?: (result: any) => unknown;
  
  /** Custom handlers for specific tools */
  customHandlers?: Record<string, (params: unknown, client: MCPClientWrapper) => Promise<unknown>>;
  
  /** Additional configuration passed to dynamic tool factory */
  dynamicToolConfig?: DynamicMCPToolConfig;
}

/**
 * Information about a created MCP tool
 */
export interface MCPToolInfo {
  /** The name used in PromptTrail (with prefix/transform applied) */
  promptTrailName: string;
  
  /** The original MCP tool name */
  mcpName: string;
  
  /** The tool description */
  description: string;
  
  /** The AI SDK tool instance */
  tool: Tool;
  
  /** The dynamic MCP tool wrapper */
  dynamicTool: DynamicMCPTool;
  
  /** The original MCP tool information */
  mcpToolInfo: ToolInformation;
}

/**
 * Result of tool creation from an MCP server
 */
export interface MCPToolCreationResult {
  /** Tools as an object map (name -> Tool) */
  tools: Record<string, Tool>;
  
  /** Detailed information about each created tool */
  toolInfo: MCPToolInfo[];
  
  /** Total number of tools created */
  count: number;
  
  /** Names of tools that were created */
  names: string[];
  
  /** Names of tools that were available but filtered out */
  filteredOut: string[];
}

/**
 * High-level factory for creating PromptTrail tools from MCP servers
 */
export class MCPToolFactory {
  private dynamicFactory: DynamicMCPToolFactory;

  constructor(
    private mcpClient: MCPClientWrapper,
    private defaultOptions: MCPToolFactoryOptions = {}
  ) {
    this.dynamicFactory = new DynamicMCPToolFactory(mcpClient);
  }

  /**
   * Create all available tools from the connected MCP server
   */
  async createAllTools(options: MCPToolFactoryOptions = {}): Promise<MCPToolCreationResult> {
    const mergedOptions = { ...this.defaultOptions, ...options };
    
    if (!this.mcpClient.isConnected()) {
      throw new Error('MCP client must be connected before creating tools');
    }

    // Get all available tools from the server
    const toolsList = await this.mcpClient.listTools();
    const allTools = toolsList.tools;
    
    // Apply filter
    const filteredTools = mergedOptions.filter 
      ? allTools.filter(mergedOptions.filter)
      : allTools;
    
    const filteredOutNames = allTools
      .filter(tool => !filteredTools.includes(tool))
      .map(tool => tool.name);

    // Create dynamic tools
    const dynamicTools = await this.createDynamicTools(filteredTools, mergedOptions);
    
    // Build the result
    const tools: Record<string, Tool> = {};
    const toolInfo: MCPToolInfo[] = [];
    
    for (const dynamicTool of dynamicTools) {
      const promptTrailName = dynamicTool.getToolName();
      const mcpToolInfo = dynamicTool.getMCPToolInfo();
      
      tools[promptTrailName] = dynamicTool.getTool();
      toolInfo.push({
        promptTrailName,
        mcpName: mcpToolInfo.name,
        description: mcpToolInfo.description || '',
        tool: dynamicTool.getTool(),
        dynamicTool,
        mcpToolInfo,
      });
    }

    return {
      tools,
      toolInfo,
      count: dynamicTools.length,
      names: Object.keys(tools),
      filteredOut: filteredOutNames,
    };
  }

  /**
   * Create specific tools by name
   */
  async createToolsByName(
    toolNames: string[],
    options: MCPToolFactoryOptions = {}
  ): Promise<MCPToolCreationResult> {
    const mergedOptions = { 
      ...this.defaultOptions, 
      ...options,
      filter: (tool: ToolInformation) => {
        const nameMatch = toolNames.includes(tool.name);
        const customFilter = options.filter || this.defaultOptions.filter;
        return nameMatch && (customFilter ? customFilter(tool) : true);
      }
    };

    return await this.createAllTools(mergedOptions);
  }

  /**
   * Create tools matching a pattern
   */
  async createToolsMatching(
    pattern: RegExp | string,
    options: MCPToolFactoryOptions = {}
  ): Promise<MCPToolCreationResult> {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    
    const mergedOptions = { 
      ...this.defaultOptions, 
      ...options,
      filter: (tool: ToolInformation) => {
        const nameMatch = regex.test(tool.name);
        const customFilter = options.filter || this.defaultOptions.filter;
        return nameMatch && (customFilter ? customFilter(tool) : true);
      }
    };

    return await this.createAllTools(mergedOptions);
  }

  /**
   * Preview available tools without creating them
   */
  async previewTools(filter?: (tool: ToolInformation) => boolean): Promise<{
    available: ToolInformation[];
    count: number;
    names: string[];
  }> {
    if (!this.mcpClient.isConnected()) {
      throw new Error('MCP client must be connected before previewing tools');
    }

    const toolsList = await this.mcpClient.listTools();
    const available = filter ? toolsList.tools.filter(filter) : toolsList.tools;
    
    return {
      available,
      count: available.length,
      names: available.map(tool => tool.name),
    };
  }

  /**
   * Get information about a specific tool without creating it
   */
  async getToolInfo(toolName: string): Promise<ToolInformation | null> {
    if (!this.mcpClient.isConnected()) {
      throw new Error('MCP client must be connected');
    }

    const toolsList = await this.mcpClient.listTools();
    return toolsList.tools.find(tool => tool.name === toolName) || null;
  }

  private async createDynamicTools(
    mcpTools: ToolInformation[],
    options: MCPToolFactoryOptions
  ): Promise<DynamicMCPTool[]> {
    const dynamicConfig: DynamicMCPToolConfig = {
      namePrefix: options.namePrefix,
      nameTransform: options.nameTransform,
      extractTextOnly: options.extractTextOnly ?? true,
      resultTransform: options.resultTransform,
      ...options.dynamicToolConfig,
    };

    const dynamicTools: DynamicMCPTool[] = [];

    for (const mcpTool of mcpTools) {
      let toolConfig = { ...dynamicConfig };
      
      // Apply custom handler if available
      if (options.customHandlers && options.customHandlers[mcpTool.name]) {
        toolConfig.customHandler = options.customHandlers[mcpTool.name];
      }

      const dynamicTool = this.dynamicFactory.createTool(mcpTool, toolConfig);
      dynamicTools.push(dynamicTool);
    }

    return dynamicTools;
  }
}

/**
 * Convenience functions for common MCP tool creation patterns
 */
export namespace MCPTools {
  /**
   * Quick creation of all tools from an MCP server
   */
  export async function createAll(
    mcpClient: MCPClientWrapper,
    options?: MCPToolFactoryOptions
  ): Promise<Record<string, Tool>> {
    const factory = new MCPToolFactory(mcpClient);
    const result = await factory.createAllTools(options);
    return result.tools;
  }

  /**
   * Create tools with a specific prefix
   */
  export async function withPrefix(
    mcpClient: MCPClientWrapper,
    prefix: string,
    options?: Omit<MCPToolFactoryOptions, 'namePrefix'>
  ): Promise<Record<string, Tool>> {
    return await createAll(mcpClient, { ...options, namePrefix: prefix });
  }

  /**
   * Create tools that match a pattern
   */
  export async function matching(
    mcpClient: MCPClientWrapper,
    pattern: RegExp | string,
    options?: MCPToolFactoryOptions
  ): Promise<Record<string, Tool>> {
    const factory = new MCPToolFactory(mcpClient);
    const result = await factory.createToolsMatching(pattern, options);
    return result.tools;
  }

  /**
   * Create specific tools by name
   */
  export async function named(
    mcpClient: MCPClientWrapper,
    names: string[],
    options?: MCPToolFactoryOptions
  ): Promise<Record<string, Tool>> {
    const factory = new MCPToolFactory(mcpClient);
    const result = await factory.createToolsByName(names, options);
    return result.tools;
  }

  /**
   * Create tools with detailed information
   */
  export async function withInfo(
    mcpClient: MCPClientWrapper,
    options?: MCPToolFactoryOptions
  ): Promise<MCPToolCreationResult> {
    const factory = new MCPToolFactory(mcpClient);
    return await factory.createAllTools(options);
  }
}