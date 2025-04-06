// Imports from @prompttrail/core
import {
  createSession,
  createGenerateOptions,
  type GenerateOptions,
  Agent,
} from '../packages/core/src/index.js';

// Imports from ai and zod for tool definition
import { tool, type Tool } from 'ai'; // Removed unused Message import
import { z } from 'zod';

// Node.js built-in modules
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile } from 'fs/promises';
import { StaticContentSource, BasicModelContentSource } from '../packages/core/src/content_source.js';
import { AssistantTemplate } from '../packages/core/src/templates/basic.js';

// Convert exec to promise-based
const execAsync = promisify(exec);

// Create tools using 'ai' tool function and Zod schemas
const shellCommandTool = tool({
  description: 'Execute a shell command',
  parameters: z.object({
    command: z.string().describe('Shell command to execute'),
  }),
  execute: async (input: z.infer<z.ZodObject<{ command: z.ZodString }>>) => {
    try {
      const { stdout, stderr } = await execAsync(input.command);
      return { stdout, stderr };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Command failed';
      return { stdout: '', stderr: message };
    }
  },
});

const readFileTool = tool({
  description: 'Read content from a file',
  parameters: z.object({
    path: z.string().describe('Path to the file to read'),
  }),
  execute: async (input: z.infer<z.ZodObject<{ path: z.ZodString }>>) => {
    try {
      const content = await readFile(input.path, 'utf-8');
      return { content };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { error: `Failed to read file: ${message}` };
    }
  },
});

const writeFileTool = tool({
  description: 'Write content to a file',
  parameters: z.object({
    path: z.string().describe('Path to write the file'),
    content: z.string().describe('Content to write to the file'),
  }),
  execute: async (
    input: z.infer<z.ZodObject<{ path: z.ZodString; content: z.ZodString }>>,
  ) => {
    try {
      await writeFile(input.path, input.content, 'utf-8');
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed to write file: ${message}` };
    }
  },
});

// Define the type for the tools record based on 'ai' Tool type
type ToolsMap = Record<string, Tool>;

export class CodingAgent {
  private tools: ToolsMap;
  private generateOptions: GenerateOptions;
  private template: Agent;

  constructor(config: {
    provider: 'openai' | 'anthropic';
    apiKey: string;
    modelName?: string;
  }) {
    // Store tools in the record
    this.tools = {
      shell_command: shellCommandTool,
      read_file: readFileTool,
      write_file: writeFileTool,
    };

    // Initialize generateOptions using fluent API
    const baseOptions = {
      provider: {
        type: config.provider,
        apiKey: config.apiKey,
        modelName:
          config.provider === 'openai'
            ? 'gpt-4o-mini'
            : 'claude-3-5-haiku-20240620',
      },
      temperature: 0.7,
    };

    this.generateOptions = createGenerateOptions(baseOptions).addTools(
      this.tools,
    ); // Add tools using fluent API

    // CodingAgent Template
    this.template = new Agent({})
      .addSystem(
        'You are a coding agent that can execute shell commands and manipulate files. Use the available tools to help users accomplish their tasks.',
      )
      .addUser()
      // addAssistant can now be called without generateOptions, it will use the parent's one
      .addAssistant();
  }

  // Add a user message to the session and get AI response
  async run(prompt?: string): Promise<void> {
    if (!prompt) {
      throw new Error('Prompt is required to run the agent.');
    }
    
    console.log('Running agent with prompt:', prompt);
    
    // Create a new session
    const session = createSession();
    
    // Create a new agent with the same templates but with specific content sources
    const systemPrompt = 'You are a coding agent that can execute shell commands and manipulate files. Use the available tools to help users accomplish their tasks.';
    const userContent = new StaticContentSource(prompt);
    const assistantContent = new BasicModelContentSource(this.generateOptions);
    
    // Create a new agent with the content sources
    const agent = new Agent()
      .addSystem(systemPrompt)
      .addUser(userContent)
      .addAssistant(assistantContent);
    
    // Execute the agent
    await agent.execute(session);
  }

  // Example usage of the agent
  async runExample(): Promise<void> {
    // Example 1: List files
    await this.run(
      'List the files in the current directory and tell me what you see.',
    );

    // Example 2: Create and read a file
    await this.run(
      'Create a file named example.txt with some interesting content, then read it back and explain what you wrote.',
    );

    // Example 3: Advanced task
    await this.run(
      'Create a simple Node.js script that prints "Hello, World!" and run it.',
    );
  }
}

// Run the agent if this file is executed directly
const runAgent = async (): Promise<void> => {
  try {
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

    // Check if --test argument is provided
    if (process.argv.includes('--test')) {
      console.log('Running example tests...');
      await agent.runExample();
    } else {
      await agent.run('What can you help me with today?');
    }
  } catch (error) {
    console.error('Error running agent:', error);
  }
};

// Run the agent if this file is executed directly
if (require.main === module) {
  runAgent()
    .then(() => {
      console.log('Agent completed successfully.');
    })
    .catch((error) => {
      console.error('Error:', error);
    });
}
