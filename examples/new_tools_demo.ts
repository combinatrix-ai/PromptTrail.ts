#!/usr/bin/env bun

import { Agent, Session } from '../packages/core/src/index.js';
import { 
  memoryRead, 
  memoryWrite, 
  think, 
  agent,
  defaultTools 
} from '../packages/core/src/tools/index.js';

async function demonstrateNewTools() {
  console.log('🚀 Demonstrating new PromptTrail.ts tools');
  console.log('==================================================\n');

  // 1. Demonstrate Think Tool
  console.log('1. 🧠 Think Tool - Internal reasoning');
  const thinkResult = await (think as any).execute({
    thought: 'How should I approach implementing a new feature?',
    thinking_type: 'planning',
    confidence_level: 85,
    tags: ['feature-development', 'planning']
  });
  
  console.log('✅ Thought processed:');
  console.log(`   Type: ${thinkResult.thinking_type}`);
  console.log(`   Insights: ${thinkResult.insights.join(', ')}`);
  console.log(`   Quality: ${thinkResult.reasoning_quality}\n`);

  // 2. Demonstrate Memory Tools
  console.log('2. 💾 Memory Tools - Persistent context');
  
  // Write to memory
  const memoryWriteResult = await (memoryWrite as any).execute({
    content: 'User prefers TypeScript over JavaScript for new projects',
    category: 'user_preferences',
    tags: ['typescript', 'languages', 'preferences']
  });
  
  console.log('✅ Memory written:');
  console.log(`   Entry ID: ${memoryWriteResult.entry_id}`);
  console.log(`   Total entries: ${memoryWriteResult.total_entries}\n`);

  // Read from memory
  const memoryReadResult = await (memoryRead as any).execute({
    category: 'user_preferences'
  });
  
  console.log('✅ Memory read:');
  console.log(`   Found ${memoryReadResult.filtered_count} entries`);
  console.log(`   Categories: ${memoryReadResult.available_categories.join(', ')}\n`);

  // 3. Demonstrate Agent Tool
  console.log('3. 🤖 Agent Tool - Task delegation');
  
  const agentResult = await (agent as any).execute({
    task_description: 'Analyze code quality and suggest improvements',
    agent_type: 'analyst',
    execution_mode: 'sync',
    context: { 
      project: 'PromptTrail.ts',
      focus: 'code_quality' 
    }
  });
  
  console.log('✅ Agent task completed:');
  console.log(`   Agent: ${agentResult.agent_type}`);
  console.log(`   Status: ${agentResult.status}`);
  console.log(`   Result: ${agentResult.result.analysis}\n`);

  // 4. Show expanded tool categories
  console.log('4. 🛠️  Tool Categories - Organized tool access');
  console.log('Available tool categories:');
  console.log(`   • Memory tools: ${Object.keys(defaultTools).filter(k => k.includes('memory')).length} tools`);
  console.log(`   • Reasoning tools: ${['think', 'agent'].length} tools`);
  console.log(`   • Total tools: ${Object.keys(defaultTools).length} tools\n`);

  // 5. Show integration with Agent builder
  console.log('5. 🔗 Integration with Agent Builder');
  
  const session = Session.create({
    context: {
      projectName: 'PromptTrail.ts',
      userPreferences: 'TypeScript, clean code, good documentation'
    }
  });

  // Note: In a real scenario, you'd use these tools with actual LLM calls
  console.log('✅ Tools ready for Agent integration:');
  console.log('   - Can be used with Agent.create().withTools([...])');
  console.log('   - Persistent memory across conversations');
  console.log('   - Internal reasoning before responses');
  console.log('   - Task delegation to specialized agents\n');

  console.log('🎉 New tools demonstration complete!');
}

// Run the demonstration
demonstrateNewTools().catch(console.error);