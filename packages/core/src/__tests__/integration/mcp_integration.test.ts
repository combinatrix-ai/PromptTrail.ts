import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicModel } from '../../model/anthropic/model';
import { MCPClientWrapper } from '../../model/anthropic/mcp';
import type { MCPServerConfig } from '../../model/anthropic/mcp';
import { createSession } from '../../session';
import { createTool } from '../../tool';

// Mock the require function for MCP SDK
vi.mock('../../model/anthropic/mcp', async () => {
  const actual = await vi.importActual('../../model/anthropic/mcp');

  // Create a mock MCPClientWrapper that doesn't actually use the SDK
  const mockMCPClientWrapper = vi.fn().mockImplementation(() => {
    // We don't use any config parameter in this mock implementation
    // This mock returns a predefined set of methods and responses
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      loadTools: vi.fn().mockResolvedValue([
        {
          name: 'weather',
          description: 'Get weather information',
          schema: {
            properties: {
              location: {
                type: 'string',
                description: 'Location to get weather for',
              },
            },
            required: ['location'],
          },
          execute: vi.fn().mockResolvedValue({ result: 'Sunny, 75°F' }),
        },
      ]),
      getTool: vi.fn(),
      getAllTools: vi.fn().mockReturnValue([]),
      readResource: vi.fn(),
      listResources: vi.fn(),
      getPrompt: vi.fn(),
    };
  });

  return {
    ...actual,
    MCPClientWrapper: mockMCPClientWrapper,
  };
});

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: 'I can help with that!' },
            {
              type: 'tool_use',
              name: 'weather',
              input: { location: 'San Francisco' },
              id: 'tool-1',
            },
          ],
        }),
      },
    })),
  };
});

describe('MCP Integration', () => {
  let mcpClient: MCPClientWrapper;
  let model: AnthropicModel;

  beforeEach(() => {
    // Create MCP client
    const serverConfig: MCPServerConfig = {
      url: 'http://localhost:8080',
      name: 'test-server',
      version: '1.0.0',
    };
    mcpClient = new MCPClientWrapper(serverConfig);

    // Create Anthropic model with MCP
    model = new AnthropicModel({
      apiKey: 'test-api-key',
      modelName: 'claude-3-5-haiku-latest',
      temperature: 0.7,
      mcpServers: [serverConfig],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should load MCP tools', async () => {
    const tools = await mcpClient.loadTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('weather');
  });

  it('should format MCP tools for Anthropic', () => {
    const tool = createTool({
      name: 'test-tool',
      description: 'Test tool',
      schema: {
        properties: {
          param: { type: 'string', description: 'Test parameter' },
        },
        required: ['param'],
      },
      execute: async () => 'result',
    });

    // Access private method using type assertion
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formattedTool = (model as any).formatTool(tool);

    expect(formattedTool).toEqual({
      name: 'test-tool',
      description: 'Test tool',
      input_schema: {
        type: 'object',
        properties: {
          param: { type: 'string', description: 'Test parameter' },
        },
        required: ['param'],
      },
    });
  });

  it('should handle tool calls in the response', async () => {
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
      expect(metadata.toolCalls[0].name).toBe('weather');
      expect(metadata.toolCalls[0].arguments).toEqual({
        location: 'San Francisco',
      });
    }

    // Check if tool execution was logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Tool weather executed with result:'),
      expect.anything(),
    );
  });
});
