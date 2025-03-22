import {
  createSession,
  LinearTemplate,
  defineSchema,
  createStringProperty,
  createNumberProperty,
  createBooleanProperty,
  type GenerateOptions,
} from '../packages/core/src';

/**
 * This example demonstrates how to use schema validation with Anthropic models
 * to enforce structured output from LLM responses.
 */
async function main() {
  // Define generateOptions for Anthropic
  const generateOptions: GenerateOptions = {
    provider: {
      type: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY || 'your-api-key-here',
      modelName: 'claude-3-5-haiku-latest',
    },
    temperature: 0.7,
  };

  // Define a schema for product information
  const productSchema = defineSchema({
    properties: {
      name: createStringProperty('The name of the product'),
      price: createNumberProperty('The price of the product in USD'),
      inStock: createBooleanProperty('Whether the product is in stock'),
      description: createStringProperty('A short description of the product'),
    },
    required: ['name', 'price', 'inStock'],
  });

  console.log('Extracting product information using Anthropic...');

  // Create a template with schema validation
  const template = new LinearTemplate()
    .addSystem(
      'You are a helpful assistant that extracts product information from text.',
    )
    .addUser(
      'The new iPhone 15 Pro costs $999 and comes with a titanium frame. It is currently available for purchase at the Apple Store.',
    );

  // Add schema validation (async operation)
  await template.addSchema(productSchema, { generateOptions, maxAttempts: 3 });

  // Execute the template
  const session = await template.execute(createSession());

  // Get the structured output from the session metadata with proper typing
  type ProductInfo = {
    name: string;
    price: number;
    inStock: boolean;
    description?: string;
  };

  const product = session.metadata.get(
    'structured_output',
  ) as unknown as ProductInfo;

  console.log('\nExtracted product information:');
  console.log(JSON.stringify(product, null, 2));

  // Access individual fields with proper typing
  console.log('\nProduct details:');
  console.log(`- Name: ${product.name}`);
  console.log(`- Price: $${product.price}`);
  console.log(`- In Stock: ${product.inStock ? 'Yes' : 'No'}`);
  if (product.description) {
    console.log(`- Description: ${product.description}`);
  }
}

main().catch(console.error);
