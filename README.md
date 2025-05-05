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
- 📊 [**Structured Data Extraction**](#-session-to-context-conversion) - Extract and transform data from LLM outputs
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

## Package Structure

- `@prompttrail/core`: Core library for building LLM applications.
- `@prompttrail/react`: React components for building LLM applications (coming soon)

## 🚀 Quick Start

```typescript
// Usually all imports are from @prompttrail/core
import { Agent, createSession, createGenerateOptions } from '@prompttrail/core';

// Define generateOptions for OpenAI
let openAIgenerateOptions = createGenerateOptions({
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
  .addAssistant(openAIgenerateOptions);

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

### Core Concepts

- **Session**: Represents a conversation with `context` and `messages`.
  - **Context**: A structured object that holds the latest state of the conversation. It can be used for interpolation in templates or storing data. E.g. storing user information. `{userId: 'user-123', userName: 'Alice'}`
  - **Messages**: The conversation history, including system, user, and assistant messages. `[{type: 'system', content: '...'}, {type: 'user', content: '...'}, {type: 'assistant', content: '...'}]`
    - **Metadata**: Each message can have metadata to store additional information. `{type: 'user', content: '...', metadata: {timestamp: Date.now()}}`
- **Template**: A reusable conversation flow that can be executed with different sessions.

```typescript
// Example of a simple template execution
const simpleTemplate = new Agent()
  .addSystem('Welcome to the conversation!')
  .addUser('Tell me about TypeScript.')
  .addAssistant(
    'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
  );
const session = await simpleTemplate.execute(
  createSession({
    context: {
      userId: 'user-123',
      language: 'TypeScript',
    },
    print: true,
  }),
);
```

### 🔒 TypeScript-First Design

While many LLM libraries are built around Python, PromptTrail takes a different approach by embracing TypeScript. This choice provides significant advantages for developers building production applications, offering strong typing, better IDE support, and a more robust development experience.

PromptTrail is built from the ground up with TypeScript, embracing modern type system features:

```typescript
// Type inference for session context
interface UserContext {
  name: string;
  preferences: {
    theme: 'light' | 'dark';
    language: string;
  };
}

// Type-safe session with inferred context types
const session = createSession<UserContext>({
  context: {
    name: 'Alice',
    preferences: {
      theme: 'dark',
      language: 'TypeScript',
    },
  },
});

// Type-safe context access with autocomplete
const userName = session.context.name; // Type: string
const theme = session.context.preferences.theme; // Type: 'light' | 'dark'
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
// Define generateOptions for OpenAI
let openAIgenerateOptions = createGenerateOptions({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
});

// Create a personalized chat with context interpolation
interface UserInfo {
  name: string;
  language: string;
}

const techSupportFlow = new Agent<UserInfo>()
  // Build template with fluent API
  .addSystem("You're a helpful programming assistant.")
  // Interpolate from context
  .addAssistant(`Hello, \${name}! Ready to dive into \${language}?`)
  // Get input from user - Replace CLISource with a simple User message
  .addUser("What's tricky about type inference?")
  // Generate response using your custom generation options
  .addAssistant(openAIgenerateOptions);

const session = await techSupportFlow.execute(
  // Pass context into the session
  createSession<UserInfo>({
    context: {
      name: 'Alice',
      language: 'TypeScript',
    },
    print: true, // Enable console output
  }),
);

// Console Output:
//     System: You're a helpful programming assistant.
//     Assistant: Hello, Alice! Ready to dive into TypeScript?
//     User: What's tricky about type inference?
//     Assistant: Alice, one tricky part of type inference is when unions are involved—TypeScript can lose precision. Want me to walk you through an example?
```

#### 🔄 Complex control flow

You can build complex control flow easily with code.

```typescript
const quiz = new Sequence()
  .addSystem("You're a TypeScript quiz bot.")
  // Let's greet the user using Conditional
  .addIf(
    (session) => {
      const currentHour = new Date().getHours();
      return currentHour < 12;
    },
    new Assistant('Good morning!'),
    new Assistant('Good afternoon!'),
  )
  // Dive into the quiz loop
  .addLoop(
    new Sequence()
      .addUser(
        new ListSource([
          "What's TypeScript?",
          'Explain type inference.',
          "I'm satisfied now.",
        ]),
      )
      .addAssistant(openAIgenerateOptions),
    // Set exit condition
    (session) => {
      // Check if the last user message contains 'satisfied'
      const lastUserMessage = session.getMessagesByType('user').slice(-1)[0];
      if (!lastUserMessage) {
        return false;
      }
      const lastUserText = lastUserMessage.content;
      return lastUserText.toLowerCase().includes('satisfied');
    },
  )
  // Review the quiz in a sub‑routine and merge its summary back in
  .addSubroutine(
    new Sequence()
      .addSystem(
        'You are an educational coach. ' +
          "Write a three‑sentence summary of the learner's answers and suggest one topic for further study.",
      )
      .addAssistant(openAIgenerateOptions),
    {
      // initWith: pass the whole conversation
      initWith: (parent) => {
        // Create a new session with the same messages and context
        let clonedSession = createSession({
          context: parent.context,
        });

        // Add all messages from parent session
        parent.messages.forEach((msg) => {
          clonedSession = clonedSession.addMessage(msg);
        });

        return clonedSession;
      },
      // squashWith: merge the summary back into the parent conversation
      squashWith: (parent, child) => {
        const summary = child.getLastMessage();
        return summary
          ? parent.addMessage({
              type: 'assistant',
              content: `**Quiz Review:**\n${summary.content}`,
            })
          : parent;
      },
    },
  )
  .addAssistant('Quiz finished! 🚀');

const session = await quiz.execute(
  createSession({
    print: true,
  }),
);
```

### 🤖 Model Configuration

PromptTrail uses a unified approach to model configuration through `generateOptions`, which can be created with the `createGenerateOptions` function and passed to templates.

Configure models with provider-specific options:

```typescript
// OpenAI configuration
const openAIgenerateOptions = createGenerateOptions({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
  maxTokens: 1000,
});

// Anthropic configuration
const anthropicGenerateOptions = createGenerateOptions({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY,
    modelName: 'claude-3-5-haiku-latest',
  },
  temperature: 0.5,
});

