import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

// Mock data store
interface MockDatabase {
  users: Map<string, { id: string; name: string; email: string; role: string }>;
  projects: Map<string, { id: string; name: string; description: string; status: string }>;
  config: Map<string, any>;
}

const mockDb: MockDatabase = {
  users: new Map([
    ['1', { id: '1', name: 'Alice Johnson', email: 'alice@example.com', role: 'admin' }],
    ['2', { id: '2', name: 'Bob Smith', email: 'bob@example.com', role: 'developer' }],
    ['3', { id: '3', name: 'Charlie Brown', email: 'charlie@example.com', role: 'designer' }],
  ]),
  projects: new Map([
    ['p1', { id: 'p1', name: 'Project Alpha', description: 'Main product development', status: 'active' }],
    ['p2', { id: 'p2', name: 'Project Beta', description: 'Research initiative', status: 'planning' }],
    ['p3', { id: 'p3', name: 'Project Gamma', description: 'Customer portal', status: 'completed' }],
  ]),
  config: new Map([
    ['api_version', '2.0'],
    ['max_results', 100],
    ['features', { darkMode: true, notifications: true, analytics: false }],
  ]),
};

// Create the mock MCP server
export function createMockServer() {
  const server = new McpServer({
    name: 'mock-mcp-server',
    version: '1.0.0',
    description: 'A comprehensive mock MCP server for testing',
  }, {
    capabilities: {
      logging: {}
    }
  });

  // ===== TOOLS =====

  // Calculator tool
  server.tool(
    'calculate',
    'Perform basic arithmetic operations',
    {
      operation: z.enum(['add', 'subtract', 'multiply', 'divide']).describe('The operation to perform'),
      a: z.number().describe('First operand'),
      b: z.number().describe('Second operand'),
    },
    async ({ operation, a, b }) => {
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
            return {
              content: [{ type: 'text', text: 'Error: Division by zero' }],
              isError: true,
            };
          }
          result = a / b;
          break;
      }
      return {
        content: [{ type: 'text', text: `Result: ${result}` }],
      };
    }
  );

  // Data fetch tool
  server.tool(
    'fetch-user',
    'Fetch user information by ID',
    {
      userId: z.string().describe('The user ID to fetch'),
    },
    async ({ userId }) => {
      const user = mockDb.users.get(userId);
      if (!user) {
        return {
          content: [{ type: 'text', text: `User with ID ${userId} not found` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(user, null, 2) }],
      };
    }
  );

  // List tool
  server.tool(
    'list-entities',
    'List entities of a specific type',
    {
      entityType: z.enum(['users', 'projects']).describe('Type of entities to list'),
      limit: z.number().optional().default(10).describe('Maximum number of results'),
    },
    async ({ entityType, limit }) => {
      const collection = entityType === 'users' ? mockDb.users : mockDb.projects;
      const items = Array.from(collection.values()).slice(0, limit);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(items, null, 2),
        }],
      };
    }
  );

  // Data mutation tool
  server.tool(
    'update-project-status',
    'Update the status of a project',
    {
      projectId: z.string().describe('The project ID'),
      newStatus: z.enum(['planning', 'active', 'paused', 'completed']).describe('New status'),
    },
    async ({ projectId, newStatus }, { sendNotification }) => {
      const project = mockDb.projects.get(projectId);
      if (!project) {
        return {
          content: [{ type: 'text', text: `Project ${projectId} not found` }],
          isError: true,
        };
      }

      const oldStatus = project.status;
      project.status = newStatus;

      // Send notification about the update
      await sendNotification({
        method: 'notifications/message',
        params: {
          level: 'info',
          data: `Project ${project.name} status changed from ${oldStatus} to ${newStatus}`,
        },
      });

      return {
        content: [{
          type: 'text',
          text: `Successfully updated project ${project.name} status to ${newStatus}`,
        }],
      };
    }
  );

  // Async tool with delay
  server.tool(
    'simulate-api-call',
    'Simulate an async API call with configurable delay',
    {
      endpoint: z.string().describe('The simulated endpoint'),
      delay: z.number().optional().default(1000).describe('Delay in milliseconds'),
    },
    async ({ endpoint, delay }) => {
      await new Promise(resolve => setTimeout(resolve, delay));
      return {
        content: [{
          type: 'text',
          text: `Simulated API call to ${endpoint} completed after ${delay}ms`,
        }],
      };
    }
  );

  // ===== RESOURCES =====

  // Static configuration resource
  server.resource(
    'config',
    'config://app/settings',
    { mimeType: 'application/json' },
    async () => ({
      contents: [{
        uri: 'config://app/settings',
        text: JSON.stringify(Object.fromEntries(mockDb.config), null, 2),
      }],
    })
  );

  // Dynamic user resource
  server.resource(
    'user-profile',
    new ResourceTemplate('users://{userId}/profile', { list: undefined }),
    { mimeType: 'application/json' },
    async (uri, { userId }) => {
      const user = mockDb.users.get(userId);
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            ...user,
            lastAccess: new Date().toISOString(),
            permissions: user.role === 'admin' ? ['read', 'write', 'delete'] : ['read'],
          }, null, 2),
        }],
      };
    }
  );

  // Project resource with list support
  server.resource(
    'project',
    new ResourceTemplate('projects://{projectId}', {
      list: async () => ({
        resources: Array.from(mockDb.projects.values()).map(p => ({
          uri: `projects://${p.id}`,
          name: p.name,
          description: p.description,
        })),
      }),
    }),
    { mimeType: 'application/json' },
    async (uri, { projectId }) => {
      const project = mockDb.projects.get(projectId);
      if (!project) {
        throw new Error(`Project ${projectId} not found`);
      }
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(project, null, 2),
        }],
      };
    }
  );

  // System info resource
  server.resource(
    'system-info',
    'system://info',
    { mimeType: 'text/plain' },
    async () => ({
      contents: [{
        uri: 'system://info',
        text: `Mock MCP Server v1.0.0
Running on: ${process.platform}
Node version: ${process.version}
Current time: ${new Date().toISOString()}
Connected clients: ${Math.floor(Math.random() * 10) + 1}`,
      }],
    })
  );

  // ===== PROMPTS =====

  // Code review prompt
  server.prompt(
    'code-review',
    'Generate a code review request',
    {
      code: z.string().describe('The code to review'),
      language: z.string().optional().default('javascript').describe('Programming language'),
      focus: z.array(z.string()).optional().describe('Specific areas to focus on'),
    },
    async ({ code, language, focus }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Please review the following ${language} code:

\`\`\`${language}
${code}
\`\`\`

${focus && focus.length > 0 ? `Focus areas: ${focus.join(', ')}` : 'Please provide a comprehensive review.'}

Consider:
1. Code quality and best practices
2. Potential bugs or issues
3. Performance considerations
4. Security concerns
5. Suggestions for improvement`,
        },
      }],
    })
  );

  // Data analysis prompt
  server.prompt(
    'analyze-data',
    'Generate a data analysis request',
    {
      dataType: z.enum(['users', 'projects', 'metrics']).describe('Type of data to analyze'),
      timeframe: z.string().optional().describe('Time period for analysis'),
    },
    async ({ dataType, timeframe }) => {
      let data: any;
      switch (dataType) {
        case 'users':
          data = Array.from(mockDb.users.values());
          break;
        case 'projects':
          data = Array.from(mockDb.projects.values());
          break;
        case 'metrics':
          data = {
            totalUsers: mockDb.users.size,
            totalProjects: mockDb.projects.size,
            activeProjects: Array.from(mockDb.projects.values()).filter(p => p.status === 'active').length,
          };
          break;
      }

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Please analyze the following ${dataType} data${timeframe ? ` for ${timeframe}` : ''}:

${JSON.stringify(data, null, 2)}

Provide insights on:
1. Key patterns and trends
2. Notable outliers or anomalies
3. Summary statistics
4. Actionable recommendations`,
          },
        }],
      };
    }
  );

  // Task generation prompt
  server.prompt(
    'generate-tasks',
    'Generate a task list for a project',
    {
      projectName: z.string().describe('Name of the project'),
      projectType: z.enum(['web', 'mobile', 'api', 'data']).describe('Type of project'),
      teamSize: z.number().optional().default(5).describe('Size of the team'),
    },
    async ({ projectName, projectType, teamSize }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Generate a comprehensive task list for a ${projectType} project called "${projectName}" with a team of ${teamSize} people.

Please include:
1. Project setup and initialization tasks
2. Development milestones
3. Testing and QA tasks
4. Documentation requirements
5. Deployment and release tasks

Format the tasks with priorities (High/Medium/Low) and estimated time.`,
        },
      }],
    })
  );

  return server;
}

// Function to start the server with specified transport
export async function startMockServer(transport: 'stdio' | 'http' = 'stdio', port = 3000): Promise<any> {
  const server = createMockServer();

  if (transport === 'stdio') {
    // Use stdio transport for CLI usage
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error('Mock MCP server running on stdio transport');
    return null; // No HTTP server for stdio
  } else {
    // Use HTTP transport for web usage
    const app = express();
    app.use(express.json());

    const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

    app.post('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            transports[sessionId] = transport;
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };

        const server = createMockServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    });

    app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      await transports[sessionId].handleRequest(req, res);
    });

    app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      await transports[sessionId].handleRequest(req, res);
    });

    return new Promise((resolve) => {
      const httpServer = app.listen(port, () => {
        console.log(`Mock MCP server running on http://localhost:${port}`);
        resolve(httpServer);
      });
    });
  }
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const transport = process.argv.includes('--http') ? 'http' : 'stdio';
  const port = process.argv.includes('--port') ? parseInt(process.argv[process.argv.indexOf('--port') + 1]) : 3000;
  startMockServer(transport, port).catch(console.error);
}