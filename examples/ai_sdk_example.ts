import {
  LinearTemplate,
  createSession,
  createTool,
  type GenerateOptions,
} from '@prompttrail/core';
import { z } from 'zod';

// Example 1: Basic usage with OpenAI
async function basicExample() {
  console.log('Example 1: Basic usage with OpenAI');
  
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
    .addAssistant({ generateOptions });

  // Execute the template with print mode enabled
  const session = await chat.execute(
    createSession({
      print: true, // Enable console logging of the conversation
    }),
  );
  
  console.log('\nFinal response:');
  console.log(session.getLastMessage()?.content);
}

// Example 2: Using tools with AI SDK
async function toolExample() {
  console.log('\nExample 2: Using tools with AI SDK');
  
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
          description: 'Operation to perform (add, subtract, multiply, divide)' 
        },
      },
      required: ['a', 'b', 'operation'],
    },
    execute: async (input) => {
      console.log(`Executing calculator: ${input.a} ${input.operation} ${input.b}`);
      
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
  
  // Create a conversation template
  const chat = new LinearTemplate()
    .addSystem("I'm a helpful assistant with access to tools.")
    .addUser("What is 123 * 456?")
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

// Example 3: Schema validation with AI SDK
async function schemaExample() {
  console.log('\nExample 3: Schema validation with AI SDK');
  
  // Define a schema using Zod
  const productSchema = z.object({
    name: z.string().describe('The name of the product'),
    price: z.number().describe('The price of the product in USD'),
    inStock: z.boolean().describe('Whether the product is in stock'),
    description: z.string().describe('A short description of the product'),
    features: z.array(z.string()).describe('List of product features'),
  });
  
  // Define generateOptions
  const generateOptions: GenerateOptions = {
    provider: {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY || '',
      modelName: 'gpt-4o-mini',
    },
    temperature: 0.7,
  };
  
  // Create a conversation template
  const chat = await new LinearTemplate()
    .addSystem("I'll extract product information from text.")
    .addUser("The new iPhone 15 Pro costs $999 and comes with a titanium frame. It is currently in stock. It features a 48MP camera, A17 Pro chip, and all-day battery life.")
    .addSchema(productSchema, { generateOptions, maxAttempts: 3 });
  
  // Execute the template
  const session = await chat.execute(
    createSession({
      print: true,
    }),
  );
  
  // Get the structured output
  const product = session.metadata.get('structured_output');
  console.log('\nExtracted product information:');
  console.log(JSON.stringify(product, null, 2));
}

// Example 4: Using Anthropic with AI SDK
async function anthropicExample() {
  console.log('\nExample 4: Using Anthropic with AI SDK');
  
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
    .addUser("Explain the concept of functional programming in simple terms.")
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
    await schemaExample();
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
