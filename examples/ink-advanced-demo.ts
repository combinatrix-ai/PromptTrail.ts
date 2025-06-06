/**
 * Advanced Ink CLI Demo
 *
 * This example shows advanced features of the Ink CLI interface:
 * - Variable tracking and updates
 * - Tool integration with visual feedback
 * - Complex conversation flows
 * - Dynamic session state management
 */

import { Agent, Session, Source, Tool } from '../packages/core/src/index';
import { z } from 'zod';

// Define some demo tools for visual feedback
const calculatorTool = Tool.create({
  description: 'Perform basic math calculations',
  parameters: z.object({
    expression: z
      .string()
      .describe('Mathematical expression to evaluate (e.g., "2 + 3 * 4")'),
  }),
  execute: async (input) => {
    try {
      // Simple math evaluation (in real app, use safer eval)
      const result = Function(`"use strict"; return (${input.expression})`)();
      return {
        result,
        expression: input.expression,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        error: 'Invalid mathematical expression',
        expression: input.expression,
      };
    }
  },
});

const weatherTool = Tool.create({
  description: 'Get simulated weather information',
  parameters: z.object({
    location: z.string().describe('City name to get weather for'),
  }),
  execute: async (input) => {
    // Simulate API delay
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const temperatures = [68, 72, 75, 78, 82, 85];
    const conditions = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy'];

    return {
      location: input.location,
      temperature:
        temperatures[Math.floor(Math.random() * temperatures.length)],
      condition: conditions[Math.floor(Math.random() * conditions.length)],
      humidity: Math.floor(Math.random() * 40) + 30,
      timestamp: new Date().toISOString(),
    };
  },
});

const memoryTool = Tool.create({
  description: 'Store or retrieve information from session memory',
  parameters: z.object({
    action: z.enum(['store', 'retrieve', 'list']),
    key: z.string().optional().describe('Key for storing/retrieving data'),
    value: z.string().optional().describe('Value to store'),
  }),
  execute: async (input) => {
    // This would interact with session variables in a real implementation
    const memories = new Map<string, string>();

    switch (input.action) {
      case 'store':
        if (input.key && input.value) {
          memories.set(input.key, input.value);
          return { success: true, key: input.key, value: input.value };
        }
        return { error: 'Key and value required for storing' };

      case 'retrieve':
        if (input.key) {
          const value = memories.get(input.key);
          return value ? { key: input.key, value } : { error: 'Key not found' };
        }
        return { error: 'Key required for retrieving' };

      case 'list':
        return { memories: Array.from(memories.entries()) };

      default:
        return { error: 'Invalid action' };
    }
  },
});

