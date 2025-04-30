import {
  Sequence,
  User,
  Assistant,
  createSession,
  createGenerateOptions,
  CLISource,
  Agent,
} from '../packages/core/src/index';

const apiKey = process.env.OPENAI_API_KEY!;

async function main() {
  // Create an interactive CLI source to get user input
  const userCliSource = new CLISource('Your message (type "exit" to end): ');

  // Create generateOptions for the OpenAI model
  const generateOptions = createGenerateOptions({
    provider: {
      type: 'openai',
      apiKey: apiKey as string,
      modelName: 'gpt-4o-mini',
    },
    temperature: 0.7,
  });

  // Create the main conversation flow using an Agent
  const template = new Agent()
    .addSystem(
      'You are a helpful AI assistant. Be concise and friendly in your responses.',
    )
    .addLoop(
      // The body of the loop is a Sequence containing the user turn and assistant turn
      new Sequence([
        // User message from the CLI
        new User(userCliSource),
        // Assistant message using the OpenAI model
        new Assistant(generateOptions),
      ]),
      (session) => {
        // Exit the loop if the user types "exit"
        return (
          session.getLastMessage()?.content.toLowerCase().trim() === 'exit'
        );
      },
    );

  // Create an initial session, enabling 'print' to log messages to the console
  const session = createSession({ print: true });

  // Execute the template
  console.log('\nStarting chat with gpt-4o-mini (type "exit" to end)...\n');
  await template.execute(session);
  console.log('\nChat ended. Goodbye!\n');
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
