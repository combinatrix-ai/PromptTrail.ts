/**
 * GenerateOptions with fluent API for adding tools
 */
import type { ProviderConfig, GenerateMCPServerConfig } from './generate';
import { z } from 'zod';

// Define a type for tool definitions since it's not exported from ai-sdk
type ToolDefinition<T = any> = any;

/**
 * Class-based implementation of GenerateOptions with fluent tool addition
 */
export class GenerateOptions {
  provider: ProviderConfig;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  tools: Record<string, unknown> = {};
  toolChoice?: 'auto' | 'required' | 'none';
  mcpServers?: GenerateMCPServerConfig[];
  sdkOptions?: Record<string, unknown>;

  constructor(options: {
    provider: ProviderConfig;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    topK?: number;
    tools?: Record<string, unknown>;
    toolChoice?: 'auto' | 'required' | 'none';
    mcpServers?: GenerateMCPServerConfig[];
    sdkOptions?: Record<string, unknown>;
  }) {
    this.provider = options.provider;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.topP = options.topP;
    this.topK = options.topK;
    this.tools = options.tools || {};
    this.toolChoice = options.toolChoice;
    this.mcpServers = options.mcpServers;
    this.sdkOptions = options.sdkOptions;
  }

  /**
   * Add a tool to the generate options
   * @param name The name of the tool
   * @param tool The tool definition
   * @returns The updated GenerateOptions instance for chaining
   */
  addTool<T extends ToolDefinition<any>>(name: string, tool: T): this {
    this.tools = {
      ...this.tools,
      [name]: tool,
    };
    return this;
  }

  /**
   * Add multiple tools to the generate options
   * @param tools Record of tool names to tool definitions
   * @returns The updated GenerateOptions instance for chaining
   */
  addTools(tools: Record<string, unknown>): this {
    this.tools = {
      ...this.tools,
      ...tools,
    };
    return this;
  }

  /**
   * Set the tool choice option
   * @param choice The tool choice option
   * @returns The updated GenerateOptions instance for chaining
   */
  setToolChoice(choice: 'auto' | 'required' | 'none'): this {
    this.toolChoice = choice;
    return this;
  }

  /**
   * Create a new instance with the same options
   * @returns A new GenerateOptions instance with the same options
   */
  clone(): GenerateOptions {
    return new GenerateOptions({
      provider: this.provider,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      topP: this.topP,
      topK: this.topK,
      tools: { ...this.tools },
      toolChoice: this.toolChoice,
      mcpServers: this.mcpServers ? [...this.mcpServers] : undefined,
      sdkOptions: this.sdkOptions ? { ...this.sdkOptions } : undefined,
    });
  }

  /**
   * Convert to a plain object for use with ai-sdk
   */
  toObject(): Record<string, unknown> {
    return {
      provider: this.provider,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      topP: this.topP,
      topK: this.topK,
      tools: this.tools,
      toolChoice: this.toolChoice,
      mcpServers: this.mcpServers,
      sdkOptions: this.sdkOptions,
    };
  }
}

/**
 * Create a new GenerateOptions instance
 */
export function createGenerateOptions(options: {
  provider: ProviderConfig;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  tools?: Record<string, unknown>;
  toolChoice?: 'auto' | 'required' | 'none';
  mcpServers?: GenerateMCPServerConfig[];
  sdkOptions?: Record<string, unknown>;
}): GenerateOptions {
  return new GenerateOptions(options);
}
