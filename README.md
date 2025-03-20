# 🚀 PromptTrail

A type-safe, composable framework for building structured LLM conversations with various LLMs and tools.

PromptTrail helps TypeScript developers build robust, maintainable LLM applications with strong typing, composable templates, and powerful validation tools. Built on Vercel's widely-adopted [ai-sdk](https://github.com/vercel/ai), PromptTrail leverages its ecosystem for LLM and tool interactions, enabling seamless integration with a broad range of language models and function calling capabilities.

## ✨ Features

- 🔒 [**TypeScript-First**](#-typescript-first-design) - Full TypeScript support with inference and generics
- 📝 [**Template-Based**](#-building-templates) - Composable conversation building blocks
- 🔄 [**Stateless Architecture**](#-session-management) - Immutable sessions for predictable state management
- 🛠️ [**Tool Integration**](#-tool-integration) - First-class support for function calling
- 🔌 [**Multi-Provider**](#-model-configuration) - Works with OpenAI, Anthropic (with MCP support), and extensible for more
- 🌊 [**Streaming Support**](#-streaming-responses) - Real-time response streaming
- 🧩 [**Composable Patterns**](#-interactive-loops) - Mix and match templates for complex flows
- 📊 [**Structured Data Extraction**](#-session-to-metadata-conversion) - Extract and transform data from LLM outputs
- 🛡️ [**Guardrails**](#-guardrails) - Validate and ensure quality of LLM responses
- 🧩 [**Schema Validation**](#-schema-validation) - Force LLMs to produce structured outputs using schemas
- 🌐 [**Browser Compatible**](#-browser-support) - Works in both Node.js and browser environments

## 🔧 Installation

```bash
# Using pnpm (recommended)
pnpm add @prompttrail/core

# Using npm
npm install @prompttrail/core

# Using yarn
yarn add @prompttrail/core
```

## 🚀 Quick Start

```typescript
import {
  LinearTemplate,
  createSession,
  type GenerateOptions,
} from '@prompttrail/core';

// Define generateOptions for OpenAI
const generateOptions: GenerateOptions = {
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
};

// Create a simple conversation template
const chat = new LinearTemplate()
  .addSystem("I'm a helpful assistant.")
  .addUser("What's TypeScript?")
  .addAssistant({ generateOptions });

// Execute the template with print mode enabled
const session = await chat.execute(
  createSession({
    print: true, // Enable console logging of the conversation
  }),
);
console.log(session.getLastMessage()?.content);
```

<!-- TEST: creates a conversation and returns a session with messages
  // Create a simple session with predefined messages
  const testSession = createSession({
    print: false,
    messages: [
      { type: 'system', content: "I'm a helpful assistant." },
      { type: 'user', content: "What's TypeScript?" },
      { type: 'assistant', content: 'TypeScript is a programming language.' }
    ]
  });
  
  // Verify the session structure
  expect(testSession.messages).toHaveLength(3);
  expect(testSession.messages[0].type).toBe('system');
  expect(testSession.messages[1].type).toBe('user');
  expect(testSession.messages[2].type).toBe('assistant');
-->

## 📘 Usage

### 🔒 TypeScript-First Design

While many LLM libraries are built around Python, PromptTrail takes a different approach by embracing TypeScript. This choice provides significant advantages for developers building production applications, offering strong typing, better IDE support, and a more robust development experience.

PromptTrail is built from the ground up with TypeScript, embracing modern type system features:

```typescript
// Type inference for session metadata
interface UserContext {
  name: string;
  preferences: {
    theme: 'light' | 'dark';
    language: string;
  };
}

// Type-safe session with inferred metadata types
const session = createSession<UserContext>({
  metadata: {
    name: 'Alice',
    preferences: {
      theme: 'dark',
      language: 'TypeScript',
    },
  },
});

// Type-safe metadata access with autocomplete
const userName = session.metadata.get('name'); // Type: string
const theme = session.metadata.get('preferences').theme; // Type: 'light' | 'dark'

// Immutable updates return new instances with preserved types
const updatedSession = session.updateMetadata({
  lastActive: new Date(),
});
// updatedSession.metadata.get('lastActive') is now available with correct type
```

<!-- TEST: provides type-safe metadata access
  // Create a session with metadata
  const testSession = createSession({
    metadata: {
      name: 'Alice',
      preferences: {
        theme: 'dark',
        language: 'TypeScript',
      },
    },
  });
  
  // Access metadata
  const testUserName = testSession.metadata.get('name');
  const preferences = testSession.metadata.get('preferences');
  const testTheme = preferences ? preferences.theme : undefined;
  
  // Update metadata
  const testUpdatedSession = testSession.updateMetadata({
    lastActive: new Date(),
  });
  
  // Test assertions
  expect(testUserName).toBe('Alice');
  expect(testTheme).toBe('dark');
  
  // Test type safety and immutability
  expect(testSession.metadata.get('name')).toBe('Alice');
  expect(testUpdatedSession.metadata.get('name')).toBe('Alice');
  expect(testUpdatedSession.metadata.get('lastActive')).toBeInstanceOf(Date);
  
  // Original session should be unchanged
  expect(testSession.metadata.get('lastActive')).toBeUndefined();
-->

PromptTrail's immutable architecture ensures predictable state management:

- All session operations return new instances rather than modifying existing ones
- Templates use pure functions for transformations
- Type definitions are shared across the entire library for consistency
- Generic type parameters flow through the API for end-to-end type safety

This approach provides compile-time guarantees, excellent IDE support, and helps prevent common runtime errors.

### 🏗️ Building Templates

Templates are the core building blocks for creating conversation flows:

```typescript
// Create a personalized chat with metadata interpolation
interface UserPreferences {
  name: string;
  language: string;
  expertise: string[];
}

const personalizedChat = new LinearTemplate()
  .addSystem("I'll adapt to your preferences.")
  .addAssistant('Hello ${name}! How can I help with ${expertise[0]}?')
  .addUser({ inputSource: new CLIInputSource() })
  .addAssistant({ generateOptions });

// Execute with session metadata
const session = await personalizedChat.execute(
  createSession<UserPreferences>({
    metadata: {
      name: 'Alice',
      language: 'TypeScript',
      expertise: ['generics', 'type inference'],
    },
    print: true, // Enable console logging
  }),
);
```

<!-- TEST: creates a template with metadata interpolation
  // Create a template with metadata interpolation
  const template = new LinearTemplate()
    .addSystem("I'll adapt to your preferences.")
    .addAssistant('Hello ${name}! How can I help with ${expertise[0]}?');
  
  // Create a session with metadata
  const testSession = createSession({
    metadata: {
      name: 'Alice',
      expertise: ['generics', 'type inference'],
    },
    messages: []
  });
  
  // Execute the template
  const result = await template.execute(testSession);
  
  // Verify the interpolation worked
  expect(result.messages).toHaveLength(2);
  expect(result.messages[1].content).toBe('Hello Alice! How can I help with generics?');
-->

### 🔄 Interactive Loops

Create dynamic, branching conversations with loop templates:

```typescript
const quiz = new LinearTemplate()
  .addSystem("I'm your TypeScript quiz master!")
  .addLoop(
    new LoopTemplate()
      .addUser('Ready for a question?')
      .addAssistant({ generateOptions })
      .addUser('My answer:', 'interfaces are awesome!')
      .addAssistant({ generateOptions })
      .addUser('Another question? (yes/no)', 'yes')
      .setExitCondition(
        (session) => session.getLastMessage()?.content.toLowerCase() === 'no',
      ),
  );
```

### 🤖 Model Configuration

PromptTrail uses a unified approach to model configuration through `generateOptions`, which is passed to the `generateText` function. This approach is inspired by [Vercel's AI SDK](https://github.com/vercel/ai), a popular unified LLM framework.

Configure models with provider-specific options:

```typescript
// OpenAI configuration
const openaiOptions: GenerateOptions = {
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
  maxTokens: 1000,
};

// Anthropic configuration
const anthropicOptions: GenerateOptions = {
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    modelName: 'claude-3-5-haiku-latest',
  },
  temperature: 0.5,
};

// Anthropic with MCP integration
const anthropicMcpOptions: GenerateOptions = {
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    modelName: 'claude-3-5-haiku-latest',
  },
  temperature: 0.7,
  mcpServers: [
    {
      url: 'http://localhost:8080', // Your MCP server URL
      name: 'github-mcp-server',
      version: '1.0.0',
    },
  ],
};
```

### 💾 Session Management

Manage conversation state with immutable sessions and in-place templating:

```typescript
// Create a session with metadata for templating
const session = createSession({
  metadata: {
    userId: 'user-123',
    language: 'TypeScript',
    tone: 'professional',
    topics: ['generics', 'type inference', 'utility types'],
  },
  print: true, // Enable console logging
});

// Templates use ${variable} syntax for direct interpolation
const template = new LinearTemplate()
  .addSystem("I'll use ${tone} language to explain ${topics[0]}")
  .addAssistant('Let me explain ${topics[0]} in ${language}')
  .addUser('Can you also cover ${topics[1]}?');

// Sessions are immutable - operations return new instances
const updatedSession = session.addMessage({
  type: 'user',
  content: 'Hello!',
});

// Query session state
const lastMessage = updatedSession.getLastMessage();
const userMessages = updatedSession.getMessagesByType('user');

// Update metadata (returns new session)
const newSession = updatedSession.updateMetadata({
  tone: 'casual',
});

// Serialize/deserialize
const json = newSession.toJSON();
const restored = Session.fromJSON(json);
```

<!-- TEST: demonstrates session immutability
  // Create a session
  const originalSession = createSession({
    metadata: {
      userId: 'user-123',
      tone: 'professional',
    },
    messages: []
  });
  
  // Add a message (should return a new session)
  const updatedSession = originalSession.addMessage({
    type: 'user',
    content: 'Hello!',
  });
  
  // Verify immutability
  expect(updatedSession).not.toBe(originalSession);
  expect(originalSession.messages).toHaveLength(0);
  expect(updatedSession.messages).toHaveLength(1);
  expect(updatedSession.messages[0].content).toBe('Hello!');
  
  // Test metadata updates
  const newSession = updatedSession.updateMetadata({
    tone: 'casual',
  });
  
  // Verify metadata was updated in new session
  expect(newSession.metadata.get('tone')).toBe('casual');
  expect(updatedSession.metadata.get('tone')).toBe('professional');
-->

### 🌊 Streaming Responses

Process model responses in real-time:

```typescript
// Stream responses chunk by chunk
for await (const chunk of generateTextStream(session, generateOptions)) {
  process.stdout.write(chunk.content);
}
```

### 📊 Session-to-Metadata Conversion

Extract structured data from LLM outputs:

````typescript
import {
  LinearTemplate,
  createSession,
  extractMarkdown,
  extractPattern,
  type GenerateOptions,
} from '@prompttrail/core';

// Define generateOptions for OpenAI
const generateOptions: GenerateOptions = {
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
};

// Create a template that extracts structured data from responses
const codeTemplate = new LinearTemplate()
  .addSystem(
    "You're a TypeScript expert. Always include code examples in ```typescript blocks and use ## headings for sections.",
  )
  .addUser(
    'Write a function to calculate the factorial of a number with explanation.',
  )
  .addAssistant({ generateOptions })
  // Extract markdown headings and code blocks
  .addTransformer(
    extractMarkdown({
      headingMap: {
        Explanation: 'explanation',
        'Usage Example': 'usageExample',
      },
      codeBlockMap: { typescript: 'code' },
    }),
  );

// Execute the template
const session = await codeTemplate.execute(createSession());

// Access the extracted data
console.log('Code:', session.metadata.get('code'));
console.log('Explanation:', session.metadata.get('explanation'));

// You can also extract data using regex patterns
const dataTemplate = new LinearTemplate()
  .addUser('Server status: IP 192.168.1.100, Uptime 99.99%, Status: Running')
  .addTransformer(
    extractPattern([
      {
        pattern: /IP ([\d\.]+)/,
        key: 'ipAddress',
      },
      {
        pattern: /Uptime ([\d\.]+)%/,
        key: 'uptime',
        transform: (value) => parseFloat(value) / 100,
      },
    ]),
  );

const dataSession = await dataTemplate.execute(createSession());
console.log('IP:', dataSession.metadata.get('ipAddress')); // "192.168.1.100"
console.log('Uptime:', dataSession.metadata.get('uptime')); // 0.9999
````

<!-- TEST: extracts data using pattern matching
  // Create a template with pattern extraction
  const template = new LinearTemplate()
    .addUser('Server status: IP 192.168.1.100, Uptime 99.99%, Status: Running')
    .addTransformer(
      extractPattern([
        {
          pattern: /IP ([\d\.]+)/,
          key: 'ipAddress',
        },
        {
          pattern: /Uptime ([\d\.]+)%/,
          key: 'uptime',
          transform: (value) => parseFloat(value) / 100,
        },
      ]),
    );
  
  // Execute the template
  const session = await template.execute(createSession());
  
  // Verify the extracted data
  expect(session.metadata.get('ipAddress')).toBe('192.168.1.100');
  expect(session.metadata.get('uptime')).toBe(0.9999);
-->

### 🛡️ Guardrails

Validate and ensure quality of LLM responses, inspired by the Python library [guardrails-ai](https://github.com/guardrails-ai/guardrails/tree/main):

```typescript
import {
  LinearTemplate,
  AssistantTemplate,
  GuardrailTemplate,
  RegexMatchValidator,
  KeywordValidator,
  LengthValidator,
  AllValidator,
  OnFailAction,
  type GenerateOptions,
} from '@prompttrail/core';

// Create validators to ensure responses meet criteria
const validators = [
  // Ensure response is a single word with only letters
  new RegexMatchValidator({
    regex: /^[A-Za-z]+$/,
    description: 'Response must be a single word with only letters',
  }),

  // Ensure response is between 3 and 10 characters
  new LengthValidator({
    min: 3,
    max: 10,
    description: 'Response must be between 3 and 10 characters',
  }),

  // Ensure response doesn't contain inappropriate words
  new KeywordValidator({
    keywords: ['inappropriate', 'offensive'],
    mode: 'exclude',
    description: 'Response must not be inappropriate',
  }),
];

// Combine all validators with AND logic
const combinedValidator = new AllValidator(validators);

// Define generateOptions for OpenAI
const generateOptions: GenerateOptions = {
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
};

// Create a guardrail template
const guardrailTemplate = new GuardrailTemplate({
  template: new AssistantTemplate({ generateOptions }),
  validators: [combinedValidator],
  onFail: OnFailAction.RETRY,
  maxAttempts: 3,
});

// Create a template that asks for a pet name
const petNameTemplate = new LinearTemplate()
  .addSystem('You are a helpful assistant that suggests pet names.')
  .addUser('Suggest a name for a pet cat.');

// Execute the templates in sequence
let session = createSession();
session = await petNameTemplate.execute(session);
session = await guardrailTemplate.execute(session);

// Get the final response
console.log('Pet name:', session.getLastMessage()?.content);
```

### 🧩 Schema Validation

Force LLMs to produce structured outputs using schemas:

```typescript
import {
  LinearTemplate,
  createSession,
  defineSchema,
  createStringProperty,
  createNumberProperty,
  createBooleanProperty,
  type GenerateOptions,
} from '@prompttrail/core';
import { z } from 'zod';

// Option 1: Using PromptTrail's native schema format
const productSchema = defineSchema({
  properties: {
    name: createStringProperty('The name of the product'),
    price: createNumberProperty('The price of the product in USD'),
    inStock: createBooleanProperty('Whether the product is in stock'),
    description: createStringProperty('A short description of the product'),
  },
  required: ['name', 'price', 'inStock'],
});

// Option 2: Using Zod schemas (more powerful validation)
const userSchema = z.object({
  username: z.string().min(3).max(20).describe('Username (3-20 characters)'),
  email: z.string().email().describe('Valid email address'),
  age: z.number().int().min(18).max(120).describe('Age (must be 18 or older)'),
  roles: z.array(z.enum(['admin', 'user', 'moderator'])).describe('User roles'),
  settings: z
    .object({
      darkMode: z.boolean().describe('Dark mode preference'),
      notifications: z.boolean().describe('Notification preference'),
    })
    .describe('User settings'),
});

// Define generateOptions for Anthropic
const generateOptions: GenerateOptions = {
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY || 'your-api-key-here',
    modelName: 'claude-3-5-haiku-latest',
  },
  temperature: 0.7,
};

// Create a template with schema validation
const template = new LinearTemplate()
  .addSystem('Extract product information from the text.')
  .addUser(
    'The new iPhone 15 Pro costs $999 and comes with a titanium frame. It is currently in stock.',
  );

// Add schema validation (works with both native schemas and Zod schemas)
await template.addSchema(productSchema, { generateOptions, maxAttempts: 3 });

// Execute the template
const session = await template.execute(createSession());

// Get the structured output from the session metadata
const product = session.metadata.get('structured_output');
console.log(product);
// Output: { name: 'iPhone 15 Pro', price: 999, inStock: true, description: 'Smartphone with a titanium frame' }

// Access individual fields with proper typing
console.log(`Product: ${product.name} - $${product.price}`);
console.log(`In Stock: ${product.inStock ? 'Yes' : 'No'}`);
```

<!-- TEST: validates structured output using schemas
  // Define a simple product schema
  const productSchema = defineSchema({
    properties: {
      name: createStringProperty('The name of the product'),
      price: createNumberProperty('The price of the product in USD'),
      inStock: createBooleanProperty('Whether the product is in stock'),
    },
    required: ['name', 'price', 'inStock'],
  });
  
  // Create a mock session with structured output
  const testSession = createSession({
    metadata: {
      structured_output: {
        name: 'iPhone 15 Pro',
        price: 999,
        inStock: true,
        description: 'Smartphone with a titanium frame'
      }
    },
    messages: []
  });
  
  // Verify the structured output
  const product = testSession.metadata.get('structured_output');
  expect(product).toBeDefined();
  expect(product.name).toBe('iPhone 15 Pro');
  expect(product.price).toBe(999);
  expect(product.inStock).toBe(true);
  expect(product.description).toBe('Smartphone with a titanium frame');
-->

This feature is inspired by [Zod-GPT](https://github.com/dzhng/zod-gpt) but has been reimplemented and enhanced for PromptTrail with TypeScript-first design.

### 🛠️ Tool Integration

Extend LLM capabilities with function calling:

```typescript
// Define a calculator tool
const calculator = new Tool({
  name: 'calculator',
  description: 'Perform arithmetic operations',
  schema: {
    type: 'object',
    properties: {
      a: { type: 'number', description: 'First number' },
      b: { type: 'number', description: 'Second number' },
      operation: {
        type: 'string',
        enum: ['add', 'subtract', 'multiply', 'divide'],
        description: 'Operation to perform',
      },
    },
    required: ['a', 'b', 'operation'],
  },
  execute: async (input) => {
    switch (input.operation) {
      case 'add':
        return { result: input.a + input.b };
      case 'subtract':
        return { result: input.a - input.b };
      case 'multiply':
        return { result: input.a * input.b };
      case 'divide':
        return { result: input.a / input.b };
    }
  },
});

// Define generateOptions with tools
const generateOptions: GenerateOptions = {
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
  tools: [calculator],
};

const mathChat = new LinearTemplate()
  .addSystem('I can help with calculations.')
  .addUser("What's 123 * 456?")
  .addAssistant({ generateOptions });
```

## 📚 API Explorer

Your IDE is your best friend! We've packed PromptTrail with TypeScript goodies:

### MCP Support

Connect to Anthropic's Model Context Protocol (MCP) servers to extend Claude's capabilities:

```typescript
import {
  createSession,
  LinearTemplate,
  type GenerateOptions,
} from '@prompttrail/core';

// Define generateOptions for Anthropic with MCP integration
const generateOptions: GenerateOptions = {
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    modelName: 'claude-3-5-haiku-latest',
  },
  temperature: 0.7,
  mcpServers: [
    {
      url: 'http://localhost:8080', // Your MCP server URL
      name: 'github-mcp-server',
      version: '1.0.0',
    },
  ],
};

// Create a template that uses MCP tools
const template = new LinearTemplate()
  .addSystem(
    `You are a helpful assistant with access to external tools.
             You can use these tools when needed to provide accurate information.`,
  )
  .addUser('Can you check the weather in San Francisco?', '')
  .addAssistant({ generateOptions });

// Execute the template
const session = await template.execute(createSession());
```

MCP allows Claude to access external tools and resources like GitHub repositories, databases, or custom APIs through a standardized protocol. PromptTrail automatically discovers and loads tools from connected MCP servers, making them available to Claude during conversations.

## 🌐 Browser Support

PromptTrail works in browser environments with a simple configuration flag:

```typescript
// Browser-compatible configuration
const generateOptions: GenerateOptions = {
  provider: {
    type: 'openai',
    apiKey: 'YOUR_API_KEY', // In production, fetch from your backend
    modelName: 'gpt-4o-mini',
    dangerouslyAllowBrowser: true, // Required for browser usage
  },
  temperature: 0.7,
};
```

For a complete React implementation, check out our [React Chat Example](examples/react-chat).

## 👥 Contributing

Contributions are welcome! Here's how you can help:

- 🐛 Report bugs by opening issues
- 💡 Suggest features and improvements
- 🧪 Run tests with `cd packages/core && pnpm exec vitest --run --watch=false`
- 🔀 Submit pull requests

## 📄 License

MIT - See [LICENSE](LICENSE) for details.
