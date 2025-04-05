
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createGenerateOptions,
} from '../../index';

vi.mock('ai', () => {
  return {
    generateText: vi.fn(),
    streamText: vi.fn(),
    experimental_createMCPClient: vi.fn().mockImplementation(() => {
      return Promise.resolve({
        getTools: vi.fn().mockResolvedValue([
          {
            name: 'test_tool',
            description: 'A test tool for MCP integration',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The query to search for',
                },
              },
              required: ['query'],
            },
          },
        ]),
      });
    }),
    tool: vi.fn(),
  };
});

describe('MCP Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should add multiple MCP servers using the fluent API', () => {
    const options = createGenerateOptions({
      provider: {
        type: 'anthropic',
        apiKey: 'test-api-key',
        modelName: 'claude-3-5-haiku-latest',
      },
    })
      .addMCPServer({
        url: 'http://localhost:8080',
        name: 'research-mcp-server',
        version: '1.0.0',
      })
      .addMCPServer({
        url: 'http://localhost:8081',
        name: 'github-mcp-server',
        version: '1.0.0',
      });

    expect(options.mcpServers).toHaveLength(2);
    expect(options.mcpServers?.[0].name).toBe('research-mcp-server');
    expect(options.mcpServers?.[1].name).toBe('github-mcp-server');
  });

  it('should properly configure MCP server options', () => {
    const options = createGenerateOptions({
      provider: {
        type: 'anthropic',
        apiKey: 'test-api-key',
        modelName: 'claude-3-5-haiku-latest',
      },
      temperature: 0.7,
    }).addMCPServer({
      url: 'http://localhost:8080',
      name: 'research-mcp-server',
      version: '1.0.0',
      headers: { 'Authorization': 'Bearer test-token' },
    });

    expect(options.mcpServers).toHaveLength(1);
    expect(options.mcpServers?.[0]).toEqual({
      url: 'http://localhost:8080',
      name: 'research-mcp-server',
      version: '1.0.0',
      headers: { 'Authorization': 'Bearer test-token' },
    });
  });
});
