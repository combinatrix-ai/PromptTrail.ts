import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Example of using the mock MCP server
export async function testMockServer() {
  console.log('Testing Mock MCP Server...\n');

  // Create a client
  const client = new Client({
    name: 'test-client',
    version: '1.0.0',
  });

  try {
    // For stdio transport (when running server with stdio)
    if (process.argv.includes('--stdio')) {
      const transport = new StdioClientTransport({
        command: 'node',
        args: ['packages/core/src/__tests__/utils/mock-mcp-server.ts'],
      });
      await client.connect(transport);
    } else {
      // For HTTP transport (when running server with --http)
      const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));
      await client.connect(transport);
    }

    console.log('Connected to mock MCP server!\n');

    // Test listing available capabilities
    console.log('=== Server Capabilities ===');
    const serverInfo = await client.getServerInfo();
    console.log('Server:', serverInfo);

    // Test tools
    console.log('\n=== Testing Tools ===');

    // List available tools
    const tools = await client.listTools();
    console.log('Available tools:', tools.tools.map(t => t.name));

    // Test calculator tool
    console.log('\n1. Calculator Tool:');
    const calcResult = await client.callTool({
      name: 'calculate',
      arguments: {
        operation: 'multiply',
        a: 12,
        b: 7,
      },
    });
    console.log('12 × 7 =', calcResult.content[0].text);

    // Test fetch user tool
    console.log('\n2. Fetch User Tool:');
    const userResult = await client.callTool({
      name: 'fetch-user',
      arguments: {
        userId: '1',
      },
    });
    console.log('User data:', userResult.content[0].text);

    // Test list entities tool
    console.log('\n3. List Entities Tool:');
    const listResult = await client.callTool({
      name: 'list-entities',
      arguments: {
        entityType: 'projects',
        limit: 2,
      },
    });
    console.log('Projects:', listResult.content[0].text);

    // Test update project status (with notification)
    console.log('\n4. Update Project Status Tool:');
    const updateResult = await client.callTool({
      name: 'update-project-status',
      arguments: {
        projectId: 'p1',
        newStatus: 'completed',
      },
    });
    console.log('Update result:', updateResult.content[0].text);

    // Test async API simulation
    console.log('\n5. Simulate API Call Tool:');
    console.log('Starting simulated API call...');
    const apiResult = await client.callTool({
      name: 'simulate-api-call',
      arguments: {
        endpoint: '/api/v1/data',
        delay: 500,
      },
    });
    console.log('API result:', apiResult.content[0].text);

    // Test resources
    console.log('\n=== Testing Resources ===');

    // List available resources
    const resources = await client.listResources();
    console.log('Available resources:', resources.resources.map(r => r.uri));

    // Test config resource
    console.log('\n1. Config Resource:');
    const configResource = await client.readResource({
      uri: 'config://app/settings',
    });
    console.log('Config:', configResource.contents[0].text);

    // Test user profile resource
    console.log('\n2. User Profile Resource:');
    const profileResource = await client.readResource({
      uri: 'users://2/profile',
    });
    console.log('Profile:', profileResource.contents[0].text);

    // Test project resource
    console.log('\n3. Project Resource:');
    const projectResource = await client.readResource({
      uri: 'projects://p1',
    });
    console.log('Project:', projectResource.contents[0].text);

    // Test system info resource
    console.log('\n4. System Info Resource:');
    const systemResource = await client.readResource({
      uri: 'system://info',
    });
    console.log('System info:\n', systemResource.contents[0].text);

    // Test prompts
    console.log('\n=== Testing Prompts ===');

    // List available prompts
    const prompts = await client.listPrompts();
    console.log('Available prompts:', prompts.prompts.map(p => p.name));

    // Test code review prompt
    console.log('\n1. Code Review Prompt:');
    const codeReviewPrompt = await client.getPrompt({
      name: 'code-review',
      arguments: {
        code: 'function add(a, b) { return a + b }',
        language: 'javascript',
        focus: ['performance', 'best practices'],
      },
    });
    console.log('Generated prompt:', codeReviewPrompt.messages[0].content);

    // Test data analysis prompt
    console.log('\n2. Data Analysis Prompt:');
    const analysisPrompt = await client.getPrompt({
      name: 'analyze-data',
      arguments: {
        dataType: 'projects',
        timeframe: 'Q4 2024',
      },
    });
    console.log('Generated prompt (truncated):', 
      analysisPrompt.messages[0].content.text.substring(0, 200) + '...');

    // Test task generation prompt
    console.log('\n3. Task Generation Prompt:');
    const tasksPrompt = await client.getPrompt({
      name: 'generate-tasks',
      arguments: {
        projectName: 'E-commerce Platform',
        projectType: 'web',
        teamSize: 8,
      },
    });
    console.log('Generated prompt (truncated):', 
      tasksPrompt.messages[0].content.text.substring(0, 200) + '...');

    console.log('\n=== All tests completed successfully! ===');

  } catch (error) {
    console.error('Error during testing:', error);
  } finally {
    await client.close();
  }
}

// Example of error handling
export async function testErrorHandling() {
  console.log('\n=== Testing Error Handling ===');

  const client = new Client({
    name: 'error-test-client',
    version: '1.0.0',
  });

  try {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));
    await client.connect(transport);

    // Test invalid user ID
    console.log('\n1. Testing invalid user ID:');
    try {
      const result = await client.callTool({
        name: 'fetch-user',
        arguments: {
          userId: 'invalid-id',
        },
      });
      console.log('Result:', result.content[0].text);
    } catch (error) {
      console.log('Error caught:', (error as Error).message);
    }

    // Test division by zero
    console.log('\n2. Testing division by zero:');
    const divResult = await client.callTool({
      name: 'calculate',
      arguments: {
        operation: 'divide',
        a: 10,
        b: 0,
      },
    });
    console.log('Result:', divResult.content[0].text);

    // Test invalid resource URI
    console.log('\n3. Testing invalid resource URI:');
    try {
      await client.readResource({
        uri: 'users://999/profile',
      });
    } catch (error) {
      console.log('Error caught:', (error as Error).message);
    }

  } finally {
    await client.close();
  }
}

// Run the tests
export async function main() {
  // First, make sure the server is running
  console.log('Make sure the mock MCP server is running:');
  console.log('  For stdio: node packages/core/src/__tests__/utils/mock-mcp-server.ts');
  console.log('  For HTTP:  node packages/core/src/__tests__/utils/mock-mcp-server.ts --http');
  console.log('');

  await testMockServer();
  await testErrorHandling();
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}