/**
 * Real MCP integration test
 *
 * This test connects to a mock MCP server and tests the integration
 * with a mock Anthropic model.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { MCPServerConfig } from '../../model/anthropic/mcp';
import { createSession } from '../../session';
import { MCPTestServer } from '../fixtures/mcp_server/test_server';
import { MockMCPClientWrapper } from '../fixtures/mcp_client/mock_mcp_client';
import { MockAnthropicModel } from '../fixtures/mcp_model/mock_anthropic_model';

describe('Real MCP Integration', () => {
  let mcpServer: MCPTestServer;
  let mcpClient: MockMCPClientWrapper;
  let model: MockAnthropicModel;
  let serverConfig: MCPServerConfig;

  // Start the MCP server before all tests
  beforeAll(async () => {
    // Use a random port to avoid conflicts
    const port = 8090 + Math.floor(Math.random() * 100);

    // Create and start the MCP server
    mcpServer = new MCPTestServer(port);
    await mcpServer.start();

    // Create server config
    serverConfig = {
      url: mcpServer.getUrl(),
      name: 'test-server',
      version: '1.0.0',
    };

    // Create MCP client
    mcpClient = new MockMCPClientWrapper(serverConfig);

    // Create Anthropic model with MCP
    model = new MockAnthropicModel({
      apiKey: 'test-api-key',
      modelName: 'claude-3-5-haiku-latest',
      temperature: 0.7,
      mcpServers: [serverConfig],
    });
  }, 10000); // Increase timeout for server startup

  // Stop the MCP server after all tests
  afterAll(async () => {
    if (mcpServer) {
      await mcpServer.stop();
    }

    if (mcpClient) {
      await mcpClient.disconnect();
    }
  });

  it('should connect to the MCP server', async () => {
    await mcpClient.connect();
    expect(mcpClient).toBeDefined();
  });

  it('should discover and load tools from the MCP server', async () => {
    const tools = await mcpClient.loadTools();

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('calculator');
    expect(tools[1].name).toBe('weather');
  });

  it('should execute the calculator tool', async () => {
    // Get the calculator tool
    const tools = await mcpClient.loadTools();
    const calculator = tools.find((tool) => tool.name === 'calculator');

    expect(calculator).toBeDefined();
    if (!calculator) return; // TypeScript guard

    // Execute the tool with type assertion to bypass type checking in tests
     
     
     
    const result = await calculator.execute({
      operation: 'add',
      a: 5,
      b: 3,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Check the result
    expect(result).toBeDefined();
    // The result should have a result property
    expect(result).toHaveProperty('result');
  });

  it('should execute the weather tool', async () => {
    // Get the weather tool
    const tools = await mcpClient.loadTools();
    const weather = tools.find((tool) => tool.name === 'weather');

    expect(weather).toBeDefined();
    if (!weather) return; // TypeScript guard

    // Execute the tool with type assertion to bypass type checking in tests
     
     
     
    const result = await weather.execute({
      location: 'San Francisco',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Check the result
    expect(result).toBeDefined();
    // The result should have a result property
    expect(result).toHaveProperty('result');
  });

  it('should read a resource from the MCP server', async () => {
    const resourceContent = await mcpClient.readResource('test://info');

    expect(resourceContent).toBe(
      'This is a test MCP server for integration testing.',
    );
  });

  it('should list resources from the MCP server', async () => {
    const resources = await mcpClient.listResources();

    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe('test://info');
    expect(resources[0].name).toBe('Test Information');
  });

  it('should handle tool calls in the Anthropic model response', async () => {
    // Create a session
    const session = createSession();

    // Add a spy to console.log to check if tool execution is logged
    const consoleSpy = vi.spyOn(console, 'log');

    // Send a message
    const response = await model.send(session);

    // Check the response
    expect(response.type).toBe('assistant');
    expect(response.content).toBe('I can help with that!');

    // Check if tool calls are in metadata
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = response.metadata?.toJSON() as any;
    expect(metadata?.toolCalls).toBeDefined();
    if (metadata?.toolCalls) {
      expect(metadata.toolCalls[0].name).toBe('calculator');
      expect(metadata.toolCalls[0].arguments).toEqual({
        operation: 'add',
        a: 5,
        b: 3,
      });
    }

    // Check if tool execution was logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Tool calculator executed with result:'),
      expect.anything(),
    );
  });

  it('should handle errors from the MCP server', async () => {
    // Get the calculator tool
    const tools = await mcpClient.loadTools();
    const calculator = tools.find((tool) => tool.name === 'calculator');

    expect(calculator).toBeDefined();
    if (!calculator) return; // TypeScript guard

    // Execute the tool with invalid arguments and type assertion
     
     
     
    const result = await calculator.execute({
      operation: 'divide',
      a: 10,
      b: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Check the result
    expect(result).toBeDefined();
    // The result should have a result property
    expect(result).toHaveProperty('result');
  });
});
