import { Agent, Session, Source } from '@prompttrail/core';
import { 
  createMCPClient, 
  MCPToolFactory, 
  MCPTools, 
  globalMCPToolRegistry 
} from '@prompttrail/core/mcp';

/**
 * Demo: Dynamic Tool Creation from MCP Servers
 * 
 * This example demonstrates how to automatically create PromptTrail tools
 * from MCP servers using JSON Schema to Zod conversion and dynamic tool generation.
 */

async function main() {
  console.log('🚀 Dynamic MCP Tools Demo\n');

  // Create an MCP client
  const mcpClient = createMCPClient({
    name: 'dynamic-tools-demo',
    version: '1.0.0'
  });

  // Connect to an MCP server
  await mcpClient.connect({
    type: 'http',
    url: 'http://localhost:3000/mcp'
  });

  console.log('✅ Connected to MCP server!');

  // Example 1: Preview available tools before creating them
  console.log('\n=== Example 1: Preview Available Tools ===');
  
  const factory = new MCPToolFactory(mcpClient);
  const preview = await factory.previewTools();
  
  console.log(`Found ${preview.count} available tools:`);
  preview.available.forEach(tool => {
    console.log(`  - ${tool.name}: ${tool.description || 'No description'}`);
  });

  // Example 2: Create all tools automatically
  console.log('\n=== Example 2: Create All Tools ===');
  
  const allToolsResult = await factory.createAllTools();
  console.log(`Created ${allToolsResult.count} tools:`);
  allToolsResult.toolInfo.forEach(info => {
    console.log(`  - ${info.promptTrailName} (from ${info.mcpName})`);
  });

  // Example 3: Use tools in an Agent workflow
  console.log('\n=== Example 3: Using Dynamic Tools in Agent ===');
  
  const calculatorAgent = Agent.create()
    .system('You are a helpful assistant with access to calculation tools')
    .user('I need to calculate 156 * 89. Can you help?')
    .assistant({
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'test-key',
        modelName: 'gpt-4'
      },
      tools: allToolsResult.tools,
      toolChoice: 'auto'
    })
    .user('What about 25 + 37?')
    .assistant({
      provider: {
        type: 'openai', 
        apiKey: process.env.OPENAI_API_KEY || 'test-key',
        modelName: 'gpt-4'
      },
      tools: allToolsResult.tools,
    });

  // For demo purposes, let's manually call the tool to show it works
  console.log('Testing calculate tool directly:');
  const directResult = await allToolsResult.tools.calculate.execute({
    operation: 'multiply',
    a: 156,
    b: 89
  });
  console.log(`156 × 89 = ${directResult}`);

  // Example 4: Create tools with specific naming and filtering
  console.log('\n=== Example 4: Filtered and Prefixed Tools ===');
  
  const filteredTools = await MCPTools.createAll(mcpClient, {
    namePrefix: 'mcp_',
    filter: (tool) => tool.name.includes('calc') || tool.name.includes('user'),
    extractTextOnly: true
  });

  console.log('Created filtered tools with prefix:');
  Object.keys(filteredTools).forEach(name => {
    console.log(`  - ${name}`);
  });

  // Example 5: Custom tool configurations
  console.log('\n=== Example 5: Custom Tool Configurations ===');
  
  const customTools = await MCPTools.createAll(mcpClient, {
    namePrefix: 'custom_',
    resultTransform: (result) => {
      // Transform MCP results to have a consistent format
      if (result?.content?.[0]?.text) {
        return {
          success: true,
          data: result.content[0].text,
          timestamp: new Date().toISOString()
        };
      }
      return { success: false, error: 'No content returned' };
    }
  });

  console.log('Testing custom tool transformation:');
  const customResult = await customTools.custom_calculate.execute({
    operation: 'add',
    a: 15,
    b: 25
  });
  console.log('Custom result:', JSON.stringify(customResult, null, 2));

  // Example 6: Tool Registry management
  console.log('\n=== Example 6: Tool Registry Management ===');
  
  // Register tools in the global registry
  globalMCPToolRegistry.register('main-client', mcpClient, allToolsResult);
  
  const stats = globalMCPToolRegistry.getStats();
  console.log(`Registry stats: ${stats.totalClients} clients, ${stats.totalTools} tools`);
  
  // Find tools by pattern
  const calcTools = globalMCPToolRegistry.findTools(/calc/);
  console.log(`Found ${calcTools.length} calculation-related tools`);

  // Example 7: Pattern-based tool creation
  console.log('\n=== Example 7: Pattern-Based Tool Creation ===');
  
  const mathTools = await MCPTools.matching(mcpClient, /calculate|math/);
  const userTools = await MCPTools.matching(mcpClient, /user|fetch/);
  
  console.log(`Created ${Object.keys(mathTools).length} math tools`);
  console.log(`Created ${Object.keys(userTools).length} user tools`);

  // Example 8: Advanced workflow with dynamic tools
  console.log('\n=== Example 8: Advanced Workflow ===');
  
  const workflowAgent = Agent.create()
    .system('You are a data analyst with access to various tools')
    // Step 1: Get user data
    .user('Analyze user data for user ID 1')
    .assistant({
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'test-key',
        modelName: 'gpt-4'
      },
      tools: allToolsResult.tools,
    })
    // Step 2: Perform calculations on the data
    .conditional(
      (session) => {
        const lastMessage = session.getLastMessage();
        return lastMessage?.toolCalls?.some(call => call.name === 'fetch-user') || false;
      },
      // If user data was fetched, perform analysis
      (a) => a
        .user('Now calculate some metrics on this data')
        .assistant({
          provider: {
            type: 'openai',
            apiKey: process.env.OPENAI_API_KEY || 'test-key',
            modelName: 'gpt-4'
          },
          tools: allToolsResult.tools,
        }),
      // Otherwise, provide general guidance
      (a) => a.assistant('I need more specific data to perform calculations.')
    );

  // Example 9: Error handling and fallbacks
  console.log('\n=== Example 9: Error Handling ===');
  
  try {
    // Try to call a tool with invalid parameters
    await allToolsResult.tools['fetch-user'].execute({
      userId: 'invalid-user-123'
    });
  } catch (error) {
    console.log('Expected error caught:', error.message);
  }

  // Try division by zero
  const divisionResult = await allToolsResult.tools.calculate.execute({
    operation: 'divide',
    a: 10,
    b: 0
  });
  console.log('Division by zero result:', divisionResult);

  // Example 10: Named tool creation
  console.log('\n=== Example 10: Named Tool Creation ===');
  
  const specificTools = await MCPTools.named(mcpClient, ['calculate', 'fetch-user'], {
    namePrefix: 'api_'
  });

  console.log('Created specific named tools:');
  Object.keys(specificTools).forEach(name => {
    console.log(`  - ${name}`);
  });

  // Example 11: Custom handlers for specific tools
  console.log('\n=== Example 11: Custom Tool Handlers ===');
  
  const toolsWithCustomHandlers = await MCPTools.createAll(mcpClient, {
    customHandlers: {
      calculate: async (params: any, client) => {
        // Custom calculation logic with validation
        const { operation, a, b } = params;
        
        if (typeof a !== 'number' || typeof b !== 'number') {
          throw new Error('Invalid parameters: a and b must be numbers');
        }
        
        let result: number;
        switch (operation) {
          case 'add': result = a + b; break;
          case 'subtract': result = a - b; break;
          case 'multiply': result = a * b; break;
          case 'divide': 
            if (b === 0) throw new Error('Cannot divide by zero');
            result = a / b; 
            break;
          default: 
            throw new Error(`Unknown operation: ${operation}`);
        }
        
        return {
          operation,
          operands: [a, b],
          result,
          timestamp: new Date().toISOString(),
          customHandler: true
        };
      }
    }
  });

  console.log('Testing custom handler:');
  const customHandlerResult = await toolsWithCustomHandlers.calculate.execute({
    operation: 'multiply',
    a: 7,
    b: 8
  });
  console.log('Custom handler result:', JSON.stringify(customHandlerResult, null, 2));

  // Example 12: Tool lifecycle management
  console.log('\n=== Example 12: Tool Lifecycle Management ===');
  
  // Register multiple clients
  const client2Tools = await MCPTools.withInfo(mcpClient);
  globalMCPToolRegistry.register('client-2', mcpClient, client2Tools);
  
  console.log('Total registered clients:', globalMCPToolRegistry.getClients().length);
  
  // Get tools for specific client
  const client1Tools = globalMCPToolRegistry.getToolsForClient('main-client');
  console.log(`Client 1 has ${Object.keys(client1Tools).length} tools`);
  
  // Clean up
  globalMCPToolRegistry.unregisterClient('client-2');
  console.log('After cleanup, clients:', globalMCPToolRegistry.getClients().length);

  // Disconnect from MCP server
  await mcpClient.disconnect();
  console.log('\n✅ Demo completed! Disconnected from MCP server.');
}

// Helper function to demonstrate tool introspection
async function demonstrateToolIntrospection(mcpClient: any) {
  console.log('\n=== Tool Introspection ===');
  
  const factory = new MCPToolFactory(mcpClient);
  
  // Get detailed information about a specific tool
  const calcToolInfo = await factory.getToolInfo('calculate');
  if (calcToolInfo) {
    console.log('Calculate tool details:');
    console.log(`  Name: ${calcToolInfo.name}`);
    console.log(`  Description: ${calcToolInfo.description}`);
    console.log(`  Input Schema:`, JSON.stringify(calcToolInfo.inputSchema, null, 2));
  }
  
  // Preview tools with filtering
  const mathToolsPreview = await factory.previewTools(
    (tool) => tool.name.includes('calc') || tool.description?.includes('math')
  );
  
  console.log(`Found ${mathToolsPreview.count} math-related tools`);
}

// Run the demo
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}