// Anthropic with MCP integration
const anthropicMcpOptions = createGenerateOptions({
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
});
```

### 💾 Session Management

Manage conversation state with immutable sessions and in-place templating:

```typescript
// Create a session with context for templating
const session = createSession({
  context: {
    userId: 'user-123',
    language: 'TypeScript',
    tone: 'professional',
    topics: ['generics', 'type inference', 'utility types'],
  },
  print: true,
});

// Templates use ${variable} syntax for direct interpolation
const template = new Sequence()
  .addSystem(`I'll use \${tone} language to explain \${topics[0]}`)
  .addAssistant(`Let me explain \${topics[0]} in \${language}`)
  .addUser(`Can you also cover \${topics[1]}?`);

// Sessions are immutable - operations return new instances
const updatedSession = session.addMessage({
  type: 'user',
  content: 'Hello!',
});

// Query session state
const lastMessage = updatedSession.getLastMessage();
const userMessages = updatedSession.getMessagesByType('user');

// Update context (returns new session)
const newSession = updatedSession.setContextValues({
  tone: 'casual',
});

// Serialize/deserialize
const json = newSession.toJSON();
console.log('Session JSON:', json);
```

### 🌊 Streaming Responses

Process model responses in real-time:

```typescript
// Define session locally for this example
const session = createSession().addMessage({
  type: 'user',
  content: 'Explain streaming in 2 sentences.',
});

