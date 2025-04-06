import {
  createSession,
  createGenerateOptions,
  LinearTemplate,
  ContentSourceSystemTemplate,
  ContentSourceUserTemplate,
  ContentSourceAssistantTemplate,
  StaticContentSource,
  CLIContentSource,
  BasicModelContentSource,
  SchemaModelContentSource,
} from '@prompttrail/core';
import { z } from 'zod';

// Define a schema for structured output
const userProfileSchema = z.object({
  name: z.string().describe("User's full name"),
  age: z.number().describe("User's age"),
  interests: z.array(z.string()).describe("User's interests"),
});

// Create generate options for OpenAI
const generateOptions = createGenerateOptions({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY || '',
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
});

async function runBasicExample() {
  console.log('Running basic example with ContentSource abstraction...');

  // Create a simple conversation template using ContentSource
  const template = new LinearTemplate()
    .addTemplate(
      new ContentSourceSystemTemplate(
        new StaticContentSource("You're a helpful assistant."),
      ),
    )
    .addTemplate(
      new ContentSourceUserTemplate(
        new StaticContentSource("What's TypeScript?"),
      ),
    )
    .addTemplate(
      new ContentSourceAssistantTemplate(
        new BasicModelContentSource(generateOptions),
      ),
    );

  // Execute the template
  const session = await template.execute(
    createSession({
      print: true, // Enable console logging
    }),
  );

  console.log('Last message:', session.getLastMessage()?.content);
}

async function runSchemaExample() {
  console.log('Running schema example with ContentSource abstraction...');

  // Create a template with schema-based output
  const template = new LinearTemplate()
    .addTemplate(
      new ContentSourceSystemTemplate(
        new StaticContentSource('You are a user profile generator.'),
      ),
    )
    .addTemplate(
      new ContentSourceUserTemplate(
        new StaticContentSource('Generate a profile for a fictional user.'),
      ),
    )
    .addTemplate(
      new ContentSourceAssistantTemplate(
        new SchemaModelContentSource(generateOptions, userProfileSchema, {
          functionName: 'generateUserProfile',
        }),
      ),
    );

  // Execute the template
  const session = await template.execute(
    createSession({
      print: true, // Enable console logging
    }),
  );

  // Access the structured output
  const userProfile = session.metadata.get('structured_output');
  console.log('Generated user profile:', userProfile);
}

async function runInteractiveExample() {
  console.log('Running interactive example with ContentSource abstraction...');

  // Create an interactive conversation template
  const template = new LinearTemplate()
    .addTemplate(
      new ContentSourceSystemTemplate(
        new StaticContentSource("You're a helpful assistant."),
      ),
    )
    .addTemplate(
      new ContentSourceUserTemplate(
        new CLIContentSource('What would you like to know? '),
      ),
    )
    .addTemplate(
      new ContentSourceAssistantTemplate(
        new BasicModelContentSource(generateOptions),
      ),
    );

  // Execute the template
  const session = await template.execute(
    createSession({
      print: true, // Enable console logging
    }),
  );

  console.log('Last message:', session.getLastMessage()?.content);
}

// Run the examples
async function main() {
  try {
    await runBasicExample();
    console.log('\n-------------------\n');

    await runSchemaExample();
    console.log('\n-------------------\n');

    await runInteractiveExample();
  } catch (error) {
    console.error('Error running examples:', error);
  }
}

// Check if this file is being run directly
if (require.main === module) {
  main();
}