async function advancedDemo() {
  console.log('🚀 Advanced Ink CLI Demo');
  console.log('This demo showcases advanced features:\n');
  console.log('✨ Rich conversation interface');
  console.log('🔧 Tool integration with visual feedback');
  console.log('📊 Variable tracking and updates');
  console.log('🔄 Dynamic session state management\n');

  // Create an enhanced debug session with initial state
  const session = Session.debug({
    vars: {
      userName: 'Advanced User',
      sessionType: 'advanced_demo',
      toolsUsed: 0,
      lastToolResult: null,
      preferences: {
        verboseOutput: true,
        showTimestamps: true,
      },
    },
  });

  // Create an advanced agent with tools and state management
  const advancedAgent = Agent.system(
    'You are an advanced AI assistant with access to tools and session state. ' +
      'The user is {{userName}} in a {{sessionType}} session. ' +
      'You have used {{toolsUsed}} tools so far. ' +
      'Available tools: calculator, weather, memory. ' +
      'Be helpful and demonstrate the tools when appropriate!',
  )
    .transform((session) => {
      // Update session stats
      return session.withVars({
        sessionStart: new Date().toISOString(),
        messageCount: session.messages.length,
      });
    })
    .loop(
      (agent) =>
        agent
          .user(
            Source.cli(
              '🤖 What would you like me to help with? (calculator/weather/memory/exit): ',
            ),
          )
          .assistant(
            Source.llm()
              .openai({ modelName: 'gpt-4o-mini' })
              .withTools({
                calculator: calculatorTool,
                weather: weatherTool,
                memory: memoryTool,
              })
              .temperature(0.7),
          )
          .transform((session) => {
            // Track tool usage
            const lastMessage = session.getLastMessage();
            const toolCallsCount = lastMessage?.toolCalls?.length || 0;

            if (toolCallsCount > 0) {
              return session.withVars({
                toolsUsed: session.getVar('toolsUsed', 0) + toolCallsCount,
                lastToolUsed: lastMessage?.toolCalls?.[0]?.name,
                lastToolTime: new Date().toISOString(),
              });
            }

            return session;
          }),

      // Continue until user wants to exit
      (session) => {
        const lastUserMessage = session.getMessagesByType('user').slice(-1)[0];
        const content = lastUserMessage?.content.toLowerCase().trim();
        return content !== 'exit' && content !== 'quit';
      },
    )
    .transform((session) => {
      // Final session summary
      return session.withVars({
        sessionEnd: new Date().toISOString(),
        finalMessageCount: session.messages.length,
        totalToolsUsed: session.getVar('toolsUsed', 0),
      });
    });

  try {
    console.log('🎯 Starting advanced session...\n');

    const finalSession = await advancedAgent.execute(session);

    // Display session summary
    console.log('\n📊 Session Summary:');
    console.log(`Messages: ${finalSession.getVar('finalMessageCount', 0)}`);
    console.log(`Tools Used: ${finalSession.getVar('totalToolsUsed', 0)}`);
    console.log(
      `Duration: ${finalSession.getVar('sessionStart')} → ${finalSession.getVar('sessionEnd')}`,
    );
    console.log('\n✅ Advanced demo completed!');
  } catch (error) {
    console.error(
      '❌ Error in advanced demo:',
      error instanceof Error ? error.message : error,
    );

    if (
      error instanceof Error &&
      error.message.includes('Terminal does not support')
    ) {
      console.log('\n📱 Enhanced UI not available in this terminal.');
      console.log(
        '💡 The demo will still work in console mode with Session.debug({ ui: "console" })',
      );
    }
  }
}

/**
 * Simple validation demo
 */
async function validationDemo() {
  console.log('\n🔍 Input Validation Demo:');

  try {
    const validationSession = Session.debug({ ui: 'auto' });

    const validationAgent = Agent.system('You help users with number input.')
      .user(
        Source.cli('Enter a number between 1 and 100: ')
          .validate({
            validate: async (content: string) => {
              const num = parseInt(content);
              if (isNaN(num)) {
                return {
                  isValid: false,
                  instruction: 'Please enter a valid number',
                };
              }
              if (num < 1 || num > 100) {
                return {
                  isValid: false,
                  instruction: 'Number must be between 1 and 100',
                };
              }
              return { isValid: true };
            },
          })
          .withMaxAttempts(3),
      )
      .assistant(Source.llm().openai({ modelName: 'gpt-4o-mini' }));

    await validationAgent.execute(validationSession);
  } catch (error) {
    console.log('Validation demo error:', error);
  }
}

// Main execution
if (require.main === module) {
  const runDemo = async () => {
    // Check command line arguments
    if (process.argv.includes('--validation')) {
      await validationDemo();
      return;
    }

    // Check if API key is available
    if (!process.env.OPENAI_API_KEY) {
      console.error('❌ OPENAI_API_KEY environment variable is required');
      console.log(
        '💡 Set your OpenAI API key: export OPENAI_API_KEY=your_key_here',
      );
      console.log(
        '🎯 Or run with --validation flag for input validation demo only',
      );
      process.exit(1);
    }

    await advancedDemo();
  };

  runDemo().catch((error) => {
    console.error('💥 Advanced demo failed:', error);
    process.exit(1);
  });
}

export { advancedDemo };