// Stream responses chunk by chunk
console.log('\nStreaming response:');
for await (const chunk of generateTextStream(session, openAIgenerateOptions)) {
  process.stdout.write(chunk.content);
}
console.log('\n--- End of Stream ---');
```

### 📊 Session-to-Context Conversion

Extract structured data from LLM outputs:

````typescript
// Create a template that extracts structured data from responses
const codeTemplate = new Sequence()
  .addSystem(
    "You're a TypeScript expert. Always include code examples in ```typescript blocks and use ## headings for sections.",
  )
  .addUser(
    'Write a function to calculate the factorial of a number with explanation.',
  )
  .addAssistant(openAIgenerateOptions)
  // Extract markdown headings and code blocks
  .addTransform((session) => {
    return extractMarkdown({
      headingMap: {
        Explanation: 'explanation',
        'Usage Example': 'usageExample',
      },
      codeBlockMap: { typescript: 'code' },
    }).transform(session);
  });

// Execute the template
const session = await codeTemplate.execute(createSession());

// Access the extracted data
console.log('Code:', session.context.code);
console.log('Explanation:', session.context.explanation);

// You can also extract data using regex patterns
const dataTemplate = new Sequence()
  .addUser('Server status: IP 192.168.1.100, Uptime 99.99%, Status: Running')
  .addTransform((session) => {
    return extractPattern([
      {
        pattern: /IP ([\d\.]+)/,
        key: 'ipAddress',
      },
      {
        pattern: /Uptime ([\d\.]+)%/,
        key: 'uptime',
        transform: (value) => parseFloat(value) / 100,
      },
    ]).transform(session);
  });

const dataSession = await dataTemplate.execute(createSession());
console.log('IP:', dataSession.context.ipAddress); // "192.168.1.100"
console.log('Uptime:', dataSession.context.uptime); // 0.9999
````

### 🛡️ Validation

Validate and ensure quality of both user input and LLM responses with a unified validation interface:

```typescript
// Create validators to ensure responses meet criteria
const singleWordValidator = new RegexMatchValidator({
  regex: /^[A-Za-z]+$/,
  description: 'Response must be a single word with only letters',
});

// Length validator
const lengthValidator = new LengthValidator({
  min: 3,
  max: 10,
  description: 'Response must be between 3 and 10 characters',
});

// Keyword validator
const appropriateValidator = new KeywordValidator({
  keywords: ['inappropriate', 'offensive'],
  mode: 'exclude',
  description: 'Response must not be inappropriate',
});

// Combine all validators with AND logic
const combinedValidator = new AllValidator(
  [singleWordValidator, lengthValidator, appropriateValidator],
  {
    description: 'Combined validation for pet names',
    maxAttempts: 3,
    raiseErrorAfterMaxAttempts: true,
  },
);

// Create a template that asks for a pet name with validation
const petNameTemplate = new Sequence()
  .addSystem('You are a helpful assistant that suggests pet names.')
  .addUser('Suggest a name for a pet cat.')
  // Add assistant with validator
  .addAssistant('Whiskers', combinedValidator);

// Execute the template
const session = await petNameTemplate.execute(createSession());

// Get the final response
console.log('Pet name:', session.getLastMessage()?.content);

// You can also use a custom validator with your own validation logic
const customValidator = new CustomValidator(
  (content, context) => {
    // Custom validation logic
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    return wordCount <= 5
      ? { isValid: true }
      : {
          isValid: false,
          instruction: `Your answer must be 5 words or less (current: ${wordCount} words)`,
        };
  },
  {
    description: 'Please provide a short answer (max 5 words)',
    maxAttempts: 3,
    raiseErrorAfterMaxAttempts: true,
  },
);

// Add a user input with validation - Replace CLISource for non-interactive execution
const userInputTemplate = new Sequence()
  .addSystem('You are a helpful assistant.')
  // Replace CLISource with a simple User message and apply validator in Assistant
  .addUser('This is my response with more than five words.')
  .addAssistant(openAIgenerateOptions, { validator: customValidator }); // Apply validator here
console.log('User input template created.');
```

### 🧩 Schema Validation

Force LLMs to produce structured outputs using schemas:

