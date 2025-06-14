import { Agent, Session } from '@prompttrail/core';
import { createMCPClient, MCPSource } from '@prompttrail/core/mcp';

/**
 * Demo: Using MCP (Model Context Protocol) with PromptTrail.ts
 * 
 * This example shows how to integrate MCP servers into your PromptTrail workflows.
 * MCP allows you to connect to external tools, resources, and prompts.
 */

async function main() {
  // Create an MCP client
  const mcpClient = createMCPClient({
    name: 'prompttrail-demo',
    version: '1.0.0'
  });

  // Connect to an MCP server (using HTTP transport in this example)
  await mcpClient.connect({
    type: 'http',
    url: 'http://localhost:3000/mcp'
  });

  console.log('Connected to MCP server!');

  // Example 1: Using MCP tools in a conversation
  console.log('\n=== Example 1: Calculator Tool ===');
  
  const calculatorAgent = Agent.create()
    .system('You are a helpful math assistant')
    .user('I need to calculate 156 * 89')
    .assistant('Let me calculate that for you.')
    .user(MCPSource.tool(mcpClient, 'calculate', {
      arguments: { operation: 'multiply', a: 156, b: 89 },
      extractText: true
    }))
    .assistant('156 × 89 = 13,884');

  const calcSession = Session.debug();
  await calculatorAgent.execute(calcSession);

  // Example 2: Reading MCP resources
  console.log('\n=== Example 2: Reading Resources ===');
  
  const resourceAgent = Agent.create()
    .system('You are a system information assistant')
    .user('What is the current system configuration?')
    .assistant('Let me check the system configuration for you.')
    .user(MCPSource.resource(mcpClient, 'config://app/settings', {
      extractText: true
    }))
    .transform(session => {
      const lastMessage = session.getLastMessage();
      const config = JSON.parse(lastMessage?.content || '{}');
      return session.withVar('configSummary', `API v${config.api_version}, Max Results: ${config.max_results}`);
    })
    .assistant('The system is running {{configSummary}}');

  const resourceSession = Session.debug();
  await resourceAgent.execute(resourceSession);

  // Example 3: Using MCP prompts
  console.log('\n=== Example 3: MCP Prompts ===');
  
  const promptAgent = Agent.create()
    .system('You are a code review assistant')
    .user('I have some code that needs review')
    .assistant('I\'ll help you review the code. Let me prepare the review template.')
    .user(MCPSource.prompt(mcpClient, 'code-review', {
      arguments: {
        code: `
function processData(items) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i] > 0) {
      results.push(items[i] * 2);
    }
  }
  return results;
}`,
        language: 'javascript',
        focus: ['performance', 'modern syntax']
      },
      format: 'messages'
    }))
    .assistant('Based on the review template, here are my suggestions...');

  const promptSession = Session.debug();
  await promptAgent.execute(promptSession);

  // Example 4: Complex workflow with multiple MCP operations
  console.log('\n=== Example 4: Complex Workflow ===');
  
  const workflowAgent = Agent.create()
    .system('You are a project management assistant')
    // Step 1: List available projects
    .user('Show me the current projects')
    .user(MCPSource.tool(mcpClient, 'list-entities', {
      arguments: { entityType: 'projects', limit: 3 },
      extractText: true
    }))
    .transform(session => {
      const projects = JSON.parse(session.getLastMessage()?.content || '[]');
      const projectList = projects.map((p: any) => `- ${p.name} (${p.status})`).join('\n');
      return session.withVar('projectList', projectList);
    })
    .assistant('Here are the current projects:\n{{projectList}}')
    // Step 2: Get detailed info about a specific project
    .user('Tell me more about Project Alpha')
    .user(MCPSource.resource(mcpClient, 'projects://p1', {
      extractText: true
    }))
    .transform(session => {
      const project = JSON.parse(session.getLastMessage()?.content || '{}');
      return session
        .withVar('projectName', project.name)
        .withVar('projectStatus', project.status)
        .withVar('projectDescription', project.description);
    })
    .assistant('{{projectName}} is currently {{projectStatus}}. Description: {{projectDescription}}')
    // Step 3: Update project status
    .user('Let\'s mark it as completed')
    .transform(s => s.withVar('projectId', 'p1').withVar('newStatus', 'completed'))
    .assistant(MCPSource.model(mcpClient, 'update-project-status'))
    .assistant('Great! I\'ve updated the project status.');

  const workflowSession = Session.debug();
  await workflowAgent.execute(workflowSession);

  // Example 5: Using MCP in conditional logic
  console.log('\n=== Example 5: Conditional MCP Usage ===');
  
  const conditionalAgent = Agent.create<{ needsCalculation: boolean; operation: string }>()
    .system('You are a smart assistant')
    .user('{{operation}}')
    .conditional(
      (s) => s.getVar('needsCalculation', false),
      // If calculation is needed, use the calculator tool
      (a) => a
        .assistant('I\'ll calculate that for you.')
        .transform(s => {
          // Parse the operation (simple example)
          const op = s.getVar('operation', '');
          const match = op.match(/(\d+)\s*\*\s*(\d+)/);
          if (match) {
            return s.withVar('a', parseInt(match[1])).withVar('b', parseInt(match[2]));
          }
          return s;
        })
        .assistant(MCPSource.model(mcpClient, 'calculate'))
        .transform(s => s.withVar('operation', 'multiply')),
      // Otherwise, just respond normally
      (a) => a.assistant('I understand. How can I help you with that?')
    );

  // Test with calculation
  const calcCondSession = Session.create({
    context: { needsCalculation: true, operation: 'What is 25 * 4?' }
  });
  await conditionalAgent.execute(calcCondSession);

  // Test without calculation
  const noCalcSession = Session.create({
    context: { needsCalculation: false, operation: 'Tell me about the weather' }
  });
  await conditionalAgent.execute(noCalcSession);

  // Disconnect from MCP server
  await mcpClient.disconnect();
  console.log('\nDisconnected from MCP server.');
}

// Run the demo
main().catch(console.error);