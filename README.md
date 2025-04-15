# 🚀 PromptTrail

A type-safe, composable framework for building structured LLM conversations with various LLMs and tools.

PromptTrail helps TypeScript developers build robust, maintainable LLM applications with strong typing, composable templates, and powerful validation tools. Built on Vercel's widely-adopted [ai-sdk](https://github.com/vercel/ai), PromptTrail leverages its ecosystem for LLM and tool interactions, enabling seamless integration with a broad range of language models and function calling capabilities.

## ✨ Features

- 🔒 [**TypeScript-First**](#-typescript-first-design) - Full TypeScript support with inference and generics
- 📝 [**Template-Based**](#%EF%B8%8F-building-templates) - Composable conversation building blocks
- 🧩 [**Composable Patterns**](#-complex-control-flow) - Mix and match templates for complex flows
- 🔌 [**Multi-Provider**](#-model-configuration) - Works with OpenAI, Anthropic (with MCP support), and extensible for more
- 🔄 [**Stateless Architecture**](#-session-management) - Immutable sessions for predictable state management
- 🌊 [**Streaming Support**](#-streaming-responses) - Real-time response streaming
- 📊 [**Structured Data Extraction**](#-session-to-metadata-conversion) - Extract and transform data from LLM outputs
- 🛡️ [**Validation**](#%EF%B8%8F-validation) - Validate both user input and LLM responses
- 🧪 [**Structured Output**](#-schema-validation) - Force LLMs to produce structured outputs using schemas
- 🛠️ [**Tool Integration**](#%EF%B8%8F-tool-integration) - First-class support for function calling
- 🔌 [**MCP Support**](#-mcp-support) - Integration with Anthropic's Model Context Protocol
- 🌐 [**Browser Compatible**](#-browser-support) - Works in both Node.js and browser environments

## 🔧 Installation

> **Note:** This package is not yet published on npm. Install directly from GitHub:

```bash
# Using pnpm (recommended)
pnpm add github:combinatrix-ai/PromptTrail.ts

# Using npm
npm install github:combinatrix-ai/PromptTrail.ts

# Using yarn
yarn add github:combinatrix-ai/PromptTrail.ts
```

## 🚀 Quick Start

```typescript
import {
  Agent,
  createSession,
  createGenerateOptions,
  type GenerateOptions,
} from '@prompttrail/core';

// Define generateOptions for OpenAI
const generateOptions = createGenerateOptions({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
});

// Create a simple conversation template
const chat = new Agent()
  .addSystem("I'm a helpful assistant.")
  .addUser("What's TypeScript?")
  .addAssistant({ generateOptions: generateOptions });

// Execute the template
const session = await chat.execute(
  createSession({
    print: true, // Enable console logging of the conversation
  }),
);
console.log('last message:', session.getLastMessage()?.content);
// Console Output:
//     System: I'm a helpful assistant.
//     User: What's TypeScript?
//     Assistant: TypeScript is a superset of JavaScript that ...
//
//     last message: TypeScript is a superset of JavaScript that ...
```

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
interface UserInfo {
  name: string;
  language: string;
}

const techSupportFlow = new Agent()
  // Build template with fluent API
  .addSystem("You're a helpful programming assistant.")
  // Interpolate from metadata
  .addAssistant('Hi ${name}, ready to dive into ${language}?')
  // Get input from user
  .addUser({ inputSource: new CLIInputSource() })
  // Generate response using your custom generation logic
  .addAssistant({ generateOptions: generateOptions });

const session = await techSupportFlow.execute(
  // Pass metadata into the session
  createSession<UserInfo>({
    metadata: {
      name: 'Alice',
      language: 'TypeScript',
    },
    print: true, // Enable console output
  }),
);

// Console Output:
//     System: You're a helpful programming assistant.
//     Assistant: Hi Alice, ready to dive into TypeScript?
//     User: What's tricky about type inference?
//     Assistant: Alice, one tricky part of type inference is when unions are involved—TypeScript can lose precision. Want me to walk you through an example?
```

#### 🔄 Complex control flow

You can build complex control flow easily with code.

```typescript
const quiz = new Agent()
  .addSystem("I'm your TypeScript quiz master!")
  // Start quiz loop
  .addLoop(
    new LoopTemplate()
      .addUser('Ready for a question?')
      .addAssistant({ generateOptions: generateOptions })
      .addUser('What is generics in TypeScript?')
      .addAssistant({ generateOptions: generateOptions })
      .addUser('Another question? (yes/no)')
      // If user answer `no`, quit the loop
      .setExitCondition(
        (session) =>
          session.getLastMessage()?.content.toLowerCase().includes('no') ??
          false,
      ),
  )
  // If the user said `no` in the first round only
  .addIf({
    condition: (session) => {
      const messages = session.getMessages();
      const anotherQuestionCount = messages.filter((msg) =>
        msg.content.toLowerCase().includes('another question?'),
      ).length;
      return anotherQuestionCount === 1;
    },
    // Create child subroutine like function call
    thenTemplate: new Subroutine({
      // Note: Agent is alias of Sequence
      template: new Sequence()
        .addSystem("Hmm, don't you like answering quizzes?")
        .addUser('Then you give *me* a TypeScript quiz!')
        .addAssistant({ generateOptions: generateOptions }),
      // Decid which information to passed to child template and merge to parent
      initWith: (parent) => parent.clone(),
      squashWith: (parent, child) => parent.merge(child),
    }),
  })
  .addAssistant('Thanks for playing the quiz! 🚀');

const session = await quiz.execute(
  createSession({
    metadata: {},
    print: true,
  }),
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
const template = new Agent()
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
  Sequence,
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
const codeTemplate = new Sequence()
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
const dataTemplate = new Sequence()
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

### 🛡️ Validation

Validate and ensure quality of both user input and LLM responses with a unified validation interface:

```typescript
import {
  Sequence,
  createSession,
  createGenerateOptions,
  RegexMatchValidator,
  KeywordValidator,
  LengthValidator,
  AllValidator,
  AnyValidator,
  JsonValidator,
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
const generateOptions = createGenerateOptions({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
});

// Create a template that asks for a pet name with validation
const petNameTemplate = new Sequence()
  .addSystem('You are a helpful assistant that suggests pet names.')
  .addUser('Suggest a name for a pet cat.')
  // Add assistant with validator directly
  .addAssistant({
    generateOptions,
    validator: combinedValidator,
    maxAttempts: 3,
  });

// Execute the template
const session = await petNameTemplate.execute(createSession());

// Get the final response
console.log('Pet name:', session.getLastMessage()?.content);

// You can also use other validator types:
// JSON validation
const jsonValidator = new JsonValidator({
  description: 'Response must be valid JSON',
});

// Regex no-match validation
const noNumbersValidator = new RegexNoMatchValidator({
  regex: /\d+/,
  description: 'Response must not contain numbers',
});

// OR logic with AnyValidator
const anyValidator = new AnyValidator(
  [
    new RegexMatchValidator({ regex: /^[A-Z]/ }),
    new RegexMatchValidator({ regex: /!$/ }),
  ],
  {
    description:
      'Response must either start with a capital letter OR end with an exclamation mark',
  },
);

// Use validators with InputSource for user input validation
const userInputTemplate = new Sequence()
  .addSystem('You are a helpful assistant.')
  .addUser({
    inputSource: new CLIInputSource(),
    validate: async (input) => {
      // Custom validation logic for user input
      return input.length > 0 && !input.includes('bad word');
    },
  })
  .addAssistant({ generateOptions });
```

### 🧩 Schema Validation

Force LLMs to produce structured outputs using schemas:

```typescript
import {
  Sequence,
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
const template = new Sequence()
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

This feature is inspired by [Zod-GPT](https://github.com/dzhng/zod-gpt) but has been reimplemented and enhanced for PromptTrail with TypeScript-first design.

### 🛠️ Tool Integration

Extend LLM capabilities with function calling:

```typescript
// Define a weather forecast tool
const weather_forecast = new tool({
  description: 'Get weather information',
  parameters: z.object({
    location: z.string().describe('Location to get weather information for'),
  }),
  execute: async (input: { location: string }) => {
    const location = input.location;
    // const _weatherCondition = '72°F and Thunderstorms';
    const forecast = [
      'Today: Thunderstorms',
      'Tomorrow: Cloudy',
      'Monday: Rainy',
    ];
    return {
      location,
      temperature: 72,
      condition: 'Thunderstorms',
      forecast,
    };
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
  tools: [weather_forecast],
};

const weatherTemplate = new Sequence()
  .addSystem("I'm a weather assistant.")
  .addUser("What's the weather like in New York?")
  .addAssistant({ generateOptions });

await weatherTemplate.execute(createSession());
```

### 🔌 MCP Support

PromptTrail provides comprehensive support for Anthropic's Model Context Protocol (MCP), allowing Claude models to access external tools and resources like GitHub repositories, databases, or custom APIs through a standardized protocol.

```typescript
import {
  generateText, // ai-sdk wrapper
  createGenerateOptions,
  createSession,
} from '@prompttrail/core';

// Create session with your conversation
const session = createSession()
  .addMessage({
    type: 'system',
    content: 'You are a helpful assistant with MCP tool access.',
  })
  .addMessage({
    type: 'user',
    content: 'Can you search for the latest AI papers?',
  });

// Create options with MCP server configuration using the fluent API
const options = createGenerateOptions({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    modelName: 'claude-3-5-haiku-latest',
  },
  temperature: 0.7,
}).addMCPServer({
  url: 'http://localhost:8080',
  name: 'research-mcp-server',
  version: '1.0.0',
});

// Generate response with MCP integration
const response = await generateText(session, options);
console.log(response.content);
```

This implementation leverages the Vercel AI SDK's experimental MCP client to provide seamless integration with MCP servers. The `addMCPServer` method allows you to easily add and configure multiple MCP servers for enhanced model capabilities.

MCP tools are automatically discovered and made available to the model, enabling it to access external data sources and APIs without additional coding.

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
