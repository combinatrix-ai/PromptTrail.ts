/**
 * Interactive Coding Agent Example
 *
 * This example demonstrates how to create an interactive coding agent using PromptTrail.
 * The agent can execute shell commands, read and write files, and maintain a conversation.
 * Now uses the built-in default tools for enhanced functionality.
 */

// Import PromptTrail core components and default tools
import {
  Agent,
  Session,
  Source,
  System,
  getAllDefaultTools,
  defaultTools,
} from '../packages/core/src/index';

/**
 * CodingAgent class that provides an interactive coding assistant
 * with comprehensive tool capabilities using PromptTrail's default tools
 */
export class CodingAgent {
  private llm: Source;

  constructor(config: {
    provider: 'openai' | 'anthropic';
    apiKey: string;
    modelName?: string;
  }) {
    // Configure the LLM with all default tools using the fluent API
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

    // Add temperature and all default tools for comprehensive capabilities
    this.llm = llmSource.temperature(0.7).withTools(getAllDefaultTools());
  }

  /**
   * Run the agent in interactive mode
   * This creates a continuous conversation loop that exits when the user types "exit"
   */
  async run(initialPrompt?: string): Promise<void> {
    console.log(
      '\nStarting interactive coding agent (type "exit" to end)...\n',
    );

    // Create session with console output
    const session = Session.debug();

    const systemPrompt = `You are an advanced coding agent with comprehensive file system and shell capabilities. You have access to these tools:

**File Operations:**
- fileRead: Read any file with optional line ranges
- fileEdit: Make precise edits to files using find-and-replace
- ls: List directory contents with detailed information

**Search & Discovery:**
- globSearch: Find files using patterns like **/*.js, src/**/*.ts
- grep: Search file contents using regular expressions

**Shell Operations:**
- bash: Execute any shell command with proper error handling

Use these tools effectively to help users accomplish their coding tasks. Always explain what you're doing and why.`;

    const agent = Agent.create()
      .then(new System(systemPrompt))
      .conditional(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        (_) => initialPrompt !== undefined && initialPrompt.trim() !== '',
        // When initialPrompt is provided, this is noninteractive mode, so one turn conversation
        (agent) => agent.user(initialPrompt as string).assistant(this.llm),
        // Otherwise, this is interactive mode
        (agent) =>
          agent.loop(
            (innerAgent) =>
              innerAgent
                .user({ cli: 'Your request (type "exit" to end): ' })
                .assistant(this.llm),
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
    // Example 1: Basic file exploration
    console.log('\n=== Example 1: Explore project structure ===\n');
    await this.run(
      'Explore the current project structure. List the main directories and find all TypeScript files. Give me an overview of what this project contains.',
    );

    // Example 2: File creation and manipulation
    console.log('\n=== Example 2: Create and manipulate files ===\n');
    await this.run(
      'Create a file named hello.js that exports a function which prints "Hello, World!" with the current timestamp. Then read it back and test it by running it with Node.js.',
    );

    // Example 3: Code analysis task
    console.log('\n=== Example 3: Code analysis ===\n');
    await this.run(
      'Search for all files that contain the word "test" in their content. Then create a summary report in a file called test-summary.txt listing what types of tests exist in this project.',
    );

    console.log('\n=== Examples completed ===\n');
  }

  /**
   * Demonstrate specific tool capabilities
   */
  async demonstrateTools(): Promise<void> {
    console.log('\n=== Tool Demonstration ===\n');

    const session = Session.debug();

    // Demonstrate each tool category
    const agent = Agent.create()
      .system(`You are demonstrating PromptTrail's default tools. Show each tool's capabilities clearly.`)

      // File system tools demo
      .user('Demonstrate the ls tool by listing the current directory with detailed information')
      .assistant({ tools: [defaultTools.ls] })

      // Search tools demo  
      .user('Now use globSearch to find all .ts files in the project')
      .assistant({ tools: [defaultTools.globSearch] })

      // Content search demo
      .user('Use grep to search for the word "Agent" in TypeScript files')
      .assistant({ tools: [defaultTools.grep] })

      // File operations demo
      .user('Use fileRead to read the package.json file and show its contents')
      .assistant({ tools: [defaultTools.fileRead] })

      // Create a test file
      .user('Create a simple test file using fileEdit with some sample content')
      .assistant({ tools: [defaultTools.fileEdit] })

      // Shell operations demo
      .user('Use bash to run "npm --version" and show the result')
      .assistant({ tools: [defaultTools.bash] });

    await agent.execute(session);
    console.log('\n=== Tool demonstration completed ===\n');
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

    // Run examples, tool demo, or interactive mode based on arguments
    if (process.argv.includes('--examples')) {
      console.log('Running example scenarios...');
      await agent.runExample();
    } else if (process.argv.includes('--tools')) {
      console.log('Running tool demonstrations...');
      await agent.demonstrateTools();
    } else if (process.argv.includes('--test')) {
      // Legacy support for test flag
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