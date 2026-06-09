import { Agent, Session, Source } from '@prompttrail/core';

async function main() {
  const chatAgent = Agent.create('chat')
    .system(
      'system',
      'You are a helpful AI assistant. Be concise and friendly in your responses.',
    )
    .loop(
      'chatLoop',
      (agent) =>
        agent
          .user('input', Source.cli('Your message (type "exit" to end): '))
          .assistant('reply', Source.llm()),
      ({ session }) => {
        const lastUserMessage = session.getMessagesByType('user').slice(-1)[0];
        return lastUserMessage?.content.toLowerCase().trim() !== 'exit';
      },
    );

  // Create an initial session, enabling 'print' to log messages to the console
  const session = Session.debug();

  // Execute the chat agent
  console.log('\nStarting chat with gpt-5.4-nano (type "exit" to end)...\n');
  await chatAgent.execute({ session });
  console.log('\nChat ended. Goodbye!\n');
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
