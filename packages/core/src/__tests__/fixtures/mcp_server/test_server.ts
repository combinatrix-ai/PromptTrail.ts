/**
 * Mock MCP test server for integration testing
 *
 * This is a simplified mock implementation that doesn't rely on the actual MCP SDK.
 * It provides a similar interface but uses HTTP directly.
 */
import * as http from 'http';

// Type guards for tool arguments
const isCalculatorArgs = (
  args: unknown,
): args is { operation: string; a: number; b: number } =>
  typeof args === 'object' &&
  args !== null &&
  args !== undefined &&
  'operation' in args &&
  'a' in args &&
  'b' in args &&
  typeof (args as Record<string, unknown>).operation === 'string' &&
  typeof (args as Record<string, unknown>).a === 'number' &&
  typeof (args as Record<string, unknown>).b === 'number';

const isWeatherArgs = (args: unknown): args is { location: string } =>
  typeof args === 'object' &&
  args !== null &&
  args !== undefined &&
  'location' in args &&
  typeof (args as Record<string, unknown>).location === 'string';

/**
 * Mock MCP Test Server class
 */
export class MCPTestServer {
  private server: http.Server;
  private port: number;
  private running: boolean = false;

  constructor(port = 8080) {
    this.port = port;
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  /**
   * Handle HTTP requests
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only handle POST requests
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Parse request body
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const requestData = JSON.parse(body);
        const method = requestData.method;

        // Handle different MCP methods
        switch (method) {
          case 'listTools':
            this.handleListTools(res);
            break;
          case 'callTool':
            this.handleCallTool(requestData.params, res);
            break;
          case 'listResources':
            this.handleListResources(res);
            break;
          case 'readResource':
            this.handleReadResource(requestData.params, res);
            break;
          default:
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unknown method: ${method}` }));
        }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars
      } catch (_error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
  }

  /**
   * Handle listTools method
   */
  private handleListTools(res: http.ServerResponse): void {
    const tools = [
      {
        name: 'calculator',
        description: 'Perform basic arithmetic operations',
        inputSchema: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              description:
                'Operation to perform (add, subtract, multiply, divide)',
              enum: ['add', 'subtract', 'multiply', 'divide'],
            },
            a: {
              type: 'number',
              description: 'First operand',
            },
            b: {
              type: 'number',
              description: 'Second operand',
            },
          },
          required: ['operation', 'a', 'b'],
        },
      },
      {
        name: 'weather',
        description: 'Get weather information for a location',
        inputSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'Location to get weather for',
            },
          },
          required: ['location'],
        },
      },
    ];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools }));
  }

  /**
   * Handle callTool method
   */
  private handleCallTool(params: { name: string; arguments: Record<string, unknown> }, res: http.ServerResponse): void {
    const { name, arguments: args } = params;

    switch (name) {
      case 'calculator': {
        if (!isCalculatorArgs(args)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              isError: true,
              content: [{ type: 'text', text: 'Invalid calculator arguments' }],
            }),
          );
          return;
        }

        const { operation, a, b } = args;
        let result: number;

        switch (operation) {
          case 'add':
            result = a + b;
            break;
          case 'subtract':
            result = a - b;
            break;
          case 'multiply':
            result = a * b;
            break;
          case 'divide':
            if (b === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  isError: true,
                  content: [{ type: 'text', text: 'Division by zero' }],
                }),
              );
              return;
            }
            result = a / b;
            break;
          default:
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                isError: true,
                content: [
                  { type: 'text', text: `Unknown operation: ${operation}` },
                ],
              }),
            );
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            content: [{ type: 'text', text: JSON.stringify({ result }) }],
          }),
        );
        break;
      }

      case 'weather': {
        if (!isWeatherArgs(args)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              isError: true,
              content: [{ type: 'text', text: 'Invalid weather arguments' }],
            }),
          );
          return;
        }

        const { location } = args;

        // Mock weather data
        const weatherData = {
          location,
          temperature: 72,
          conditions: 'Sunny',
          humidity: 45,
          wind_speed: 5,
          timestamp: new Date().toISOString(),
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            content: [{ type: 'text', text: JSON.stringify(weatherData) }],
          }),
        );
        break;
      }

      default:
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          }),
        );
    }
  }

  /**
   * Handle listResources method
   */
  private handleListResources(res: http.ServerResponse): void {
    const resources = [
      {
        uri: 'test://info',
        name: 'Test Information',
        description: 'Basic information about the test server',
        mimeType: 'text/plain',
      },
    ];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ resources }));
  }

  /**
   * Handle readResource method
   */
  private handleReadResource(params: { uri: string }, res: http.ServerResponse): void {
    const { uri } = params;

    if (uri === 'test://info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: 'This is a test MCP server for integration testing.',
            },
          ],
        }),
      );
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `Unknown resource: ${uri}`,
        }),
      );
    }
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    if (this.running) return;

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        this.running = true;
        console.log(`MCP test server running on http://localhost:${this.port}`);
        resolve();
      });

      this.server.on('error', (error) => {
        console.error('Failed to start MCP test server:', error);
        reject(error);
      });
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          console.error('Error stopping MCP test server:', error);
          reject(error);
        } else {
          this.running = false;
          console.log('MCP test server stopped');
          resolve();
        }
      });
    });
  }

  /**
   * Get the server URL
   */
  getUrl(): string {
    return `http://localhost:${this.port}`;
  }
}
