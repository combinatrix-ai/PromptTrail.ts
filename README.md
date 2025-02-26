# 🚀 PromptTrail

A type-safe, composable framework for building structured LLM conversations with OpenAI and Anthropic models.

## 📋 Overview

PromptTrail provides a robust TypeScript framework for creating structured, type-safe interactions with Large Language Models. It enables developers to build complex conversation flows, implement tool usage, and manage chat state with full TypeScript support.

## ✨ Features

- 🔒 **Type-Safe** - Full TypeScript support with inference and generics
- 📝 **Template-Based** - Composable conversation building blocks
- 🔄 **Stateless Architecture** - Immutable sessions for predictable state management
- 🛠️ **Tool Integration** - First-class support for function calling
- 🔌 **Multi-Provider** - Works with OpenAI, Anthropic, and extensible for more
- 🌊 **Streaming Support** - Real-time response streaming
- 🧩 **Composable Patterns** - Mix and match templates for complex flows
- 📊 **Structured Data Extraction** - Extract and transform data from LLM outputs
- 🛡️ **Guardrails** - Validate and ensure quality of LLM responses
- 🌐 **Browser Compatible** - Works in both Node.js and browser environments

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
import { LinearTemplate, OpenAIModel, createSession } from '@prompttrail/core';

// Initialize model with your API key
const model = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4o-mini',
});

// Create a simple conversation template
const chat = new LinearTemplate()
  .addSystem("I'm a helpful assistant.")
  .addUser("What's TypeScript?")
  .addAssistant({ model });

// Execute the template
const session = await chat.execute(createSession());
console.log(session.getLastMessage()?.content);
```

## 📘 Usage

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
  .addAssistant({ model });

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

### 🔄 Interactive Loops

Create dynamic, branching conversations with loop templates:

```typescript
const quiz = new LinearTemplate()
  .addSystem("I'm your TypeScript quiz master!")
  .addLoop(
    new LoopTemplate()
      .addUser('Ready for a question?')
      .addAssistant({ model })
      .addUser('My answer:', 'interfaces are awesome!')
      .addAssistant({ model })
      .addUser('Another question? (yes/no)', 'yes')
      .setExitCondition(
        (session) => session.getLastMessage()?.content.toLowerCase() === 'no',
      ),
  );
```

### 🤖 Model Configuration

Configure models with provider-specific options:

```typescript
// OpenAI configuration
const gpt4 = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 1000,
});

// Anthropic configuration
const claude = new AnthropicModel({
  apiKey: process.env.ANTHROPIC_API_KEY,
  modelName: 'claude-3-5-haiku-latest',
  temperature: 0.5,
});
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
  .addAssistant("Let me explain ${topics[0]} in ${language}")
  .addUser("Can you also cover ${topics[1]}?");

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
for await (const chunk of model.sendAsync(session)) {
  process.stdout.write(chunk.content);
}
```

### 📊 Session-to-Metadata Conversion

Extract structured data from LLM outputs:

```typescript
import { 
  LinearTemplate, 
  OpenAIModel, 
  createSession, 
  extractMarkdown, 
  extractPattern 
} from '@prompttrail/core';

// Create a template that extracts structured data from responses
const codeTemplate = new LinearTemplate()
  .addSystem("You're a TypeScript expert. Always include code examples in ```typescript blocks and use ## headings for sections.")
  .addUser("Write a function to calculate the factorial of a number with explanation.")
  .addAssistant({ model })
  // Extract markdown headings and code blocks
  .addTransformer(extractMarkdown({
    headingMap: { 
      'Explanation': 'explanation',
      'Usage Example': 'usageExample'
    },
    codeBlockMap: { 'typescript': 'code' }
  }));

// Execute the template
const session = await codeTemplate.execute(createSession());

// Access the extracted data
console.log("Code:", session.metadata.get('code'));
console.log("Explanation:", session.metadata.get('explanation'));

// You can also extract data using regex patterns
const dataTemplate = new LinearTemplate()
  .addUser("Server status: IP 192.168.1.100, Uptime 99.99%, Status: Running")
  .addTransformer(extractPattern([
    {
      pattern: /IP ([\d\.]+)/,
      key: 'ipAddress'
    },
    {
      pattern: /Uptime ([\d\.]+)%/,
      key: 'uptime',
      transform: (value) => parseFloat(value) / 100
    }
  ]));

