/**
 * Interactive Coding Agent Example
 *
 * This example demonstrates how to create an interactive coding agent using PromptTrail.
 * The agent can execute shell commands, read and write files, and maintain a conversation.
 */

// Import PromptTrail core components
import {
  Agent,
  CLISource,
  createSession,
  Source,
  System,
} from '../packages/core/src/index';

// Import Tool namespace from PromptTrail
import { Tool } from '../packages/core/src/index';
import { z } from 'zod';

// Node.js modules for file and command operations
import { exec } from 'child_process';
import { readFile, writeFile } from 'fs/promises';
import { promisify } from 'util';
// Convert exec to promise-based for async/await usage
const execAsync = promisify(exec);

// Define shell command tool
const shellCommandTool = Tool.create({
  description: 'Execute a shell command',
  parameters: z.object({
    command: z.string().describe('Shell command to execute'),
  }),
  execute: async (input) => {
    try {
      console.log(`[Debug] Executing command: ${input.command}`);
      const { stdout, stderr } = await execAsync(input.command);
      return { stdout, stderr };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Command failed';
      return { stdout: '', stderr: message };
    }
  },
});

// Define file reading tool
const readFileTool = Tool.create({
  description: 'Read content from a file',
  parameters: z.object({
    path: z.string().describe('Path to the file to read'),
  }),
  execute: async (input) => {
    try {
      const content = await readFile(input.path, 'utf-8');
      console.log(
        `[Debug] Read content from ${input.path}:`,
        content.substring(0, 10),
        '...',
      );
      return { content };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { error: `Failed to read file: ${message}` };
    }
  },
});

// Define file writing tool
const writeFileTool = Tool.create({
  description: 'Write content to a file',
  parameters: z.object({
    path: z.string().describe('Path to write the file'),
    content: z.string().describe('Content to write to the file'),
  }),
  execute: async (input) => {
    try {
      console.log(
        `[Debug] Writing content to ${input.path}:`,
        input.content.substring(0, 10),
        '...',
      );
      await writeFile(input.path, input.content, 'utf-8');
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed to write file: ${message}` };
    }
  },
});

// Type definition for tools collection
type ToolsMap = Record<string, Tool>;

/**
 * CodingAgent class that provides an interactive coding assistant
 * with tool capabilities for shell commands and file operations
 */
export class CodingAgent {
  private tools: ToolsMap;
  private llm: Source;

  constructor(config: {
    provider: 'openai' | 'anthropic';
    apiKey: string;
    modelName?: string;
  }) {
    // Register all available tools
    this.tools = {
      shell_command: shellCommandTool,
      read_file: readFileTool,
      write_file: writeFileTool,
    };

    // Configure the LLM with tools using the fluent API
    let llmSource = Source.llm();

    // Configure provider
    if (config.provider === 'openai') {
      llmSource = llmSource.openai({
        apiKey: config.apiKey,
        modelName: config.modelName || 'gpt-4o-mini',
      });
    } else {
      llmSource = llmSource.anthropic({
        apiKey: config.apiKey,
        modelName: config.modelName || 'claude-3-5-haiku-latest',
      });
    }

    // Add temperature and tools
    this.llm = llmSource.temperature(0.7).withTools(this.tools);
  }

  /**
   * Run the agent in interactive mode
   * This creates a continuous conversation loop that exits when the user types "exit"
   */
  async run(initialPrompt?: string): Promise<void> {
    console.log(
      '\nStarting interactive coding agent (type "exit" to end)...\n',
    );

    // Create interactive input source
    const userCliSource = new CLISource('Your request (type "exit" to end): ');

    // Create session with console output
    const session = createSession({ print: true });

    const systemPrompt =
      'You are a coding agent that can execute shell commands and manipulate files. Use the available tools to help users accomplish their tasks.';

    const agent = new Agent().add(new System(systemPrompt)).addConditional(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (_) => initialPrompt !== undefined && initialPrompt.trim() !== '',
      // When initialPrompt is provided, this is noninteractive mode, so one turn conversation
      new Agent().addUser(initialPrompt as string).addAssistant(this.llm),
      // Otherwise, this is interactive mode
      new Agent().addLoop(
        new Agent().addUser(userCliSource).addAssistant(this.llm),
        (session) => {
          const lastUserMessage = session
            .getMessagesByType('user')
            .slice(-1)[0];
          return lastUserMessage?.content.toLowerCase().trim() !== 'exit';
        },
      ),
    );

    // Execute the interactive template
    await agent.execute(session);
    console.log('\nCoding agent session ended. Goodbye!\n');
  }

  /**
   * Run predefined examples to demonstrate agent capabilities
   */
  async runExample(): Promise<void> {
    // Example 1: Basic file listing
    console.log('\n=== Example 1: List files ===\n');
    this.run(
      'List the files in the current directory and tell me what you see.',
    );

    // Example 2: File creation and reading
    console.log('\n=== Example 2: Create and read a file ===\n');
    this.run(
      'Create a file named example.txt with some interesting content, then read it back and explain what you wrote.',
    );

    // Example 3: Create and run a script
    console.log('\n=== Example 3: Advanced task ===\n');
    this.run(
      'Create a simple Node.js script that prints "Hello, World!" and run it.',
    );
    console.log('\n=== Examples completed ===\n');
  }
}

/**
 * Main entry point for the coding agent
 */
const runAgent = async (): Promise<void> => {
  try {
    // Get configuration from environment variables
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

    // Initialize the agent
    const agent = new CodingAgent({ provider, apiKey });

    // Run examples or interactive mode
    if (process.argv.includes('--test')) {
      console.log('Running example tests...');
      await agent.runExample();
    } else {
      // Start interactive session
      await agent.run();
    }
  } catch (error) {
    console.error('Error running agent:', error);
  }
};

// Auto-run when executed directly
if (require.main === module) {
  runAgent()
    .then(() => {
      console.log('Agent completed successfully.');
    })
    .catch((error) => {
      console.error('Error:', error);
    });
}
