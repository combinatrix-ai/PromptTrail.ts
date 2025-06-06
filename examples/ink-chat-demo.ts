/**
 * Ink CLI Interface Demo
 *
 * This example demonstrates the enhanced CLI interface using Ink.
 * It shows how Session.debug() automatically starts a rich terminal interface
 * when available, with real-time conversation updates and beautiful UI.
 */

import { Agent, Session, Source } from '../packages/core/src/index';

async function main() {
  console.log('🚀 Starting Ink CLI Demo...');
  console.log(
    'This will demonstrate the enhanced PromptTrail CLI interface.\n',
  );

  // Create a debug session - this automatically starts the Ink interface!
  const session = Session.debug({
    vars: {
      userName: 'Developer',
      sessionId: Math.random().toString(36).substring(7),
      startTime: new Date().toISOString(),
    },
  });

  // Create an interactive chat agent
  const chatAgent = Agent.system(
    'You are a helpful AI assistant with access to the user context. ' +
      'The user is {{userName}} in session {{sessionId}}. ' +
      'Be friendly and reference their context when appropriate.',
  ).loop(
    // Loop body: user input -> assistant response
    (agent) =>
      agent
        .user(Source.cli('💬 Your message (type "exit" to quit): '))
        .assistant(Source.llm().openai({ modelName: 'gpt-4o-mini' })),

    // Loop condition: continue until user types "exit"
    (session) => {
      const lastUserMessage = session.getMessagesByType('user').slice(-1)[0];
      return lastUserMessage?.content.toLowerCase().trim() !== 'exit';
    },
  );

  try {
    console.log('✨ Launching enhanced CLI interface...\n');

    // Execute the agent - this will show the beautiful Ink interface
    await chatAgent.execute(session);

    console.log('\n👋 Chat ended. Thanks for using PromptTrail!');
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);

    // Gracefully handle Ink not being available
    if (
      error instanceof Error &&
      error.message.includes('Terminal does not support')
    ) {
      console.log("\n📱 Your terminal doesn't support the enhanced UI.");
      console.log(
        "💡 Try running this in a modern terminal like iTerm2, Windows Terminal, or VS Code's integrated terminal.",
      );
      console.log(
        '🔧 Alternatively, you can force console mode with Session.debug({ ui: "console" })',
      );
    }
  }
}

/**
 * Demo with explicit UI modes
 */
async function demoUIMode() {
  console.log('\n🎯 UI Mode Demo:');

  try {
    // Force Ink mode (will error if not supported)
    console.log('Testing Ink mode...');
    const inkSession = Session.debug({ ui: 'ink' });
    console.log('✅ Ink mode available!');

    // Quick demo agent
    const quickAgent = Agent.system('You are a test assistant.')
      .user('Say hello briefly')
      .assistant(Source.llm().openai({ modelName: 'gpt-4o-mini' }));

    await quickAgent.execute(inkSession);
  } catch (error) {
    console.log('❌ Ink mode not available, falling back to console mode');

    // Force console mode
    const consoleSession = Session.debug({ ui: 'console' });
    const fallbackAgent = Agent.system('You are a console assistant.')
      .user('Hello from console mode!')
      .assistant(Source.llm().openai({ modelName: 'gpt-4o-mini' }));

    await fallbackAgent.execute(consoleSession);
  }
}

// Main execution
if (require.main === module) {
  const runDemo = async () => {
    // Check for demo mode
    if (process.argv.includes('--ui-demo')) {
      await demoUIMode();
      return;
    }

    // Check if API key is available
    if (!process.env.OPENAI_API_KEY) {
      console.error('❌ OPENAI_API_KEY environment variable is required');
      console.log(
        '💡 Set your OpenAI API key: export OPENAI_API_KEY=your_key_here',
      );
      process.exit(1);
    }

    await main();
  };

  runDemo().catch((error) => {
    console.error('💥 Demo failed:', error);
    process.exit(1);
  });
}

export { main as inkChatDemo };
