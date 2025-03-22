import {
  LinearTemplate,
  createSession,
  type GenerateOptions,
} from '../packages/core/src/index';

// Get API key from environment variable
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

async function main() {
  try {
    // Define generateOptions for OpenAI
    const generateOptions: GenerateOptions = {
      provider: {
        type: 'openai',
        apiKey: apiKey as string,
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    };

    // Create conversation template
    const template = new LinearTemplate()
      .addSystem('You are a helpful AI assistant.')
      .addUser('Hello!', 'Hello!')
      .addAssistant({ generateOptions });

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
