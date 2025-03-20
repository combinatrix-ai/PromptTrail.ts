import { createSession } from '../src/session';
import { LinearTemplate } from '../src/templates';
import { AISDKModel, AIProvider } from '../src/model/ai_sdk_model';
import { AISDKSchemaTemplate } from '../src/templates/ai_sdk_schema_template';
import { z } from 'zod';

/**
 * Basic example of using AISDKModel with OpenAI provider
 */
async function basicExample() {
  console.log('=== Basic Example ===');

  // Create an AI SDK model with OpenAI provider
  const model = new AISDKModel({
    provider: AIProvider.OPENAI,
    apiKey: process.env.OPENAI_API_KEY!,
    modelName: 'gpt-4o',
    temperature: 0.7,
  });

  // Create a template
  const template = new LinearTemplate()
    .addSystem('You are a helpful assistant.')
    .addUser('Tell me about the benefits of using TypeScript.')
    .addAssistant({ model });

  // Execute the template
  const session = await template.execute(createSession());
  console.log('Response:', session.getLastMessage()?.content);

  // Clean up resources
  await model.close();
}

/**
 * Example of using AISDKSchemaTemplate for structured output
 */
async function schemaExample() {
  console.log('\n=== Schema Example ===');

  // Create an AI SDK model with OpenAI provider
  const model = new AISDKModel({
    provider: AIProvider.OPENAI,
    apiKey: process.env.OPENAI_API_KEY!,
    modelName: 'gpt-4o',
    temperature: 0.2,
  });

  // Define a schema for product information
  const productSchema = z.object({
    name: z.string().describe('The name of the product'),
    price: z.number().describe('The price of the product in USD'),
    inStock: z.boolean().describe('Whether the product is in stock'),
    features: z.array(z.string()).describe('List of product features'),
  });

  // Create a schema template
  const schemaTemplate = new AISDKSchemaTemplate({
    model,
    schema: productSchema,
    schemaDescription: 'Extract product details from the input',
  });

  // Create a session with context
  let initialSession = createSession();
  // Since messages is readonly, we need to create a new session with the messages
  initialSession = {
    ...initialSession,
    messages: [
      { type: 'system', content: 'Extract product information from the text.' },
      {
        type: 'user',
        content:
          'The new iPhone 15 Pro costs $999 and comes with a titanium frame. It has 8GB RAM and is currently available for purchase.',
      },
    ],
  };

  // Execute the schema template
  const schemaSession = await schemaTemplate.execute(initialSession);
  console.log(
    'Structured data:',
    schemaSession.metadata.get('structured_output'),
  );

  // Clean up resources
  await model.close();
}

/**
 * Example of using AISDKModel with MCP for tool integration
 * This is commented out as it's just for demonstration purposes
 */
// async function mcpExample() {
//   console.log('\n=== MCP Example ===');

//   try {
//     // Create an AI SDK model with OpenAI provider and MCP configuration
//     const model = new AISDKModel({
//       provider: AIProvider.OPENAI,
//       apiKey: process.env.OPENAI_API_KEY!,
//       modelName: 'gpt-4o',
//       temperature: 0.7,
//       mcpConfig: {
//         // In a real implementation, you would provide a proper transport
//         // For example, using StdioMCPTransport from 'ai/mcp-stdio'
//         transport: {
//           send: async (message: unknown) => {
//             console.log('MCP message sent:', message);
//             return { result: 'This is a mock MCP response' };
//           },
//           close: async () => {
//             console.log('MCP transport closed');
//           }
//         },
//       },
//     });

//     // Create a template
//     const template = new LinearTemplate()
//       .addSystem('You are a helpful assistant with access to tools.')
//       .addUser('What is the weather in Tokyo?')
//       .addAssistant({ model });

//     // Execute the template
//     const session = await template.execute(createSession());
//     console.log('Response:', session.getLastMessage()?.content);

//     // Clean up resources
//     await model.close();
//   } catch (error) {
//     console.error('Error in MCP example:', error);
//   }
// }

/**
 * Run all examples
 */
async function main() {
  try {
    await basicExample();
    await schemaExample();
    // Uncomment to run MCP example (requires MCP server implementation)
    // await mcpExample();
  } catch (error) {
    console.error('Error running examples:', error);
  }
}

// Run the examples
main().catch(console.error);
