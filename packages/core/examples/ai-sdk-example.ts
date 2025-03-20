import { createSession } from '../src/session';
import { LinearTemplate } from '../src/templates';
import { AISDKModel, AIProvider } from '../src/model/ai-sdk/model';
import { AISDKSchemaTemplate } from '../src/templates/ai_sdk_schema_template';
import { z } from 'zod';

async function main() {
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
  
  // Example with schema
  const productSchema = z.object({
    name: z.string().describe('The name of the product'),
    price: z.number().describe('The price of the product in USD'),
    inStock: z.boolean().describe('Whether the product is in stock'),
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
      { type: 'user', content: 'The new iPhone 15 Pro costs $999 and comes with a titanium frame.' }
    ]
  };
  
  // Execute the schema template
  const schemaSession = await schemaTemplate.execute(initialSession);
  console.log('Structured data:', schemaSession.metadata.get('structured_output'));
}

main().catch(console.error);
