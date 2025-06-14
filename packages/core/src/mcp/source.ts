import { MCPClientWrapper, MCPToolCall, MCPResourceRead, MCPPromptRequest } from './client.js';
import { Source, StringSource } from '../source.js';
import { Session } from '../session.js';
import type { ValidationOptions } from '../validation.js';
import type { ModelOutput } from '../generation/types.js';
import { z } from 'zod';

// MCP-specific source configurations
export interface MCPToolSourceOptions extends ValidationOptions {
  tool: string;
  arguments?: Record<string, unknown>;
  extractText?: boolean; // Extract text content from tool result
}

export interface MCPResourceSourceOptions extends ValidationOptions {
  uri: string;
  extractText?: boolean; // Extract text content from resource
}

export interface MCPPromptSourceOptions extends ValidationOptions {
  prompt: string;
  arguments?: Record<string, unknown>;
  format?: 'text' | 'messages'; // How to format prompt result
}

/**
 * Source that calls an MCP tool
 */
export class MCPToolSource extends StringSource {
  constructor(
    private client: MCPClientWrapper,
    private options: MCPToolSourceOptions
  ) {
    super(options);
  }

  async getContent(_session: Session<any, any>): Promise<string> {
    const toolCall: MCPToolCall = {
      name: this.options.tool,
      arguments: this.options.arguments,
    };

    const result = await this.client.callTool(toolCall);

    if (this.options.extractText) {
      // Extract text content from the result
      const textContent = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      return textContent;
    }

    // Return full JSON result as string
    return JSON.stringify(result, null, 2);
  }
}

/**
 * Source that reads an MCP resource
 */
export class MCPResourceSource extends StringSource {
  constructor(
    private client: MCPClientWrapper,
    private options: MCPResourceSourceOptions
  ) {
    super(options);
  }

  async getContent(_session: Session<any, any>): Promise<string> {
    const resource: MCPResourceRead = {
      uri: this.options.uri,
    };

    const result = await this.client.readResource(resource);

    if (this.options.extractText) {
      // Extract text content from the resource
      const textContent = result.contents
        .map(c => c.text || '')
        .join('\n');
      return textContent;
    }

    // Return full JSON result as string
    return JSON.stringify(result, null, 2);
  }
}

/**
 * Source that gets an MCP prompt
 */
export class MCPPromptSource extends StringSource {
  constructor(
    private client: MCPClientWrapper,
    private options: MCPPromptSourceOptions
  ) {
    super(options);
  }

  async getContent(_session: Session<any, any>): Promise<string> {
    const promptRequest: MCPPromptRequest = {
      name: this.options.prompt,
      arguments: this.options.arguments,
    };

    const result = await this.client.getPrompt(promptRequest);

    if (this.options.format === 'messages') {
      // Format as conversation messages
      return result.messages
        .map(msg => `${msg.role}: ${JSON.stringify(msg.content)}`)
        .join('\n\n');
    }

    // Return full JSON result as string
    return JSON.stringify(result, null, 2);
  }
}

/**
 * Source that can call MCP tools and return structured output
 */
export class MCPModelSource extends Source<ModelOutput> {
  constructor(
    private client: MCPClientWrapper,
    private toolName: string,
    private schema?: z.ZodType<any>
  ) {
    super();
  }

  async getContent(session: Session<any, any>): Promise<ModelOutput> {
    // Extract arguments from session context
    const args = session.vars as Record<string, unknown>;

    const toolCall: MCPToolCall = {
      name: this.toolName,
      arguments: args,
    };

    const result = await this.client.callTool(toolCall);

    // Extract text content
    const textContent = result.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    // If we have a schema, try to parse the result
    let structuredContent: Record<string, unknown> | undefined;
    if (this.schema) {
      try {
        // Try to parse the text content as JSON and validate with schema
        const parsed = JSON.parse(textContent);
        structuredContent = this.schema.parse(parsed);
      } catch {
        // If parsing fails, leave structuredContent undefined
      }
    }

    return {
      content: textContent,
      structuredContent,
    };
  }
}

/**
 * Factory methods for creating MCP sources
 */
export namespace MCPSource {
  /**
   * Create a source that calls an MCP tool
   */
  export function tool(
    client: MCPClientWrapper,
    tool: string,
    options?: Partial<MCPToolSourceOptions>
  ): MCPToolSource {
    return new MCPToolSource(client, {
      tool,
      extractText: true,
      ...options,
    });
  }

  /**
   * Create a source that reads an MCP resource
   */
  export function resource(
    client: MCPClientWrapper,
    uri: string,
    options?: Partial<MCPResourceSourceOptions>
  ): MCPResourceSource {
    return new MCPResourceSource(client, {
      uri,
      extractText: true,
      ...options,
    });
  }

  /**
   * Create a source that gets an MCP prompt
   */
  export function prompt(
    client: MCPClientWrapper,
    prompt: string,
    options?: Partial<MCPPromptSourceOptions>
  ): MCPPromptSource {
    return new MCPPromptSource(client, {
      prompt,
      format: 'text',
      ...options,
    });
  }

  /**
   * Create a model source that calls an MCP tool and returns structured output
   */
  export function model(
    client: MCPClientWrapper,
    toolName: string,
    schema?: z.ZodType<any>
  ): MCPModelSource {
    return new MCPModelSource(client, toolName, schema);
  }
}