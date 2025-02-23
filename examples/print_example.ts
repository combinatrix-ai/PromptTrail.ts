import { LinearTemplate, createSession } from '../packages/core/src/index';
import { OpenAIModel } from '../packages/core/src/model/openai/model';
import type { OpenAIConfig } from '../packages/core/src/model/openai/types';
import { createTemperature } from '../packages/core/src/types';

// Get API key from environment variable
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

async function main() {
  try {
    // Create OpenAI model instance
    const model = new OpenAIModel({
      modelName: 'gpt-4o-mini',
      temperature: createTemperature(0.7),
      apiKey: apiKey as string,
    } satisfies OpenAIConfig);

    // Create conversation template
    const template = new LinearTemplate()
      .addSystem('You are a helpful AI assistant.')
      .addUser('Hello!', 'Hello!')
      .addAssistant({ model });

    // Create session with print enabled
    const session = createSession({ print: true });

    // Execute the template
    console.log('\nStarting conversation with print mode enabled...\n');
    await template.execute(session);
    console.log('\nConversation ended.\n');
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Error:', error.message);
    } else {
      console.error('Unknown error:', error);
    }
    process.exit(1);
  }
}

// Start the example
main();
