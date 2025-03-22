import {
  createSession,
  LinearTemplate,
  type GenerateOptions,
} from '../packages/core/src';
import { z } from 'zod';

/**
 * This example demonstrates how to use Zod schema validation with Anthropic models
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

  // Define a schema using Zod
  const productSchema = z.object({
    name: z.string().describe('The name of the product'),
    price: z.number().describe('The price of the product in USD'),
    inStock: z.boolean().describe('Whether the product is in stock'),
    description: z
      .string()
      .optional()
      .describe('A short description of the product'),
    features: z.array(z.string()).describe('List of product features'),
    ratings: z
      .object({
        average: z.number().min(0).max(5).describe('Average rating out of 5'),
        count: z.number().int().describe('Number of ratings'),
      })
      .describe('Product ratings information'),
  });

  console.log(
    'Extracting product information using Anthropic with Zod schema...',
  );

  // Create a template with schema validation
  const template = new LinearTemplate()
    .addSystem(
      'You are a helpful assistant that extracts detailed product information from text.',
    )
    .addUser(
      'The new iPhone 15 Pro costs $999 and comes with a titanium frame, A17 Pro chip, and a 48MP camera system. It has an average rating of 4.8 out of 5 from over 2,500 reviews. It is currently available for purchase at the Apple Store.',
    );

  // Add schema validation (async operation)
  await template.addSchema(productSchema, { generateOptions, maxAttempts: 3 });

  // Execute the template
  const session = await template.execute(createSession());

  // Get the structured output from the session metadata with proper typing
  type ProductInfo = z.infer<typeof productSchema>;

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
  console.log(`- Features: ${product.features.join(', ')}`);
  // Check if the ratings object has the expected properties
  // Define a type for the possible response format
  type PossibleRatingsFormat = {
    average?: number;
    averageRating?: number;
    count?: number;
    totalReviews?: number;
  };

  const ratings = product.ratings as unknown as PossibleRatingsFormat;
  const averageRating = ratings.average || ratings.averageRating;
  const reviewCount = ratings.count || ratings.totalReviews;

  console.log(`- Average Rating: ${averageRating} (${reviewCount} reviews)`);
  if (product.description) {
    console.log(`- Description: ${product.description}`);
  }
}

main().catch(console.error);
