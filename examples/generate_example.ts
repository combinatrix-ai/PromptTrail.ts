import {
  LinearTemplate,
  createSession,
  createTool,
  type GenerateOptions,
} from '@prompttrail/core';

// Example of using the LinearTemplate with generateText

async function basicExample() {
  console.log('Example: Basic usage with generateText');

  // Define generateOptions
  const generateOptions: GenerateOptions = {
    provider: {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY || '',
      modelName: 'gpt-4o-mini',
    },
    temperature: 0.7,
  };

  // Create a simple conversation template
  const chat = new LinearTemplate()
    .addSystem("I'm a helpful assistant.")
    .addUser("What's TypeScript?")
    .addAssistant({ generateOptions }); // Pass generateOptions to addAssistant

  // Execute the template with print mode enabled
  const session = await chat.execute(
    createSession({
      print: true, // Enable console logging of the conversation
    }),
  );

  console.log('\nFinal response:');
  console.log(session.getLastMessage()?.content);
}

// Example of using tools with generateText
async function toolExample() {
  console.log('\nExample: Using tools with generateText');

  // Define a calculator tool
  const calculator = createTool({
    name: 'calculator',
    description: 'Perform arithmetic operations',
    schema: {
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
        operation: {
          type: 'string',
          description: 'Operation to perform (add, subtract, multiply, divide)',
        },
      },
      required: ['a', 'b', 'operation'],
    },
    execute: async (input) => {
      console.log(
        `Executing calculator: ${input.a} ${input.operation} ${input.b}`,
      );

      switch (input.operation) {
        case 'add':
          return input.a + input.b;
        case 'subtract':
          return input.a - input.b;
        case 'multiply':
          return input.a * input.b;
        case 'divide':
          if (input.b === 0) throw new Error('Division by zero');
          return input.a / input.b;
        default:
          throw new Error(`Unknown operation: ${input.operation}`);
      }
    },
  });

  // Define generateOptions with tools
  const generateOptions: GenerateOptions = {
    provider: {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY || '',
      modelName: 'gpt-4o-mini',
    },
    temperature: 0.7,
    tools: [calculator],
  };

  // Create a conversation template with tool
  const chat = new LinearTemplate()
    .addSystem("I'm a helpful assistant with access to tools.")
    .addUser('What is 123 * 456?')
    .addAssistant({ generateOptions });

  // Execute the template
  let session = await chat.execute(
    createSession({
      print: true,
    }),
  );

  // Check if there are tool calls
  const lastMessage = session.getLastMessage();
  const metadata = lastMessage?.metadata?.toJSON() || {};
  const toolCalls = metadata.toolCalls as Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }> | undefined;

  if (toolCalls && toolCalls.length > 0) {
    // Execute each tool call
    for (const toolCall of toolCalls) {
      // Find the tool
      const tool = calculator.name === toolCall.name ? calculator : null;

      if (tool) {
        try {
          // Execute the tool with proper type casting
          const args = {
            a: Number(toolCall.arguments.a),
            b: Number(toolCall.arguments.b),
            operation: String(toolCall.arguments.operation),
          };
          const result = await tool.execute(args);

          // Add the tool result to the session
          const resultTemplate = new LinearTemplate().addToolResult(
            toolCall.id,
            JSON.stringify(result),
          );

          session = await resultTemplate.execute(session);
        } catch (error) {
          console.error(`Error executing tool: ${error}`);
        }
      }
    }

    // Define generateOptions for continuation
    const continueOptions: GenerateOptions = {
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || '',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    };

    // Continue the conversation with the tool results
    const continueTemplate = new LinearTemplate()
      .addAssistant({ generateOptions: continueOptions });

    session = await continueTemplate.execute(session);
  }

  console.log('\nFinal response:');
  console.log(session.getLastMessage()?.content);
}

// Example of using Anthropic with generateText
async function anthropicExample() {
  console.log('\nExample: Using Anthropic with generateText');

  // Define generateOptions for Anthropic
  const generateOptions: GenerateOptions = {
    provider: {
      type: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      modelName: 'claude-3-5-haiku-latest',
    },
    temperature: 0.7,
  };

  // Create a conversation template
  const chat = new LinearTemplate()
    .addSystem("I'm a helpful assistant powered by Claude.")
    .addUser('Explain the concept of functional programming in simple terms.')
    .addAssistant({ generateOptions });

  // Execute the template
  const session = await chat.execute(
    createSession({
      print: true,
    }),
  );

  console.log('\nFinal response:');
  console.log(session.getLastMessage()?.content);
}

// Run all examples
async function main() {
  try {
    await basicExample();
    await toolExample();
    await anthropicExample();
  } catch (error) {
    console.error('Error:', error);
  }
}

// Check if environment variables are set
if (!process.env.OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY environment variable is not set');
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('Warning: ANTHROPIC_API_KEY environment variable is not set');
}

main();
