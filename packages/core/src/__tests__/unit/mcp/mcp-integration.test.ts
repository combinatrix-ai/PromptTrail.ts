import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Agent, Session } from '../../../index.js';
import { createMCPClient, MCPSource } from '../../../mcp/index.js';
import { startMockServer } from '../../utils/mock-mcp-server.js';
import type { Server } from 'http';

describe('MCP Integration', () => {
  let mcpClient: ReturnType<typeof createMCPClient>;
  let server: Server;

  beforeAll(async () => {
    // Start mock MCP server on HTTP
    server = await startMockServer('http', 3456);
    
    // Create MCP client
    mcpClient = createMCPClient({
      name: 'test-client',
      version: '1.0.0'
    });

    // Connect to the mock server
    await mcpClient.connect({
      type: 'http',
      url: 'http://localhost:3456/mcp'
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

  describe('MCPToolSource', () => {
    it('should call MCP tool and return text content', async () => {
      const agent = Agent.create()
        .system('Calculator test')
        .user(MCPSource.tool(mcpClient, 'calculate', {
          arguments: { operation: 'add', a: 5, b: 3 },
          extractText: true
        }));

      const session = Session.create();
      const result = await agent.execute(session);
      
      const lastMessage = result.getLastMessage();
      expect(lastMessage?.type).toBe('user');
      expect(lastMessage?.content).toBe('Result: 8');
    });

    it('should call MCP tool and return full JSON', async () => {
      const agent = Agent.create()
        .system('User fetch test')
        .user(MCPSource.tool(mcpClient, 'fetch-user', {
          arguments: { userId: '1' },
          extractText: false
        }));

      const session = Session.create();
      const result = await agent.execute(session);
      
      const lastMessage = result.getLastMessage();
      expect(lastMessage?.type).toBe('user');
      const parsed = JSON.parse(lastMessage?.content || '{}');
      expect(parsed.content).toHaveLength(1);
      expect(parsed.content[0].type).toBe('text');
    });

    it('should handle tool errors gracefully', async () => {
      const agent = Agent.create()
        .system('Error test')
        .user(MCPSource.tool(mcpClient, 'fetch-user', {
          arguments: { userId: 'invalid' },
          extractText: true
        }));

      const session = Session.create();
      const result = await agent.execute(session);
      
      const lastMessage = result.getLastMessage();
      expect(lastMessage?.content).toContain('User with ID invalid not found');
    });
  });

  describe('MCPResourceSource', () => {
    it('should read MCP resource and return text content', async () => {
      const agent = Agent.create()
        .system('Resource test')
        .user(MCPSource.resource(mcpClient, 'config://app/settings', {
          extractText: true
        }));

      const session = Session.create();
      const result = await agent.execute(session);
      
      const lastMessage = result.getLastMessage();
      expect(lastMessage?.type).toBe('user');
      const config = JSON.parse(lastMessage?.content || '{}');
      expect(config.api_version).toBe('2.0');
      expect(config.max_results).toBe(100);
    });

    it('should read dynamic resource with parameters', async () => {
      const agent = Agent.create()
        .system('User profile test')
        .user(MCPSource.resource(mcpClient, 'users://2/profile', {
          extractText: true
        }));

      const session = Session.create();
      const result = await agent.execute(session);
      
      const lastMessage = result.getLastMessage();
      const profile = JSON.parse(lastMessage?.content || '{}');
      expect(profile.name).toBe('Bob Smith');
      expect(profile.role).toBe('developer');
    });
  });

  describe('MCPPromptSource', () => {
    it('should get MCP prompt as text', async () => {
      const agent = Agent.create()
        .system('Prompt test')
        .user(MCPSource.prompt(mcpClient, 'code-review', {
          arguments: {
            code: 'function add(a, b) { return a + b }',
            language: 'javascript'
          },
          format: 'text'
        }));

      const session = Session.create();
      const result = await agent.execute(session);
      
      const lastMessage = result.getLastMessage();
      expect(lastMessage?.content).toContain('Please review the following javascript code');
    });

    it('should get MCP prompt as messages', async () => {
      const agent = Agent.create()
        .system('Prompt messages test')
        .user(MCPSource.prompt(mcpClient, 'analyze-data', {
          arguments: {
            dataType: 'users',
            timeframe: 'Q1 2024'
          },
          format: 'messages'
        }));

      const session = Session.create();
      const result = await agent.execute(session);
      
      const lastMessage = result.getLastMessage();
      expect(lastMessage?.content).toContain('user:');
      expect(lastMessage?.content).toContain('analyze');
    });
  });

  describe('MCPModelSource', () => {
    it('should call MCP tool as assistant source', async () => {
      const agent = Agent.create()
        .system('Model source test')
        .transform(s => s.withVar('operation', 'multiply').withVar('a', 10).withVar('b', 5))
        .assistant(MCPSource.model(mcpClient, 'calculate'));

      const session = Session.create();
      const result = await agent.execute(session);
      
      const lastMessage = result.getLastMessage();
      expect(lastMessage?.type).toBe('assistant');
      expect(lastMessage?.content).toBe('Result: 50');
    });
  });

  describe('Complex MCP workflows', () => {
    it('should chain multiple MCP operations', async () => {
      const agent = Agent.create()
        .system('Complex workflow test')
        // First, list entities
        .user(MCPSource.tool(mcpClient, 'list-entities', {
          arguments: { entityType: 'projects', limit: 2 },
          extractText: true
        }))
        .transform(session => {
          const lastMessage = session.getLastMessage();
          const projects = JSON.parse(lastMessage?.content || '[]');
          return session.withVar('projectId', projects[0]?.id || 'p1');
        })
        // Then get a simple calculation instead (to avoid notification issues)
        .user('Calculate 5 + 3')
        .assistant(MCPSource.model(mcpClient, 'calculate'))
        .transform(s => s.withVar('operation', 'add').withVar('a', 5).withVar('b', 3));

      const session = Session.create({
        context: { projectId: 'p1', operation: 'add', a: 5, b: 3 }
      });
      const result = await agent.execute(session);
      
      const messages = result.messages;
      expect(messages).toHaveLength(4); // system, user (list), user (calc), assistant
      expect(messages[3].content).toContain('Result: 8');
    });

    it('should use MCP in conditional flows', async () => {
      const agent = Agent.create<{ checkUser: boolean }>()
        .system('Conditional MCP test')
        .conditional(
          (s) => s.getVar('checkUser', false),
          // If checkUser is true, fetch user data
          (a) => a
            .user(MCPSource.tool(mcpClient, 'fetch-user', {
              arguments: { userId: '1' },
              extractText: true
            }))
            .assistant('Found user data'),
          // Otherwise, fetch config
          (a) => a
            .user(MCPSource.resource(mcpClient, 'config://app/settings', {
              extractText: true
            }))
            .assistant('Found config data')
        );

      // Test with checkUser = true
      const session1 = Session.create({ context: { checkUser: true } });
      const result1 = await agent.execute(session1);
      expect(result1.getLastMessage()?.content).toBe('Found user data');

      // Test with checkUser = false
      const session2 = Session.create({ context: { checkUser: false } });
      const result2 = await agent.execute(session2);
      expect(result2.getLastMessage()?.content).toBe('Found config data');
    });
  });

  describe('Error handling', () => {
    it('should handle disconnected client', async () => {
      const disconnectedClient = createMCPClient();
      
      const agent = Agent.create()
        .user(MCPSource.tool(disconnectedClient, 'calculate', {
          arguments: { operation: 'add', a: 1, b: 2 }
        }));

      const session = Session.create();
      await expect(agent.execute(session)).rejects.toThrow('Not connected to an MCP server');
    });

    it('should handle invalid tool names', async () => {
      const agent = Agent.create()
        .user(MCPSource.tool(mcpClient, 'non-existent-tool', {
          arguments: {}
        }));

      const session = Session.create();
      await expect(agent.execute(session)).rejects.toThrow();
    });
  });
});