/**
 * MCP Integration Tests
 * 
 * Tests for the Model Context Protocol (MCP) integration with ai-sdk
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSession,
  createGenerateOptions,
  generateText,
  type ISession,
} from '../../index';

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai');
  return {
    ...actual,
    experimental_createMCPClient: vi.fn().mockImplementation(async () => {
      return {
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
      };
    }),
  };
});

describe('MCP Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should initialize MCP client with the correct configuration', async () => {
    const session = createSession()
      .addMessage({ type: 'system', content: 'You are a helpful assistant with MCP tool access.' })
      .addMessage({ type: 'user', content: 'Can you search for the latest AI papers?' });

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
    });

    const mockResponse = {
      type: 'assistant',
      content: 'I found several recent AI papers on transformer architectures.',
    };

    const experimental_createMCPClient = vi.spyOn(await import('ai'), 'experimental_createMCPClient');

    vi.spyOn(global, 'fetch').mockImplementation(() => 
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ content: mockResponse.content }),
      } as Response)
    );

    await generateText(session, options);

    expect(experimental_createMCPClient).toHaveBeenCalledWith({
      transport: {
        url: 'http://localhost:8080',
        name: 'research-mcp-server',
        version: '1.0.0',
        headers: {},
      },
    });
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
});
