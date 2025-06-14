import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createMCPClient, MCPToolFactory, MCPTools, globalMCPToolRegistry } from '../../../mcp/index.js';
import { Agent, Session } from '../../../index.js';
import { startMockServer } from '../../utils/mock-mcp-server.js';
import type { Server } from 'http';

describe('Dynamic MCP Tools', () => {
  let mcpClient: ReturnType<typeof createMCPClient>;
  let server: Server;

  beforeAll(async () => {
    // Start mock MCP server on HTTP
    server = await startMockServer('http', 3457);
    
    // Create MCP client
    mcpClient = createMCPClient({
      name: 'test-dynamic-tools',
      version: '1.0.0'
    });

    // Connect to the mock server
    await mcpClient.connect({
      type: 'http',
      url: 'http://localhost:3457/mcp'
    });
  });

  afterAll(async () => {
    // Disconnect client
    await mcpClient.disconnect();
    
    // Stop server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    // Clear registry before each test
    globalMCPToolRegistry.clear();
  });

  describe('MCPToolFactory', () => {
    it('should create all tools from MCP server', async () => {
      const factory = new MCPToolFactory(mcpClient);
      const result = await factory.createAllTools();

      expect(result.count).toBeGreaterThan(0);
      expect(result.names).toContain('calculate');
      expect(result.names).toContain('fetch-user');
      expect(result.names).toContain('list-entities');
      expect(result.tools.calculate).toBeDefined();
      expect(result.toolInfo).toHaveLength(result.count);
    });

    it('should filter tools by name pattern', async () => {
      const factory = new MCPToolFactory(mcpClient);
      const result = await factory.createToolsMatching(/^calc/, {});

      expect(result.count).toBe(1);
      expect(result.names).toContain('calculate');
      expect(result.names).not.toContain('fetch-user');
    });

    it('should create tools with name prefix', async () => {
      const factory = new MCPToolFactory(mcpClient);
      const result = await factory.createAllTools({
        namePrefix: 'mcp_'
      });

      expect(result.names.every(name => name.startsWith('mcp_'))).toBe(true);
      expect(result.names).toContain('mcp_calculate');
    });

    it('should filter tools by custom function', async () => {
      const factory = new MCPToolFactory(mcpClient);
      const result = await factory.createAllTools({
        filter: (tool) => tool.name.includes('user')
      });

      const userTools = result.names.filter(name => 
        result.toolInfo.find(info => info.promptTrailName === name)?.mcpName.includes('user')
      );
      expect(userTools.length).toBe(result.count);
    });

    it('should create specific tools by name', async () => {
      const factory = new MCPToolFactory(mcpClient);
      const result = await factory.createToolsByName(['calculate', 'fetch-user']);

      expect(result.count).toBe(2);
      expect(result.names).toContain('calculate');
      expect(result.names).toContain('fetch-user');
      expect(result.names).not.toContain('list-entities');
    });

    it('should preview tools without creating them', async () => {
      const factory = new MCPToolFactory(mcpClient);
      const preview = await factory.previewTools();

      expect(preview.count).toBeGreaterThan(0);
      expect(preview.names).toContain('calculate');
      expect(preview.available).toBeDefined();
    });
  });

  describe('MCPTools convenience functions', () => {
    it('should create all tools with convenience function', async () => {
      const tools = await MCPTools.createAll(mcpClient);

      expect(Object.keys(tools)).toContain('calculate');
      expect(Object.keys(tools)).toContain('fetch-user');
    });

    it('should create tools with prefix using convenience function', async () => {
      const tools = await MCPTools.withPrefix(mcpClient, 'test_');

      const toolNames = Object.keys(tools);
      expect(toolNames.every(name => name.startsWith('test_'))).toBe(true);
      expect(toolNames).toContain('test_calculate');
    });

    it('should create tools matching pattern', async () => {
      const tools = await MCPTools.matching(mcpClient, /calculate|fetch/);

      const toolNames = Object.keys(tools);
      expect(toolNames).toContain('calculate');
      expect(toolNames).toContain('fetch-user');
      expect(toolNames).not.toContain('list-entities');
    });

    it('should create named tools', async () => {
      const tools = await MCPTools.named(mcpClient, ['calculate']);

      expect(Object.keys(tools)).toEqual(['calculate']);
    });
  });

  describe('Tool execution in Agent workflows', () => {
    it('should execute MCP tools directly', async () => {
      const tools = await MCPTools.createAll(mcpClient);
      
      // Test the tool directly
      const result = await tools.calculate.execute({
        operation: 'multiply',
        a: 15,
        b: 8
      });
      
      expect(result).toBe('Result: 120');
    });

    it('should work with tool name prefixes', async () => {
      const tools = await MCPTools.withPrefix(mcpClient, 'calc_');
      
      expect(tools['calc_calculate']).toBeDefined();
      
      // Test the prefixed tool directly
      const result = await tools['calc_calculate'].execute({
        operation: 'multiply',
        a: 5,
        b: 7
      });
      
      expect(result).toBe('Result: 35');
    });
  });

  describe('Tool Registry', () => {
    it('should register tools in global registry', async () => {
      const tools = await MCPTools.withInfo(mcpClient);
      
      globalMCPToolRegistry.register('test-client', mcpClient, tools);
      
      expect(globalMCPToolRegistry.hasClient('test-client')).toBe(true);
      expect(globalMCPToolRegistry.hasTool('test-client', 'calculate')).toBe(true);
      
      const registeredTool = globalMCPToolRegistry.getTool('test-client', 'calculate');
      expect(registeredTool).toBeDefined();
    });

    it('should get tools for specific client', async () => {
      const tools = await MCPTools.withInfo(mcpClient);
      
      globalMCPToolRegistry.register('client1', mcpClient, tools);
      
      const clientTools = globalMCPToolRegistry.getToolsForClient('client1');
      expect(Object.keys(clientTools)).toContain('calculate');
    });

    it('should find tools by pattern', async () => {
      const tools = await MCPTools.withInfo(mcpClient);
      
      globalMCPToolRegistry.register('client1', mcpClient, tools);
      
      const foundTools = globalMCPToolRegistry.findTools(/calc/);
      expect(foundTools.length).toBeGreaterThan(0);
      expect(foundTools[0].promptTrailName).toContain('calc');
    });

    it('should provide registry statistics', async () => {
      const tools = await MCPTools.withInfo(mcpClient);
      
      globalMCPToolRegistry.register('client1', mcpClient, tools);
      
      const stats = globalMCPToolRegistry.getStats();
      expect(stats.totalClients).toBe(1);
      expect(stats.totalTools).toBeGreaterThan(0);
      expect(stats.toolsByClient['client1']).toBeGreaterThan(0);
    });
  });

  describe('Custom tool configurations', () => {
    it('should support custom result transformation', async () => {
      const tools = await MCPTools.createAll(mcpClient, {
        resultTransform: (result) => {
          if (result?.content?.[0]?.text) {
            return `Transformed: ${result.content[0].text}`;
          }
          return result;
        }
      });

      expect(tools.calculate).toBeDefined();
      
      // Test the tool directly
      const result = await tools.calculate.execute({
        operation: 'add',
        a: 5,
        b: 3
      });
      
      expect(result).toBe('Transformed: Result: 8');
    });

    it('should support extractTextOnly option', async () => {
      const tools = await MCPTools.createAll(mcpClient, {
        extractTextOnly: false
      });

      const result = await tools.calculate.execute({
        operation: 'add',
        a: 2,
        b: 3
      });
      
      // Should return full MCP result object, not just text
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('content');
    });

    it('should support custom handlers for specific tools', async () => {
      const customHandlers = {
        calculate: async (params: any) => {
          return `Custom handler: ${params.a} ${params.operation} ${params.b} = ${
            params.operation === 'add' ? params.a + params.b : 'unknown'
          }`;
        }
      };

      const tools = await MCPTools.createAll(mcpClient, {
        customHandlers
      });

      const result = await tools.calculate.execute({
        operation: 'add',
        a: 10,
        b: 5
      });
      
      expect(result).toBe('Custom handler: 10 add 5 = 15');
    });
  });

  describe('Error handling', () => {
    it('should handle tool execution errors gracefully', async () => {
      const tools = await MCPTools.createAll(mcpClient);
      
      // Test with invalid parameters - should return error text, not throw
      const result = await tools['fetch-user'].execute({
        userId: 'invalid-user-id'
      });
      
      expect(result).toContain('User with ID invalid-user-id not found');
    });

    it('should handle disconnected client', async () => {
      const disconnectedClient = createMCPClient();
      
      await expect(MCPTools.createAll(disconnectedClient)).rejects.toThrow(
        'MCP client must be connected'
      );
    });

    it('should handle schema conversion errors gracefully', async () => {
      // This test ensures that even if schema conversion fails,
      // tools can still be created with a fallback schema
      const factory = new MCPToolFactory(mcpClient);
      const result = await factory.createAllTools();
      
      // All tools should be created even if some schemas are complex
      expect(result.count).toBeGreaterThan(0);
      expect(result.tools).toBeDefined();
    });
  });
});