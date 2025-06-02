import { Agent, Session } from '../packages/core/src/index';

async function main() {
  // Create the main conversation flow using the new direct API
  const chatAgent = Agent.system(
    'You are a helpful AI assistant. Be concise and friendly in your responses.',
  ).loop(
    // Function-based loop body
    (agent) =>
      agent
        // User message from CLI with custom prompt
        .user({ cli: 'Your message (type "exit" to end): ' })
        // Assistant message using the default model
        .assistant({ provider: 'openai', model: 'gpt-4o-mini' }),
    // Loop condition: continue until user types "exit"
    (session) => {
      const lastUserMessage = session.getMessagesByType('user').slice(-1)[0];
      return lastUserMessage?.content.toLowerCase().trim() !== 'exit';
    },
  );

  // Create an initial session, enabling 'print' to log messages to the console
  const session = Session.debug();

  // Execute the chat agent
  console.log('\nStarting chat with gpt-4o-mini (type "exit" to end)...\n');
  await chatAgent.execute(session);
  console.log('\nChat ended. Goodbye!\n');
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
