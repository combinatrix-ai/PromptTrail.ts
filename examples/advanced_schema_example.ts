import {
  createSession,
  LinearTemplate,
  OpenAIModel,
  defineSchema,
  createStringProperty,
  createNumberProperty,
  createBooleanProperty,
  SchemaTemplate,
} from '../packages/core/src';

/**
 * This example demonstrates more advanced usage of schema validation
 * with direct use of SchemaTemplate and function calling.
 */
async function main() {
  // Create an OpenAI model instance
  const model = new OpenAIModel({
    modelName: 'gpt-4o-mini',
    temperature: 0.7,
    apiKey: process.env.OPENAI_API_KEY || 'your-api-key-here',
  });

  // Define a schema for user profile information
  const userProfileSchema = defineSchema({
    properties: {
      name: createStringProperty('The full name of the user'),
      age: createNumberProperty('The age of the user in years'),
      email: createStringProperty('The email address of the user'),
      interests: createStringProperty(
        'A comma-separated list of user interests',
      ),
      isPremiumMember: createBooleanProperty(
        'Whether the user is a premium member',
      ),
    },
    required: ['name', 'age', 'email'],
  });

  // Method 1: Using LinearTemplate with addSchema
  console.log('Method 1: Using LinearTemplate with addSchema');

  const template1 = new LinearTemplate()
    .addSystem(
      'You are a helpful assistant that extracts user profile information from text.',
    )
    .addUser(
      'John Doe is a 32-year-old software engineer who enjoys hiking, photography, and reading. His email is john.doe@example.com. He has been a premium subscriber for 2 years.',
      '',
    );

  // Add schema validation (async operation)
  await template1.addSchema(userProfileSchema, { model });

  const session1 = await template1.execute(createSession());

  // Get the structured output
  type UserProfile = {
    name: string;
    age: number;
    email: string;
    interests?: string;
    isPremiumMember?: boolean;
  };

  const profile1 = session1.metadata.get(
    'structured_output',
  ) as unknown as UserProfile;

  console.log('\nExtracted user profile (Method 1):');
  console.log(JSON.stringify(profile1, null, 2));

  // Method 2: Using SchemaTemplate directly with function calling
  console.log('\nMethod 2: Using SchemaTemplate directly');

  // Create a session with system and user messages
  let session2 = createSession();
  session2 = await session2.addMessage({
    type: 'system',
    content:
      'You are a helpful assistant that extracts user profile information from text.',
    metadata: undefined,
  });

  session2 = await session2.addMessage({
    type: 'user',
    content:
      'Jane Smith is a 28-year-old graphic designer who enjoys painting, traveling, and cooking. Her email is jane.smith@example.com. She is not currently a premium member.',
    metadata: undefined,
  });

  // Create and execute the schema template directly
  const schemaTemplate = new SchemaTemplate({
    model,
    schema: userProfileSchema,
    functionName: 'extract_user_profile', // Custom function name
    maxAttempts: 3,
  });

  const resultSession = await schemaTemplate.execute(session2);

  // Get the structured output - use unknown as intermediate type for safety
  const profile2 = resultSession.metadata.get(
    'structured_output',
  ) as unknown as UserProfile;

  console.log('\nExtracted user profile (Method 2):');
  console.log(JSON.stringify(profile2, null, 2));

  // Compare the two methods
  console.log('\nComparison of both methods:');
  console.log('Method 1 - Name:', profile1.name);
  console.log('Method 2 - Name:', profile2.name);

  console.log('Method 1 - Age:', profile1.age);
  console.log('Method 2 - Age:', profile2.age);

  console.log('Method 1 - Email:', profile1.email);
  console.log('Method 2 - Email:', profile2.email);

  console.log('Method 1 - Interests:', profile1.interests || 'Not provided');
  console.log('Method 2 - Interests:', profile2.interests || 'Not provided');

  console.log(
    'Method 1 - Premium Member:',
    profile1.isPremiumMember ? 'Yes' : 'No',
  );
  console.log(
    'Method 2 - Premium Member:',
    profile2.isPremiumMember ? 'Yes' : 'No',
  );
}

main().catch(console.error);
