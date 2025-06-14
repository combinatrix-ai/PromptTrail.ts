# 🚀 PromptTrail

Type-safe, composable framework for building LLM conversations in TypeScript.

Built on [Vercel's ai-sdk](https://github.com/vercel/ai), PromptTrail provides a fluent API for creating structured conversations with immutable state management.

## 🔧 Installation

```bash
# Using pnpm (recommended)
pnpm add github:combinatrix-ai/PromptTrail.ts

# Using npm
npm install github:combinatrix-ai/PromptTrail.ts
```

## 🚀 Quick Start

### 30-Second Example

```typescript
import { Agent } from '@prompttrail/core';

const chat = Agent.create()
  .system("You're a helpful assistant.")
  .user("What's TypeScript?")
  .assistant(); // Uses OpenAI GPT-4o-mini by default

const session = await chat.execute();
console.log(session.getLastMessage()?.content);
```

### Interactive Chat Loop

```typescript
import { Agent } from '@prompttrail/core';

const agent = Agent.create()
  .system('You are a helpful assistant.')
  .loop(
    (l) =>
      l
        .user() // CLI input from user
        .assistant(), // LLM response
  );

await agent.execute(); // Runs forever until user exits
```

### Customizing the LLM

```typescript
import { Agent } from '@prompttrail/core';

const agent = Agent.create()
  .system('You are a creative writer.')
  .user('Write a haiku about TypeScript.')
  .assistant({
    provider: 'openai',
    model: 'gpt-4',
    temperature: 0.9,
    apiKey: process.env.OPENAI_API_KEY,
  });

await agent.execute();
```

## ✨ Key Features

- **🔒 TypeScript-First** - Full type safety with inference
- **🧩 Composable** - Mix and match conversation patterns
- **🔄 Immutable** - Predictable state management
- **🔌 Multi-Provider** - OpenAI, Anthropic, Google support
- **🛠️ Tool Integration** - Function calling via ai-sdk
- **🌊 Streaming** - Real-time response streaming
- **🛡️ Validation** - Input/output validation with retries
- **🧪 Structured Output** - Force LLMs to return typed data

## 📘 Core Concepts

### Session & Context

Sessions store conversation state with type-safe context variables:

```typescript
import { Session } from '@prompttrail/core';

// Context variables for interpolation and state
const session = Session.create({
  context: { userName: 'Alice', language: 'TypeScript' },
});

// Use variables in templates with {{variable}} syntax
const agent = Agent.create()
  .system('Help {{userName}} learn {{language}}')
  .user('Explain generics')
  .assistant();

await agent.execute(session);
```

### Template Interpolation

PromptTrail uses **Handlebars** for powerful template interpolation with dynamic content insertion:

#### Basic Variable Interpolation

```typescript
// Simple variables
'Hello {{name}}';
'User: {{user.name}}'; // Nested object access
'Count: {{length items}}'; // Built-in helpers

// Example: receipe bot
const session = Session.create({
  context: {
    dietaryRestrictions: ['vegetarian', 'gluten-free'],
    availableTime: 30,
    ingredients: ['tomatoes', 'pasta', 'cheese', 'herbs'],
  },
});

const agent = Agent.create()
  .system('You are a cooking assistant. Suggest recipes based on constraints.')
  .user(
    'I have {{availableTime}} minutes and these ingredients: {{join ingredients ", "}}. I follow these diets: {{join dietaryRestrictions " and "}}.',
  )
  .assistant()
  .transform((session) => {
    // Extract recipe info from LLM response
    const response = session.getLastMessage()?.content || '';
    const recipeMatch = response.match(/Recipe:\s*([^\n]+)/i);
    const cookingTimeMatch = response.match(/(\d+)\s*minutes?/);

    return session.withContext({
      suggestedRecipe: recipeMatch?.[1] || 'Unknown Recipe',
      estimatedTime: cookingTimeMatch?.[1] ? parseInt(cookingTimeMatch[1]) : 30,
      recipeCount: session.getVar('recipeCount', 0) + 1,
    });
  })
  .user(
    'Great! For {{suggestedRecipe}}, what cooking tips do you have? (This is recipe #{{recipeCount}})',
  )
  .assistant();

const result = await agent.execute(session);
console.log('Suggested recipe:', result.getVar('suggestedRecipe'));
console.log('Estimated time:', result.getVar('estimatedTime'), 'minutes');
```

#### Array Iteration

```typescript
// Loop through arrays in templates
const session = Session.create({
  context: {
    tasks: [
      { title: 'Learn TypeScript', status: 'complete' },
      { title: 'Build app', status: 'pending' },
    ],
  },
});

const agent = Agent.create()
  .system(
    `Current tasks:
{{#each tasks}}
- {{title}}: {{status}}
{{/each}}`,
  )
  .user('Help me with the next task')
  .assistant();
```

#### Conditionals

```typescript
// If/else logic in templates
const agent = Agent.create()
  .system(
    `{{#if user.isPremium}}
You have premium access to advanced features.
{{else}}
You have basic access. Upgrade for more features.
{{/if}}`,
  )
  .user('What can I do?')
  .assistant();
```

#### Built-in Helpers

```typescript
// PromptTrail includes useful helpers:
'Items: {{length items}}'; // Get array length
'List: {{join tags ", "}}'; // Join array with separator
'Text: {{truncate description 100}}'; // Truncate to length
'Number: {{formatNumber price}}'; // Format numbers
'{{#unless isEmpty results}}Found {{length results}} items{{/unless}}';

// List formatting helpers
'{{numberedList items}}'; // 1. Item A\n2. Item B
'{{bulletList items}}'; // • Item A\n• Item B

// Comparison helpers
'{{#if (eq status "complete")}}Done!{{/if}}';
'{{#if (gt score 80)}}Great job!{{/if}}';
```

#### Custom Helpers

```typescript
// Register your own helpers
import { registerHelper } from '@prompttrail/core';

registerHelper('uppercase', (text: string) => text.toUpperCase());
registerHelper('currency', (amount: number) => `$${amount.toFixed(2)}`);

// Use in templates
('Welcome {{uppercase name}}!');
('Total: {{currency total}}');
```

### Content Configuration

PromptTrail supports both a **simple direct API** (recommended) and **powerful Source API** (for advanced users):

```typescript
// 🆕 Direct API (Recommended) - Simple and intuitive
.user('Fixed text')                      // Static content
.user({ cli: 'Enter your message: ' })  // User input from terminal
.user(['A', 'B', 'C'], { loop: true })  // Sequential/looping content
.user(async (session) => '...')         // Custom async logic

.assistant()                             // Default OpenAI GPT-4o-mini
.assistant({ provider: 'anthropic' })    // Anthropic Claude
.assistant('Static response')            // Fixed assistant content

// Parallel execution with simple configs
.parallel(p => p
  .withSource({ provider: 'openai', temperature: 0.1 })
  .withSource({ provider: 'anthropic', temperature: 0.8 })
  .withStrategy('best')
)

// ⚡ Source API (Power Users) - Advanced customization
import { Source } from '@prompttrail/core';

.user(Source.cli('Enter message:'))      // CLI with validation
.user(Source.list(['A', 'B']))          // Sequential content
.user(Source.callback(async () => '...')) // Custom logic

.assistant(Source.llm().openai())       // LLM with middleware
.assistant(Source.llm().anthropic())    // Advanced configuration

// Advanced parallel with Source objects
.parallel(p => p
  .withSource(Source.llm().openai().temperature(0.1).withSchema(schema))
  .withSource(Source.llm().anthropic().temperature(0.8))
)
```

**When to use each approach:**

- **Direct API**: 90% of use cases - simple, intuitive, covers most needs
- **Source API**: Advanced features like middleware, complex validation, custom retry logic

Both APIs can be mixed in the same agent for maximum flexibility!

### Control Flow

PromptTrail offers two ways to build agents with sophisticated control flow:

#### 1. Agent Builder (Template-Level Control)

```typescript
import { Agent } from '@prompttrail/core';

const agent = Agent.create()
  .system('You are helpful.')

  // Conditional logic
  .conditional(
    (session) => session.getVar('isVip'),
    (agent) => agent.assistant('Welcome VIP!'),
    (agent) => agent.assistant('Welcome!'),
  )

  // Loops with conditions
  .loop(
    (agent) => agent.user().assistant(),
    (session) => session.getVar('continue', true),
  )

  // Subroutines with isolation
  .subroutine(
    (agent) =>
      agent
        .user('Process this data')
        .assistant()
        .transform((session) => session.withVar('processed', true)),
    {
      isolatedContext: true, // Fresh context
      retainMessages: false, // Don't keep internal messages
      squashWith: (parent, sub) =>
        parent.withVar('result', sub.getVar('processed')),
    },
  )

  // Simple parallel execution
  .parallel(
    (p) =>
      p
        .withSource({ provider: 'openai' }, 2) // Run OpenAI twice
        .withSource({ provider: 'anthropic' }, 1) // Run Anthropic once
        .withStrategy('best'), // Keep best result
  )

  // Advanced parallel with detailed config
  .parallel((p) =>
    p
      .withSource(
        {
          provider: 'openai',
          model: 'gpt-4',
          temperature: 0.1,
          maxTokens: 1000,
        },
        3,
      )
      .withSource({ provider: 'anthropic', temperature: 0.8 })
      .withAggregationFunction((session) => session.messages.length)
      .withStrategy('best'),
  );
```

#### 2. Scenario API (Goal-Oriented Flow)

```typescript
import { Scenario } from '@prompttrail/core';

const scenario = Scenario.system(
  'You are a research assistant with access to tools.',
)
  .step("Get the user's research question", {
    allow_interaction: true, // Uses built-in ask_user tool
  })
  .step('Research the topic thoroughly', {
    max_attempts: 6,
    is_satisfied: (session, goal) => {
      // Custom validation for goal completion
      const toolCalls = getToolCallsFromSession(session);
      return toolCalls.length >= 3;
    },
  })
  .step('Provide a comprehensive answer');
```

**Key Differences:**

- **Agent**: Low-level template composition, full control
- **Scenario**: High-level goal tracking with built-in tools (`ask_user`, `check_goal`)

## 🛠️ Advanced Features

### Session Typing

PromptTrail provides **gradual typing** - start simple and add types as your app grows:

```typescript
// 1. Start simple - types inferred automatically
const session = Session.create({
  context: { userName: 'Alice', score: 100 },
});

// 2. Convenience method with type inference
const sessionWithContext = Session.withContext({
  userId: 'user123',
  role: 'admin',
  preferences: { theme: 'dark', notifications: true },
});

// 3. Add explicit types when you need them
type UserContext = {
  userId: string;
  role: 'admin' | 'user' | 'guest';
  preferences: {
    theme: 'light' | 'dark';
    notifications: boolean;
  };
};

type MessageMeta = {
  timestamp: number;
  priority: 'low' | 'medium' | 'high';
  source: 'user' | 'system';
};

// 4. Type-only specification (no runtime values)
const typedSession = Session.typed<UserContext, MessageMeta>().create({
  context: {
    userId: 'user123',
    role: 'admin',
    preferences: { theme: 'dark', notifications: true },
  },
});

// 5. Mix and match approaches
const session1 = Session.typed<UserContext>().debug();
const session2 = Session.typed<{}, MessageMeta>().empty();
const session3 = Session.withContext({
  count: 42,
}).withMetadataType<MessageMeta>();

// 6. Type-safe access with full IntelliSense
const userId = typedSession.getVar('userId'); // string
const role = typedSession.getVar('role'); // 'admin' | 'user' | 'guest'
const theme = typedSession.getVar('preferences').theme; // 'light' | 'dark'

// 7. Template with typed interpolation
const typedAgent = Agent.create<UserContext>()
  .system('Welcome {{role}} user {{userId}}')
  .user('My theme is {{preferences.theme}}')
  .assistant();
```

### Tool Integration

```typescript
import { tool } from 'ai';
import { z } from 'zod';

const weatherTool = tool({
  description: 'Get weather info',
  parameters: z.object({
    location: z.string(),
  }),
  execute: async ({ location }) => {
    return { temp: 72, condition: 'sunny' };
  },
});

const agent = Agent.create()
  .system('You can check weather.')
  .user('Weather in SF?')
  .assistant({
    provider: 'openai',
    tools: { weather: weatherTool },
  });
```

### Structured Output & Variable Extraction

```typescript
import { z } from 'zod';

const userSchema = z.object({
  name: z.string(),
  age: z.number(),
  interests: z.array(z.string()),
});

// Basic structured output
const agent = Agent.create()
  .system('Extract user info from text.')
  .user("Hi, I'm Alice, 25, love coding and music.")
  .assistant({
    provider: 'openai',
    schema: userSchema,
  });

const session = await agent.execute();
const userData = session.getLastMessage()?.structuredContent;
// userData is typed as { name: string, age: number, interests: string[] }

// Auto-extract to session variables (Agent convenience method)
const agentWithExtraction = Agent.create()
  .system('Extract user info from text.')
  .user("Hi, I'm Alice, 25, love coding and music.")
  .extract(userSchema) // Auto-map all fields to top-level session vars
  .user(
    'Hi {{name}}, you are {{age}} years old and like {{join interests ", "}}',
  )
  .assistant();

// Custom field mapping (Agent convenience method)
const agentWithMapping = Agent.create()
  .system('Extract recipe details.')
  .user('I want to make pasta with tomatoes in 30 minutes')
  .extract(
    z.object({
      recipeName: z.string(),
      cookingTime: z.number(),
      difficulty: z.enum(['easy', 'medium', 'hard']),
    }),
    {
      recipeName: 'suggestedRecipe',
      cookingTime: 'estimatedTime',
      difficulty: 'recipeComplexity',
    },
    { provider: 'openai' }, // Optional config
  )
  .user(
    'Great! {{suggestedRecipe}} takes {{estimatedTime}} minutes and is {{recipeComplexity}}',
  )
  .assistant();

// Extract specific fields only (using array mapping)
const agentPartial = Agent.create()
  .system('Analyze the request.')
  .user('Complex request with many details...')
  .extract(
    complexSchema,
    ['title', 'priority'], // Only extract these fields to same-named vars
    { provider: 'openai' },
  );

// Store entire object in a single variable
const agentWithObject = Agent.create()
  .system('Extract product details.')
  .user('iPhone 15 Pro, released in 2023, starting at $999')
  .extract(productSchema, 'product') // Store as session.vars.product
  .user('The {{product.name}} costs {{product.price}}');

// Alternative: Using assistant with options (still supported)
const agentWithOptions = Agent.create()
  .system('Extract user info.')
  .user('User input...')
  .assistant(
    {
      provider: 'openai',
      schema: userSchema,
    },
    {
      extractToVars: true, // Options-based approach still works
    },
  );
```

### Validation

PromptTrail provides comprehensive validation for all content with automatic retry:

```typescript
import { Validation } from '@prompttrail/core';

// Assistant validation with retry
const agent = Agent.create()
  .system('Explain concepts clearly with examples.')
  .user('What is TypeScript?')
  .assistant(
    {
      provider: 'openai',
    },
    {
      validation: Validation.all([
        Validation.length({ min: 10, max: 500 }),
        Validation.keyword(['explanation', 'example'], { mode: 'include' }),
        Validation.regex(/^\w+.*\w+$/), // Must start and end with word characters
      ]),
      maxAttempts: 5,
    },
  );

// User input validation with retries
const userAgent = Agent.create()
  .system('Gather user information')
  .user(
    { cli: 'Enter your name (2-50 chars):' },
    {
      validation: Validation.all([
        Validation.length({ min: 2, max: 50 }),
        Validation.regex(/^[a-zA-Z\s]+$/), // Only letters and spaces
      ]),
      maxAttempts: 3,
    },
  );

// Schema validation for structured data
const structuredAgent = Agent.create()
  .system('Extract structured data')
  .user('Parse this information')
  .assistant(
    {
      provider: 'openai',
    },
    {
      validation: Validation.schema(
        z.object({
          answer: z.string(),
          confidence: z.number().min(0).max(1),
          reasoning: z.array(z.string()),
        }),
      ),
      maxAttempts: 3,
    },
  );

// Custom validation with context access
const contextAgent = Agent.create()
  .system('Respond appropriately')
  .user('Tell me about AI')
  .assistant(
    {
      provider: 'openai',
    },
    {
      validation: Validation.custom((content, session) => {
        const maxWords = session?.getVar('maxWords', 50);
        const wordCount = content.split(/\s+/).length;

        if (wordCount <= maxWords) {
          return { isValid: true };
        }

        return {
          isValid: false,
          instruction: `Response must be ${maxWords} words or less (got ${wordCount})`,
        };
      }),
      maxAttempts: 2,
    },
  );
```

**Validation Features:**

- **Automatic retry** - Failed validations trigger new attempts
- **Rich feedback** - Validation instructions help LLMs improve
- **All sources** - Works with LLM, CLI, callback, and literal sources
- **Composable** - Combine multiple validators with AND/OR logic
- **Context-aware** - Access session state in custom validators

### Advanced Control Flow

Beyond basic patterns, PromptTrail offers sophisticated control structures:

```typescript
// Nested subroutines for memory management
const agent = Agent.create()
  .system('Complex data processor')
  .subroutine(
    (agent) =>
      agent
        .user('Stage 1: Parse data')
        .assistant()
        .subroutine(
          (innerAgent) =>
            innerAgent.user('Sub-process: Validate format').assistant(),
          {
            isolatedContext: true, // Clean slate for validation
            retainMessages: false, // Don't pollute main conversation
          },
        )
        .transform((session) => session.withVar('stage1Complete', true)),
    {
      squashWith: (parent, sub) =>
        parent.withContext({
          processed: sub.getVar('stage1Complete'),
          result: sub.getLastMessage()?.content,
        }),
    },
  );

// Multi-LLM parallel processing
const researchAgent = Agent.create()
  .system('Research assistant')
  .user('Compare machine learning frameworks')
  .parallel(
    (p) =>
      p
        .withSource({ provider: 'openai', temperature: 0.2 }, 1) // Conservative
        .withSource({ provider: 'anthropic', temperature: 0.8 }, 1) // Creative
        .withSource({ provider: 'google', temperature: 0.5 }, 1) // Balanced
        .withAggregationFunction(
          (session) => session.getLastMessage()?.content?.length || 0,
        )
        .withStrategy('best'), // Keep longest response
  );

// Goal-oriented research with custom satisfaction
const smartScenario = Scenario.system('You are an expert researcher.')
  .step('Understand research requirements', { allow_interaction: true })
  .step('Gather comprehensive information', {
    max_attempts: 8,
    is_satisfied: (session, goal) => {
      const messages = session.getMessagesByType('assistant');
      const hasToolCalls = messages.some((m) => m.toolCalls?.length > 0);
      const hasDetailedAnalysis = messages.some(
        (m) => m.content?.length > 500 && m.content.includes('analysis'),
      );
      return hasToolCalls && hasDetailedAnalysis;
    },
  })
  .step('Synthesize findings and provide recommendations');

// Dynamic flow with error handling
const robustAgent = Agent.create()
  .system('Fault-tolerant processor')
  .transform((session) => session.withVar('retryCount', 0))
  .loop(
    (agent) =>
      agent.conditional(
        (session) => session.getVar('retryCount') < 3,
        (agent) =>
          agent
            .user('Attempt operation')
            .assistant()
            .transform((session) => {
              const success = session
                .getLastMessage()
                ?.content?.includes('success');
              return session.withContext({
                success,
                retryCount: session.getVar('retryCount') + 1,
              });
            }),
        (agent) =>
          agent.transform((session) => session.withVar('failed', true)),
      ),
    (session) => !session.getVar('success') && !session.getVar('failed'),
  );
```

**Advanced Patterns:**

- **Nested isolation** - Subroutines within subroutines for memory management
- **Multi-provider consensus** - Run multiple LLMs and aggregate results
- **Custom goal validation** - Define complex satisfaction criteria for scenarios
- **Error recovery** - Retry logic with fallback strategies

### MCP Integration

PromptTrail.ts provides full integration with the **Model Context Protocol (MCP)**, allowing you to dynamically create tools from MCP servers and use MCP resources and prompts as content sources.

#### Quick Start with MCP

```typescript
import { createMCPClient, MCPTools, MCPSource } from '@prompttrail/core';

// Connect to an MCP server
const mcpClient = createMCPClient({
  name: 'my-app',
  version: '1.0.0'
});

await mcpClient.connect({
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
});

// Create all tools from the MCP server automatically
const tools = await MCPTools.createAll(mcpClient);

// Use in an agent
const agent = Agent.create()
  .system('You have access to filesystem tools.')
  .user('List files in the current directory')
  .assistant({
    provider: 'openai',
    tools // All MCP tools are now available
  });
```

#### Dynamic Tool Creation

PromptTrail automatically converts MCP tool schemas to typed AI SDK tools:

```typescript
// Create specific tools by name
const calculatorTools = await MCPTools.named(mcpClient, ['calculate', 'convert']);

// Create tools matching a pattern
const fileTools = await MCPTools.matching(mcpClient, /^file_/);

// Create tools with custom prefix
const prefixedTools = await MCPTools.withPrefix(mcpClient, 'mcp_');

// Use the MCPToolFactory for advanced configurations
const factory = new MCPToolFactory(mcpClient);
const result = await factory.createAllTools({
  namePrefix: 'fs_',
  filter: (tool) => tool.name.includes('file'),
  extractTextOnly: true, // Return text instead of MCP result objects
  resultTransform: (result) => `Processed: ${result}`,
  customHandlers: {
    'special-tool': async (params) => {
      // Custom implementation for specific tools
      return `Custom result for ${JSON.stringify(params)}`;
    }
  }
});

console.log(`Created ${result.count} tools:`, result.names);
```

#### MCP as Content Sources

Use MCP tools, resources, and prompts directly in templates:

```typescript
// MCP Tools as User Content
const agent = Agent.create()
  .system('Processing request')
  .user(MCPSource.tool(mcpClient, 'calculate', {
    arguments: { operation: 'add', a: 5, b: 3 },
    extractText: true // Get "Result: 8" instead of full MCP response
  }))
  .assistant('I see the calculation result.');

// MCP Resources as Content
const configAgent = Agent.create()
  .system('Configuration processor')
  .user(MCPSource.resource(mcpClient, 'config://app/settings', {
    extractText: true
  }))
  .assistant('I can see your configuration.');

// MCP Prompts as Content
const reviewAgent = Agent.create()
  .system('Code reviewer')
  .user(MCPSource.prompt(mcpClient, 'code-review', {
    arguments: {
      code: 'function add(a, b) { return a + b; }',
      language: 'javascript'
    },
    format: 'text' // 'text' or 'messages'
  }))
  .assistant();

// MCP Tools as Assistant Sources (for non-LLM responses)
const calculatorAgent = Agent.create()
  .system('Calculator service')
  .transform(s => s.withVar('operation', 'multiply').withVar('a', 10).withVar('b', 5))
  .assistant(MCPSource.model(mcpClient, 'calculate')); // Uses session vars as arguments
```

#### Advanced MCP Workflows

```typescript
// Chaining MCP operations with variable extraction
const complexAgent = Agent.create()
  .system('Data processor')
  // Get user list from MCP
  .user(MCPSource.tool(mcpClient, 'list-users', {
    arguments: { limit: 5 },
    extractText: true
  }))
  .transform(session => {
    // Extract first user ID from the response
    const userList = JSON.parse(session.getLastMessage()?.content || '[]');
    return session.withVar('userId', userList[0]?.id || 'default');
  })
  // Use extracted user ID to get user details
  .user(MCPSource.resource(mcpClient, 'users://{{userId}}/profile', {
    extractText: true
  }))
  .assistant('I can analyze this user data.');

// Conditional MCP usage
const conditionalAgent = Agent.create<{ useFileSystem: boolean }>()
  .system('Adaptive assistant')
  .conditional(
    (session) => session.getVar('useFileSystem', false),
    // Use filesystem MCP tools
    (agent) => agent
      .user(MCPSource.tool(mcpClient, 'list-directory', {
        arguments: { path: '/tmp' }
      }))
      .assistant('I can see your files.'),
    // Use web search instead
    (agent) => agent
      .user('Search the web for information')
      .assistant({ provider: 'openai' })
  );

// Error handling with MCP
const robustAgent = Agent.create()
  .system('Fault-tolerant MCP usage')
  .user(async (session) => {
    try {
      const result = await mcpClient.callTool({
        name: 'risky-operation',
        arguments: { data: 'test' }
      });
      return result.content[0]?.text || 'No result';
    } catch (error) {
      return `Operation failed: ${error.message}`;
    }
  })
  .assistant();
```

#### Tool Registry Management

Manage tools across multiple MCP clients:

```typescript
import { globalMCPToolRegistry } from '@prompttrail/core';

// Register tools from multiple clients
const tools1 = await MCPTools.withInfo(mcpClient1);
const tools2 = await MCPTools.withInfo(mcpClient2);

globalMCPToolRegistry.register('filesystem', mcpClient1, tools1);
globalMCPToolRegistry.register('database', mcpClient2, tools2);

// Find tools across all clients
const calculatorTools = globalMCPToolRegistry.findTools(/calc/);
const allFileTools = globalMCPToolRegistry.getToolsForClient('filesystem');

// Get registry statistics
const stats = globalMCPToolRegistry.getStats();
console.log(`Total clients: ${stats.totalClients}, Total tools: ${stats.totalTools}`);

// Use specific tool from registry
const specificTool = globalMCPToolRegistry.getTool('filesystem', 'list-files');
if (specificTool) {
  const result = await specificTool.execute({ path: '/home' });
}
```

#### Connection Types

PromptTrail supports all MCP transport types:

```typescript
// stdio transport (most common)
await mcpClient.connect({
  type: 'stdio',
  command: 'python',
  args: ['my-mcp-server.py']
});

// HTTP transport
await mcpClient.connect({
  type: 'http',
  url: 'http://localhost:3000/mcp'
});

// Direct connection (for testing)
await mcpClient.connect({
  type: 'direct',
  server: myMCPServerInstance
});
```

### Streaming Responses

```typescript
import { generateTextStream } from '@prompttrail/core';

const session = Session.create().addMessage({
  type: 'user',
  content: 'Explain async/await',
});

const llmConfig = {
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
};

for await (const chunk of generateTextStream(session, llmConfig)) {
  process.stdout.write(chunk.content);
}
```

## 🔧 Provider Configuration

### OpenAI

```typescript
const openaiConfig = {
  provider: 'openai' as const,
  model: 'gpt-4',
  temperature: 0.7,
  maxTokens: 1000,
  apiKey: process.env.OPENAI_API_KEY,
};

.assistant(openaiConfig)
```

### Anthropic

```typescript
const anthropicConfig = {
  provider: 'anthropic' as const,
  model: 'claude-3-5-haiku-latest',
  temperature: 0.5,
  apiKey: process.env.ANTHROPIC_API_KEY,
};

.assistant(anthropicConfig)
```

### Google

```typescript
const googleConfig = {
  provider: 'google' as const,
  model: 'gemini-pro',
  temperature: 0.8,
  apiKey: process.env.GOOGLE_API_KEY,
};

.assistant(googleConfig)
```

## 🌐 Browser Support

```typescript
// Enable browser mode (⚠️ Don't expose API keys in production!)
const browserConfig = {
  provider: 'openai' as const,
  apiKey: 'sk-...',
  dangerouslyAllowBrowser: true,
};

.assistant(browserConfig)
```

## 📦 Package Structure

- `@prompttrail/core` - Main framework
- `@prompttrail/react` - React integration (coming soon)

## 💡 Examples

Check the [`examples/`](./examples) directory for more:

- [`chat.ts`](./examples/chat.ts) - Simple chat interface
- [`coding_agent.ts`](./examples/coding_agent.ts) - AI coding assistant
- [`autonomous_researcher.ts`](./examples/autonomous_researcher.ts) - Research agent
- [`gradual_typing_demo.ts`](./examples/gradual_typing_demo.ts) - TypeScript typing patterns

## 🤝 Contributing

1. Fork the repository
2. Run tests: `cd packages/core && pnpm test`
3. Check types: `pnpm -C packages/core typecheck`
4. Format code: `pnpm format`
5. Submit a pull request

## 📄 License

MIT - See [LICENSE](LICENSE) for details.
