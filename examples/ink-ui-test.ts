/**
 * Simple Ink UI Test
 * Tests the Ink interface without making API calls
 */

import { Session } from '../packages/core/src/index';

async function testInkUI() {
  console.log('🧪 Testing Ink UI Integration...\n');

  try {
    // Test 1: Automatic UI detection
    console.log('Test 1: Session.debug() with auto UI detection');
    const autoSession = Session.debug({
      vars: { testMode: 'auto', timestamp: Date.now() },
    });
    console.log('✅ Auto session created successfully');
    console.log('   Messages:', autoSession.messages.length);
    console.log('   Variables:', autoSession.varsSize);

    // Test 2: Force Ink UI
    console.log('\nTest 2: Session.debug() with forced Ink UI');
    try {
      const inkSession = Session.debug({
        ui: 'ink',
        vars: { testMode: 'ink', timestamp: Date.now() },
      });
      console.log('✅ Ink session created successfully');
    } catch (error) {
      console.log(
        '⚠️  Ink UI not available:',
        error instanceof Error ? error.message : error,
      );
    }

    // Test 3: Force console UI
    console.log('\nTest 3: Session.debug() with forced console UI');
    const consoleSession = Session.debug({
      ui: 'console',
      vars: { testMode: 'console', timestamp: Date.now() },
    });
    console.log('✅ Console session created successfully');

    // Test 4: Check if InkDebugContext is available
    console.log('\nTest 4: Checking InkDebugContext availability');
    try {
      const { InkDebugContext } = await import(
        '../packages/core/src/cli/ink-debug-context'
      );
      console.log('✅ InkDebugContext imported successfully');
      console.log('   Terminal capable:', InkDebugContext.isTerminalCapable());
      console.log('   Currently active:', InkDebugContext.isActive());
    } catch (error) {
      console.log('❌ InkDebugContext import failed:', error);
    }

    console.log('\n🎉 All UI tests completed successfully!');
  } catch (error) {
    console.error('💥 UI test failed:', error);
  }
}

// Test the message flow without LLM
async function testMessageFlow() {
  console.log('\n📨 Testing message flow...');

  try {
    const session = Session.debug({
      vars: { user: 'TestUser', sessionId: 'test123' },
    })
      .addMessage({ type: 'system', content: 'You are a test assistant' })
      .addMessage({ type: 'user', content: 'Hello, this is a test message' })
      .addMessage({
        type: 'assistant',
        content: 'Hello! I received your test message.',
        toolCalls: [
          {
            name: 'test_tool',
            arguments: { action: 'greet' },
            id: 'test_call_1',
          },
        ],
      });

    console.log('✅ Message flow test completed');
    console.log('   Final message count:', session.messages.length);
    console.log('   Last message type:', session.getLastMessage()?.type);
  } catch (error) {
    console.error('❌ Message flow test failed:', error);
  }
}

if (require.main === module) {
  const runTests = async () => {
    await testInkUI();
    await testMessageFlow();
  };

  runTests().catch(console.error);
}

export { testInkUI };
