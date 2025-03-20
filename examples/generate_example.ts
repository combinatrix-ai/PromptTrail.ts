import {
  LinearGenerateTemplate,
  createSession,
  createTool,
} from '@prompttrail/core';

// Example of using the LinearGenerateTemplate with generateText

async function basicExample() {
  console.log('Example: Basic usage with generateText');

  // Create a simple conversation template
  const chat = new LinearGenerateTemplate({
    provider: {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY || '',
      modelName: 'gpt-4o-mini',
    },
    temperature: 0.7,
  })
    .addSystem("I'm a helpful assistant.")
    .addUser("What's TypeScript?")
    .addAssistant(); // Uses the generateOptions from LinearGenerateTemplate

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

  // Create a conversation template with tool
  const chat = new LinearGenerateTemplate({
    provider: {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY || '',
      modelName: 'gpt-4o-mini',
    },
    temperature: 0.7,
    tools: [calculator],
  })
    .addSystem("I'm a helpful assistant with access to tools.")
    .addUser('What is 123 * 456?')
    .addAssistant();

  // Execute the template
  let session = await chat.execute(
    createSession({
      print: true,
    }),
  );

  // Check if there are tool calls
  const lastMessage = session.getLastMessage();
  const toolCalls = lastMessage?.metadata?.get('toolCalls');

  if (toolCalls && toolCalls.length > 0) {
    // Execute each tool call
    for (const toolCall of toolCalls) {
      // Find the tool
      const tool = calculator.name === toolCall.name ? calculator : null;

      if (tool) {
        try {
          // Execute the tool
          const result = await tool.execute(toolCall.arguments);

          // Add the tool result to the session
          const resultTemplate = new LinearGenerateTemplate().addToolResult(
            toolCall.id,
            JSON.stringify(result),
          );

          session = await resultTemplate.execute(session);
        } catch (error) {
          console.error(`Error executing tool: ${error}`);
        }
      }
    }

    // Continue the conversation with the tool results
    const continueTemplate = new LinearGenerateTemplate({
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || '',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    }).addAssistant();

    session = await continueTemplate.execute(session);
  }

  console.log('\nFinal response:');
  console.log(session.getLastMessage()?.content);
}

// Example of using Anthropic with generateText
async function anthropicExample() {
  console.log('\nExample: Using Anthropic with generateText');

  // Create a conversation template
  const chat = new LinearGenerateTemplate({
    provider: {
      type: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      modelName: 'claude-3-5-haiku-latest',
    },
    temperature: 0.7,
  })
    .addSystem("I'm a helpful assistant powered by Claude.")
    .addUser('Explain the concept of functional programming in simple terms.')
    .addAssistant();

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
