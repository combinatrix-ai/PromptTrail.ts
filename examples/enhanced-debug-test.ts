/**
 * Enhanced Debug Interface Test
 *
 * This example tests the new enhanced debugging interface with:
 * - Multi-panel layout with conversation, variables, and events
 * - Real-time event tracking
 * - Variable inspection with categories
 * - Enhanced session metadata
 */

import { Agent, Session, Source } from '../packages/core/src/index';
import { InkDebugContext } from '../packages/core/src/cli/index';

async function testEnhancedDebug() {
  console.log('🧪 Testing Enhanced Debug Interface...');
  console.log('This will demonstrate the new multi-panel debugging UI.\n');

  // Force enhanced renderer
  InkDebugContext.setEnhancedRenderer(true);

  // Create a debug session with initial variables
  const session = Session.debug({
    context: {
      userName: 'TestUser',
      sessionType: 'enhanced_debug_test',
      testPhase: 'initialization',
      counter: 0,
      toolsUsed: 0,
      preferences: {
        debugMode: true,
        verboseLogging: true,
      },
    },
  });

  // Create a test agent that demonstrates various features
  const testAgent = Agent.create()
    .system(
      'You are a helpful assistant for testing the enhanced debug interface. ' +
        'The user is {{userName}} in a {{sessionType}} session. ' +
        'We are currently in the {{testPhase}} phase. ' +
        'Please be brief in your responses for testing purposes.',
    )
    .transform((session) => {
      // Update test phase
      return session.withContext({ testPhase: 'conversation_started' });
    })
    .user('Hello! This is a test of the enhanced debug interface.')
    .assistant(Source.llm().openai({ modelName: 'gpt-4o-mini' }))
    .transform((session) => {
      // Increment counter and update variables
      const currentCounter = session.getVar('counter', 0);
      return session.withContext({
        counter: currentCounter + 1,
        lastResponse:
          session.getLastMessage()?.content.substring(0, 50) + '...',
        testPhase: 'mid_conversation',
      });
    })
    .user('Can you count to 3 for me?')
    .assistant(Source.llm().openai({ modelName: 'gpt-4o-mini' }))
    .transform((session) => {
      // Final update
      return session.withContext({
        counter: session.getVar('counter', 0) + 1,
        testPhase: 'completion',
        totalMessages: session.messages.length,
      });
    })
    .user('Thank you! That concludes the test.')
    .assistant(Source.llm().openai({ modelName: 'gpt-4o-mini' }));

  try {
    console.log('🚀 Starting enhanced debug session...');
    console.log('Features to observe:');
    console.log('- 📊 Multi-panel layout (conversation | variables | events)');
    console.log('- ⚡ Real-time event stream');
    console.log('- 📝 Variable categorization and live updates');
    console.log('- 🎯 Session metadata tracking');
    console.log('- 🔧 Enhanced message display with metadata');
    console.log('- 🎮 Keyboard navigation (Tab, V, E, M keys)');
    console.log('');

    // Execute the test agent
    const finalSession = await testAgent.execute(session);

    console.log('\n✅ Enhanced debug test completed successfully!');
    console.log('📊 Final Statistics:');
    console.log(`- Messages: ${finalSession.messages.length}`);
    console.log(`- Variables: ${finalSession.varsSize}`);
    console.log(`- Final Counter: ${finalSession.getVar('counter', 0)}`);
    console.log(`- Test Phase: ${finalSession.getVar('testPhase', 'unknown')}`);
  } catch (error) {
    console.error(
      '❌ Enhanced debug test failed:',
      error instanceof Error ? error.message : error,
    );

    if (
      error instanceof Error &&
      error.message.includes('Terminal does not support')
    ) {
      console.log('\n📱 Enhanced UI not available in this terminal.');
      console.log(
        '💡 Try running in a modern terminal like iTerm2, Windows Terminal, or VS Code.',
      );
      console.log(
        '🔧 Or test the basic interface with InkDebugContext.setEnhancedRenderer(false)',
      );
    }
  }
}

/**
 * Simple test without LLM calls (for environments without API keys)
 */
async function testSimpleEnhancedDebug() {
  console.log('🧪 Testing Enhanced Debug Interface (Simple Mode)...');

  // Force enhanced renderer
  InkDebugContext.setEnhancedRenderer(true);

  // Create a debug session
  const session = Session.debug({
    context: {
      testMode: 'simple',
      version: '1.0',
      features: ['events', 'variables', 'metadata'],
    },
  });

  // Create a simple agent with static responses
  const simpleAgent = Agent.create()
    .system('Test system message for enhanced debug interface')
    .user('Test user message')
    .assistant(
      'Test assistant response - this is a static response for testing',
    )
    .transform((session) => {
      return session.withContext({
        testComplete: true,
        messageCount: session.messages.length,
      });
    });

  try {
    console.log('🚀 Running simple enhanced debug test...');
    const result = await simpleAgent.execute(session);

    console.log('\n✅ Simple enhanced debug test completed!');
    console.log(`📊 Messages: ${result.messages.length}`);
    console.log(`📊 Variables: ${result.varsSize}`);
  } catch (error) {
    console.error('❌ Simple enhanced debug test failed:', error);
  }
}

// Main execution
if (require.main === module) {
  const runTest = async () => {
    // Check command line arguments
    if (process.argv.includes('--simple')) {
      await testSimpleEnhancedDebug();
      return;
    }

    // Check if API key is available for full test
    if (!process.env.OPENAI_API_KEY) {
      console.log('⚠️  OPENAI_API_KEY not found - running simple test');
      console.log(
        '💡 Set API key for full test: export OPENAI_API_KEY=your_key',
      );
      console.log('🔧 Or run with --simple flag for basic testing\n');
      await testSimpleEnhancedDebug();
      return;
    }

    await testEnhancedDebug();
  };

  runTest().catch((error) => {
    console.error('💥 Test failed:', error);
    process.exit(1);
  });
}

export { testEnhancedDebug, testSimpleEnhancedDebug };
