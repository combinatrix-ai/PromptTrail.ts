import {
  createTool,
  type Tool,
  type SchemaType,
  type Message,
  type ToolResultMetadata,
  type InferSchemaType,
  SessionImpl,
  Metadata,
  OpenAIModel,
  type OpenAIConfig,
  type AssistantMetadata,
  createTemperature,
} from '../packages/core/dist';
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
  execute: async (input) => {
    try {
      const { stdout, stderr } = await execAsync(input.command);
      return { stdout, stderr };
    } catch (error) {
      throw new Error(`Failed to execute command: ${error}`);
    }
  },
});

const readFileTool = createTool({
  name: 'read_file',
  description: 'Read content from a file',
  schema: readFileSchema,
  execute: async (input) => {
    try {
      const content = await readFile(input.path, 'utf-8');
      return content;
    } catch (error) {
      throw new Error(`Failed to read file: ${error}`);
    }
  },
});

const writeFileTool = createTool({
  name: 'write_file',
  description: 'Write content to a file',
  schema: writeFileSchema,
  execute: async (input) => {
    try {
      await writeFile(input.path, input.content, 'utf-8');
      return { success: true, path: input.path };
    } catch (error) {
      throw new Error(`Failed to write file: ${error}`);
    }
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
  private session: SessionImpl;
  private tools: Tool<SchemaType>[];
  private model: OpenAIModel;

  constructor(apiKey: string) {
    this.tools = [shellCommandTool, readFileTool, writeFileTool];

    // Initialize OpenAI model
    const modelConfig: OpenAIConfig = {
      modelName: 'gpt-4o-mini',
      temperature: createTemperature(0.7),
      apiKey,
      tools: this.tools,
    };
    this.model = new OpenAIModel(modelConfig);

    // Initialize session
    this.session = SessionImpl.create(
      [
        {
          type: 'system',
          content:
            'You are a coding agent that can execute shell commands and manipulate files. Use the available tools to help users accomplish their tasks.',
        },
      ],
      {},
    );
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
    const metadata = new Metadata<ToolResultMetadata>({ toolCallId });
    this.session = this.session.addMessage({
      type: 'tool_result',
      content: JSON.stringify(result),
      result,
      metadata,
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
  // Get OpenAI API key from environment variable
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Please set OPENAI_API_KEY environment variable');
    process.exit(1);
  }

  const agent = new CodingAgent(apiKey);
  agent
    .runExample()
    .then(() => {
      console.log('Example completed successfully');
      console.log('Session messages:', agent.getMessages());
    })
    .catch((error) => {
      console.error('Error running example:', error);
    });
}
