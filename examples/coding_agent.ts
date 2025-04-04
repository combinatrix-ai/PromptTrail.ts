import {
  type TMessage,
  type IToolResultMetadata,
  type ISession,
  createSession,
  type GenerateOptions,
  createGenerateOptions,
  createMetadata,
  generateText,
} from '@prompttrail/core';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';

// Convert exec to promise-based
const execAsync = promisify(exec);

const shellCommandTool = {
  description: 'Execute a shell command',
  parameters: z.object({
    command: z.string().describe('Shell command to execute'),
  }),
  execute: async ({ command }: { command: string }) => {
    const { stdout, stderr } = await execAsync(command);
    return { stdout, stderr };
  },
};

const readFileTool = {
  description: 'Read content from a file',
  parameters: z.object({
    path: z.string().describe('Path to the file to read'),
  }),
  execute: async ({ path }: { path: string }) => {
    const content = await readFile(path, 'utf-8');
    return { content };
  },
};

const writeFileTool = {
  description: 'Write content to a file',
  parameters: z.object({
    path: z.string().describe('Path to write the file'),
    content: z.string().describe('Content to write to the file'),
  }),
  execute: async ({ path, content }: { path: string; content: string }) => {
    await writeFile(path, content, 'utf-8');
    return { success: true };
  },
};

type ToolParameters = {
  shell_command: z.infer<typeof shellCommandTool.parameters>;
  read_file: z.infer<typeof readFileTool.parameters>;
  write_file: z.infer<typeof writeFileTool.parameters>;
};

// CodingAgent class to manage tools and session
export class CodingAgent {
  private session: ISession;
  private tools: Record<string, unknown>;
  private generateOptions: GenerateOptions;

  constructor(config: { 
    provider: 'openai' | 'anthropic'; 
    apiKey: string; 
    mcpServerUrl?: string;
    mcpServerName?: string;
    mcpServerVersion?: string;
  }) {
    this.tools = {
      shell_command: shellCommandTool,
      read_file: readFileTool,
      write_file: writeFileTool
    };

    // Initialize generateOptions based on provider
    if (config.provider === 'openai') {
      this.generateOptions = createGenerateOptions({
        provider: {
          type: 'openai',
          apiKey: config.apiKey,
          modelName: 'gpt-4',
        },
        temperature: 0.7,
        tools: this.tools,
      });
    } else {
      this.generateOptions = createGenerateOptions({
        provider: {
          type: 'anthropic',
          apiKey: config.apiKey,
          modelName: 'claude-3-opus-20240229',
        },
        temperature: 0.7,
        tools: this.tools,
        mcpServers: [
          {
            url: config.mcpServerUrl || 'http://localhost:8080',
            name: config.mcpServerName || 'github-mcp-server',
            version: config.mcpServerVersion || '1.0.0',
          },
        ],
      });
    }

    // Initialize session
    this.session = createSession({
      messages: [
        {
          type: 'system',
          content:
            'You are a coding agent that can execute shell commands and manipulate files. Use the available tools to help users accomplish their tasks.',
        },
      ],
    });
  }

  // Add a user message to the session and get AI response
  async processUserMessage(content: string): Promise<void> {
    // Add user message
    this.session = this.session.addMessage({
      type: 'user',
      content,
    });

    // Get AI response
    while (true) {
      const response = await generateText(this.session, this.generateOptions);
      this.session = this.session.addMessage(response);

      if (response.type === 'assistant') {
        const toolCalls = response.toolCalls;
        if (toolCalls && toolCalls.length > 0) {
          // Handle tool calls
          for (const toolCall of toolCalls) {
            const result = await this.executeTool(
              toolCall.name as keyof ToolParameters,
              toolCall.arguments as ToolParameters[keyof ToolParameters],
            );
            await this.addToolResult(result, toolCall.id);
          }
          continue;
        }
      }
      // No more tool calls, break the loop
      break;
    }
  }

  // Add a tool result message to the session
  private async addToolResult(
    result: unknown,
    toolCallId: string,
  ): Promise<void> {
    this.session = this.session.addMessage({
      type: 'tool_result',
      content: JSON.stringify(result),
      result,
      metadata: createMetadata<IToolResultMetadata>({ initial: { toolCallId } }),
    });
  }

  // Execute a tool and add the result to the session
  private async executeTool<K extends keyof ToolParameters>(
    toolName: K,
    args: ToolParameters[K],
  ): Promise<unknown> {
    const tool = this.tools[toolName as string] as { execute: (args: unknown) => Promise<unknown> };
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const result = await tool.execute(args);
    return result;
  }

  // Get all messages in the session
  getMessages(): readonly TMessage[] {
    return this.session.messages;
  }

  // Example usage of the agent
  async runExample(): Promise<void> {
    // Example 1: List files
    await this.processUserMessage(
      'List the files in the current directory and tell me what you see.',
    );

    // Example 2: Create and read a file
    await this.processUserMessage(
      'Create a file named example.txt with some interesting content, then read it back and explain what you wrote.',
    );

    // Example 3: Advanced task
    await this.processUserMessage(
      'Create a simple Node.js script that prints "Hello, World!" and run it.',
    );
  }
}

// Example usage
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  // Get API key from environment variable based on provider
  const provider = (process.env.AI_PROVIDER || 'openai') as
    | 'openai'
    | 'anthropic';
  const apiKey =
    provider === 'openai'
      ? process.env.OPENAI_API_KEY
      : process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error(
      `${provider.toUpperCase()}_API_KEY environment variable is required`,
    );
    process.exit(1);
  }

  const mcpServerUrl = process.env.MCP_SERVER_URL;
  const mcpServerName = process.env.MCP_SERVER_NAME;
  const mcpServerVersion = process.env.MCP_SERVER_VERSION;

  const agent = new CodingAgent({ 
    provider, 
    apiKey, 
    mcpServerUrl, 
    mcpServerName, 
    mcpServerVersion 
  });
  agent.runExample().catch(console.error);
}
