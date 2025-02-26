/**
 * Type declarations for the MCP SDK
 * These are simplified versions of the actual types to make integration easier
 */

export interface ClientInfo {
  name: string;
  version: string;
}

export interface ClientCapabilities {
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  };
}

export interface HttpTransportOptions {
  url: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ResourceContent {
  type: string;
  text?: string;
  resource?: {
    text?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ToolCallResult {
  content?: ResourceContent[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface PromptMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

// These types are already exported above, no need to re-export