const dataSession = await dataTemplate.execute(createSession());
console.log("IP:", dataSession.metadata.get('ipAddress')); // "192.168.1.100"
console.log("Uptime:", dataSession.metadata.get('uptime')); // 0.9999
```

### 🛡️ Guardrails

Validate and ensure quality of LLM responses:

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
  OpenAIModel
} from '@prompttrail/core';

// Create validators to ensure responses meet criteria
const validators = [
  // Ensure response is a single word with only letters
  new RegexMatchValidator({
    regex: /^[A-Za-z]+$/,
    description: "Response must be a single word with only letters"
  }),
  
  // Ensure response is between 3 and 10 characters
  new LengthValidator({
    min: 3,
    max: 10,
    description: "Response must be between 3 and 10 characters"
  }),
  
  // Ensure response doesn't contain inappropriate words
  new KeywordValidator({
    keywords: ['inappropriate', 'offensive'],
    mode: 'exclude',
    description: "Response must not be inappropriate"
  })
];

// Combine all validators with AND logic
const combinedValidator = new AllValidator(validators);

// Create a guardrail template
const guardrailTemplate = new GuardrailTemplate({
  template: new AssistantTemplate({ model }),
  validators: [combinedValidator],
  onFail: OnFailAction.RETRY,
  maxAttempts: 3
});

// Create a template that asks for a pet name
const petNameTemplate = new LinearTemplate()
  .addSystem("You are a helpful assistant that suggests pet names.")
  .addUser("Suggest a name for a pet cat.");

// Execute the templates in sequence
let session = createSession();
session = await petNameTemplate.execute(session);
session = await guardrailTemplate.execute(session);

// Get the final response
console.log("Pet name:", session.getLastMessage()?.content);
```

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
        description: 'Operation to perform' 
      },
    },
    required: ['a', 'b', 'operation'],
  },
  execute: async (input) => {
    switch (input.operation) {
      case 'add': return { result: input.a + input.b };
      case 'subtract': return { result: input.a - input.b };
      case 'multiply': return { result: input.a * input.b };
      case 'divide': return { result: input.a / input.b };
    }
  },
});

// Use tools with models
const smartModel = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4o-mini',
  tools: [calculator],
});

const mathChat = new LinearTemplate()
  .addSystem("I can help with calculations.")
  .addUser("What's 123 * 456?")
  .addAssistant({ model: smartModel });
```

## 🌐 Browser Support

PromptTrail works in browser environments with a simple configuration flag:

```typescript
// Browser-compatible model initialization
const model = new OpenAIModel({
  apiKey: 'YOUR_API_KEY', // In production, fetch from your backend
  modelName: 'gpt-4o-mini',
  dangerouslyAllowBrowser: true, // Required for browser usage
});
```

For a complete React implementation, check out our [React Chat Example](examples/react-chat).

## 📚 API Reference

PromptTrail provides comprehensive TypeScript definitions with full documentation:

```typescript
import {
  // Templates
  LinearTemplate,   // Sequential conversation flow
  LoopTemplate,     // Conditional looping conversations
  
  // Models
  OpenAIModel,      // OpenAI API integration
  AnthropicModel,   // Anthropic API integration
  
  // Core utilities
  createSession,    // Session factory
  Tool,             // Function calling
  CLIInputSource,   // Command-line input
  
  // Data extraction
  extractMarkdown,  // Extract structured data from markdown
  extractPattern,   // Extract data using regex patterns
  createTransformer, // Create custom transformers
} from '@prompttrail/core';
```

Leverage TypeScript's IDE features for:
- 💡 Inline documentation
- ⚡ Type-aware autocomplete
- 🔍 Jump-to-definition navigation

## 👥 Contributing

Contributions are welcome! Here's how you can help:

- 🐛 Report bugs by opening issues
- 💡 Suggest features and improvements
- 🧪 Run tests with `cd packages/core && pnpm exec vitest --run --watch=false`
- 🔀 Submit pull requests

## 📄 License

MIT - See [LICENSE](LICENSE) for details.
