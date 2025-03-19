import {
  createTool,
  type Tool,
  type SchemaType,
  type Message,
  type ToolResultMetadata,
  type InferSchemaType,
  type Session,
  createSession,
  OpenAIModel,
  AnthropicModel,
  type OpenAIConfig,
  type AnthropicConfig,
  type AssistantMetadata,
  createMetadata,
} from '@prompttrail/core';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';

// Convert exec to promise-based
const execAsync = promisify(exec);

// Define tool schemas
const shellCommandSchema = {
  properties: {
    command: { type: 'string', description: 'Shell command to execute' },
  },
  required: ['command'],
} as const satisfies SchemaType;

const readFileSchema = {
  properties: {
    path: { type: 'string', description: 'Path to the file to read' },
  },
  required: ['path'],
} as const satisfies SchemaType;

const writeFileSchema = {
  properties: {
    path: { type: 'string', description: 'Path to write the file' },
    content: { type: 'string', description: 'Content to write to the file' },
  },
  required: ['path', 'content'],
} as const satisfies SchemaType;

// Create tools
const shellCommandTool = createTool({
  name: 'shell_command',
  description: 'Execute a shell command',
  schema: shellCommandSchema,
  execute: async (input: InferSchemaType<typeof shellCommandSchema>) => {
    const { stdout, stderr } = await execAsync(input.command);
    return { stdout, stderr };
  },
});

const readFileTool = createTool({
  name: 'read_file',
  description: 'Read content from a file',
  schema: readFileSchema,
  execute: async (input: InferSchemaType<typeof readFileSchema>) => {
    const content = await readFile(input.path, 'utf-8');
    return { content };
  },
});

const writeFileTool = createTool({
  name: 'write_file',
  description: 'Write content to a file',
  schema: writeFileSchema,
  execute: async (input: InferSchemaType<typeof writeFileSchema>) => {
    await writeFile(input.path, input.content, 'utf-8');
    return { success: true };
  },
});

// Define tool input types
type ToolSchemas = {
  shell_command: typeof shellCommandSchema;
  read_file: typeof readFileSchema;
  write_file: typeof writeFileSchema;
};

// CodingAgent class to manage tools and session
export class CodingAgent {
  private session: Session;
  private tools: Tool<SchemaType>[];
  private model: OpenAIModel | AnthropicModel;

  constructor(config: { provider: 'openai' | 'anthropic'; apiKey: string }) {
    this.tools = [shellCommandTool, readFileTool, writeFileTool];

    // Initialize model based on provider
    if (config.provider === 'openai') {
      const modelConfig: OpenAIConfig = {
        modelName: 'gpt-4',
        temperature: 0.7,
        apiKey: config.apiKey,
        tools: this.tools,
      };
      this.model = new OpenAIModel(modelConfig);
    } else {
      const modelConfig: AnthropicConfig = {
        modelName: 'claude-3-opus-20240229',
        temperature: 0.7,
        apiKey: config.apiKey,
        tools: this.tools,
      };
      this.model = new AnthropicModel(modelConfig);
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
      const response = await this.model.send(this.session);
      this.session = this.session.addMessage(response);

      if (response.type === 'assistant') {
        const metadata = response.metadata?.get(
          'toolCalls',
        ) as AssistantMetadata['toolCalls'];
        if (metadata) {
          // Handle tool calls
          for (const toolCall of metadata) {
            const result = await this.executeTool(
              toolCall.name as keyof ToolSchemas,
              toolCall.arguments as InferSchemaType<
                ToolSchemas[keyof ToolSchemas]
              >,
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
      metadata: createMetadata<ToolResultMetadata>({ initial: { toolCallId } }),
    });
  }

  // Execute a tool and add the result to the session
  private async executeTool<K extends keyof ToolSchemas>(
    toolName: K,
    args: InferSchemaType<ToolSchemas[K]>,
  ): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const result = await tool.execute(args);
    return result;
  }

  // Get all messages in the session
  getMessages(): readonly Message[] {
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

  const agent = new CodingAgent({ provider, apiKey });
  agent.runExample().catch(console.error);
}
