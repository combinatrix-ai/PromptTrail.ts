/**
 * Interactive Coding Agent Example
 *
 * This example demonstrates an interactive coding agent using PromptTrail.
 * The agent can execute shell commands, read and write files, and maintain a
 * conversation.
 */

import { Agent, CLISource, Session, Source, Tool } from '@prompttrail/core';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { exec } from 'child_process';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

// The tools run shell commands and write files; binding them to an explicit
// working directory keeps the agent's edits inside it (tests sandbox runs in
// a temp dir this way).
function createCodingTools(cwd: string) {
  const shellCommandTool = Tool.create({
    description: 'Execute a shell command',
    inputSchema: z.object({
      command: z.string().describe('Shell command to execute'),
    }),
    effect: { repeatable: true },
    execute: async (input) => {
      try {
        console.log(`[Debug] Executing command: ${input.command}`);
        const { stdout, stderr } = await execAsync(input.command, { cwd });
        return { stdout, stderr };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Command failed';
        return { stdout: '', stderr: message };
      }
    },
  });

  const readFileTool = Tool.create({
    description: 'Read content from a file',
    inputSchema: z.object({
      path: z.string().describe('Path to the file to read'),
    }),
    effect: { repeatable: true },
    execute: async (input) => {
      try {
        const content = await readFile(resolve(cwd, input.path), 'utf-8');
        console.log(
          `[Debug] Read content from ${input.path}:`,
          content.substring(0, 10),
          '...',
        );
        return { content };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        return { error: `Failed to read file: ${message}` };
      }
    },
  });

  const writeFileTool = Tool.create({
    description: 'Write content to a file',
    inputSchema: z.object({
      path: z.string().describe('Path to write the file'),
      content: z.string().describe('Content to write to the file'),
    }),
    effect: {
      idempotencyKey: (input) => {
        const { path, content } = input as { path: string; content: string };
        return `write-file:${path}:${content.length}`;
      },
    },
    execute: async (input) => {
      try {
        console.log(
          `[Debug] Writing content to ${input.path}:`,
          input.content.substring(0, 10),
          '...',
        );
        await writeFile(resolve(cwd, input.path), input.content, 'utf-8');
        return { success: true };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: `Failed to write file: ${message}` };
      }
    },
  });

  return {
    shell_command: shellCommandTool,
    read_file: readFileTool,
    write_file: writeFileTool,
  };
}

// Type definition for tools collection
type ToolsMap = Record<string, Tool>;

/**
 * CodingAgent class that provides an interactive coding assistant
 * with tool capabilities for shell commands and file operations
 */
export class CodingAgent {
  private tools: ToolsMap;
  private llm: ReturnType<typeof Source.llm>;

  constructor(config: {
    provider: 'openai' | 'anthropic';
    apiKey: string;
    modelName?: string;
    cwd?: string;
  }) {
    // Register all available tools, bound to the working directory
    this.tools = createCodingTools(config.cwd ?? process.cwd());

    let llmSource = Source.llm();

    if (config.provider === 'openai') {
      llmSource = llmSource.openai({
        apiKey: config.apiKey,
        modelName: config.modelName || 'gpt-5.4-nano',
      });
    } else {
      llmSource = llmSource.anthropic({
        apiKey: config.apiKey,
        modelName: config.modelName || 'claude-haiku-4-5',
      });
    }

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

    const userCliSource = new CLISource('Your request (type "exit" to end): ');

    const session = Session.debug();

    const systemPrompt =
      'You are a coding agent that can execute shell commands and manipulate files. Use the available tools to help users accomplish their tasks.';

    const agent = Agent.create('coding-agent')
      .system(systemPrompt)
      .conditional(
        () => initialPrompt !== undefined && initialPrompt.trim() !== '',
        (agent) => agent.user(initialPrompt as string).assistant(this.llm),
        (agent) =>
          agent.loop(
            (innerAgent) => innerAgent.user(userCliSource).assistant(this.llm),
            ({ session }) => {
              const lastUserMessage = session
                .getMessagesByType('user')
                .slice(-1)[0];
              return lastUserMessage?.content.toLowerCase().trim() !== 'exit';
            },
          ),
      );

    await agent.execute({ session });
    console.log('\nCoding agent session ended. Goodbye!\n');
  }

  /**
   * Run predefined examples to demonstrate agent capabilities
   */
  async runExample(): Promise<void> {
    // Example 1: Basic file listing
    console.log('\n=== Example 1: List files ===\n');
    await this.run(
      'List the files in the current directory and tell me what you see.',
    );

    // Example 2: File creation and reading
    console.log('\n=== Example 2: Create and read a file ===\n');
    await this.run(
      'Create a file named example.txt with some interesting content, then read it back and explain what you wrote.',
    );

    // Example 3: Create and run a script
    console.log('\n=== Example 3: Advanced task ===\n');
    await this.run(
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

    if (process.argv.includes('--test')) {
      console.log('Running example tests...');
      await agent.runExample();
    } else {
      await agent.run();
    }
  } catch (error) {
    console.error('Error running agent:', error);
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runAgent()
    .then(() => {
      console.log('Agent completed successfully.');
    })
    .catch((error) => {
      console.error('Error:', error);
    });
}