```typescript
import { z } from 'zod';

// Define a schema using Zod
const productSchema = z.object({
  name: z.string().describe('The name of the product'),
  price: z.number().describe('The price of the product in USD'),
  inStock: z.boolean().describe('Whether the product is in stock'),
  description: z.string().describe('A short description of the product'),
});

// Create a SchemaSource with the schema
const productSchemaSource = new SchemaSource(
  openAIgenerateOptions,
  productSchema,
  {
    functionName: 'extractProduct',
    maxAttempts: 3,
    raiseError: true,
  },
);

// Create a template with schema validation
const template = new Sequence()
  .addSystem('Extract product information from the text.')
  .addUser(
    'The new iPhone 15 Pro costs $999 and comes with a titanium frame. It is currently in stock.',
  )
  .addAssistant(productSchemaSource);

// Execute the template
const session = await template.execute(createSession());

// Get the structured output from the session context
const product = session.context.structured_output;
console.log(product);
// Output: { name: 'iPhone 15 Pro', price: 999, inStock: true, description: 'Smartphone with a titanium frame' }

// Access individual fields with proper typing
if (product && typeof product === 'object') {
  // Add type check before accessing properties
  console.log(`Product: ${product.name} - $${product.price}`);
  console.log(`In Stock: ${product.inStock ? 'Yes' : 'No'}`);
} else {
  console.log('Structured output not found or not an object.');
}
```

### 🛠️ Tool Integration

Extend LLM capabilities with function calling:

```typescript
import { z } from 'zod';

// Define a weather forecast tool
const weatherTool = tool({
  description: 'Get weather information',
  parameters: z.object({
    location: z.string().describe('Location to get weather information for'),
  }),
  execute: async (input: { location: string }) => {
    const location = input.location;
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

// Add the tool to generateOptions
const toolEnhancedOptions = openAIgenerateOptions
  .clone()
  .addTool('weather', weatherTool)
  .setToolChoice('auto');

const weatherTemplate = new Sequence()
  .addSystem("I'm a weather assistant.")
  .addUser("What's the weather like in New York?")
  .addAssistant(toolEnhancedOptions);

const session = await weatherTemplate.execute(createSession());
console.log(session.getLastMessage()?.content);
```

### 🔌 MCP Support

PromptTrail provides comprehensive support for Anthropic's Model Context Protocol (MCP), allowing Claude models to access external tools and resources like GitHub repositories, databases, or custom APIs through a standardized protocol.

```typescript
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
    apiKey: process.env.ANTHROPIC_API_KEY, // Ensure ANTHROPIC_API_KEY is in .env
    modelName: 'claude-3-5-haiku-latest',
  },
  temperature: 0.7,
}).addMCPServer({
  url: 'http://localhost:8080',
  name: 'research-mcp-server',
  version: '1.0.0',
});

// Generate response with MCP integration
try {
  const response = await generateText(session, options);
  console.log(response.content);
} catch (error) {
  console.error(
    'MCP Example Failed (This is expected if no MCP server is running at localhost:8080):',
    error.message,
  );
}
```

## 🌐 Browser Support

PromptTrail works in browser environments with a simple configuration flag:

```typescript
// Browser-compatible configuration
const browserOptions = createGenerateOptions({
  provider: {
    type: 'openai',
    apiKey: 'YOUR_API_KEY', // In production, fetch from your backend
    modelName: 'gpt-4o-mini',
    dangerouslyAllowBrowser: true, // Required for browser usage
  },
  temperature: 0.7,
});

// Use with templates as normal
const browserTemplate = new Sequence()
  .addSystem('You are a helpful assistant.')
  .addUser('Hello!')
  .addAssistant(browserOptions);
```

## 👥 Contributing

Contributions are welcome! Here's how you can help:

- 🐛 Report bugs by opening issues
- 💡 Suggest features and improvements
- 🧪 Run tests with `cd packages/core && pnpm exec vitest --run --watch=false`
- 🔀 Submit pull requests

## 📄 License

MIT - See [LICENSE](LICENSE) for details.
