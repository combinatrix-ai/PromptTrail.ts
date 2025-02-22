# PromptTrail

PromptTrail is a TypeScript library for building structured conversations with Large Language Models (LLMs). It provides a powerful template system and unified interface for working with different LLM providers like OpenAI and Anthropic.

## Features

- 🎯 **Template System**: Build complex conversation flows using composable templates
- 🔄 **Loop Support**: Create interactive conversations with conditional loops
- 🛠️ **Tool Integration**: Define and use tools (function calling) with LLMs
- 🔌 **Multiple LLM Providers**: Support for OpenAI and Anthropic (Claude) models
- 📝 **Metadata Management**: Attach and manage metadata for messages and sessions
- 🔄 **Streaming Support**: Stream responses from LLMs for real-time interactions
- 💪 **Type Safety**: Full TypeScript support with type inference

## Installation

```bash
pnpm add @prompttrail/core
```

## Quick Start

```typescript
import {
  LinearTemplate,
  SystemTemplate,
  UserTemplate,
  AssistantTemplate,
} from '@prompttrail/core';
import { OpenAIModel } from '@prompttrail/core';

// Initialize the LLM model
const model = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4',
});

// Create a conversation template
const template = new LinearTemplate()
  .addSystem("You're a helpful assistant.")
  .addUser('What is the capital of France?')
  .addAssistant({ llm: model });

// Execute the template
const session = createSession();
const result = await template.execute(session);
console.log(result.messages[result.messages.length - 1].content);
```

## Core Concepts

### Templates

Templates help you build conversation flows. Start simple and add complexity as needed:

```typescript
// Basic conversation
const basic = new LinearTemplate()
  .addUser('Hello!')
  .addAssistant({ llm: model });

// Multi-turn conversation
const complex = new LinearTemplate()
  .addSystem('You are a friendly assistant.')
  .addUser('Tell me about TypeScript.')
  .addAssistant({ llm: model })
  .addUser('Can you show an example?')
  .addAssistant({ llm: model });
```

### Models

Choose your LLM provider and customize settings:

```typescript
// OpenAI
const openai = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4',
  temperature: 0.7,  // Optional: control randomness
});

// Anthropic
const anthropic = new AnthropicModel({
  apiKey: process.env.ANTHROPIC_API_KEY,
  modelName: 'claude-3-haiku-20240307',
});
```

### Interactive Loops

Create dynamic conversations that can branch and repeat:

```typescript
const quiz = new LinearTemplate()
  .addSystem("You're a quiz bot.")
  .addLoop(
    new LoopTemplate()
      .addUser('Ask me a question about TypeScript')
      .addAssistant({ llm: model })
      .addUser('Here is my answer:', 'interfaces extend classes')
      .addAssistant({ llm: model })
      .addUser('Should we continue? (yes/no)', 'yes')
      .setExitCondition(
        (session) => 
          session.getLastMessage()?.content.toLowerCase() === 'no'
      )
  );
```

### Session Management

Track conversation state and metadata:

```typescript
// Simple session
const session = createSession();

// Session with custom metadata
interface UserPreferences {
  language: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
}

const customSession = createSession<UserPreferences>({
  metadata: {
    language: 'en',
    difficulty: 'beginner',
  },
});
```

### Streaming Support

Get real-time responses:

```typescript
const model = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4',
});

// Stream responses chunk by chunk
for await (const chunk of model.sendAsync(session)) {
  process.stdout.write(chunk.content);
}
```

### Tool Integration

Add capabilities to your LLM conversations:

```typescript
// Create a simple calculator tool
const calculator = new Tool({
  name: 'calculator',
  description: 'Add two numbers together',
  // Define the input schema for the LLM
  schema: {
    type: 'object',
    properties: {
      a: {
        type: 'number',
        description: 'First number to add'
      },
      b: {
        type: 'number',
        description: 'Second number to add'
      }
    },
    required: ['a', 'b']
  },
  // Implementation - TypeScript infers types from schema
  execute: async (input) => {
    return { result: input.a + input.b };
  }
});

// Use tools with your model
const modelWithTools = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4',
  tools: [calculator],
});

// Use in conversation
const template = new LinearTemplate()
  .addSystem("You're a math assistant.")
  .addUser("What's 123 + 456?")
  .addAssistant({ llm: modelWithTools });
```

## API Reference

Explore available features through your IDE:

- Hover over types and classes for documentation
- Use autocomplete to discover methods
- "Go to Definition" (F12) to see detailed API

Key types and classes:

```typescript
import {
  // Templates
  LinearTemplate,   // Basic conversation flow
  LoopTemplate,     // Conditional loops
  
  // Models
  OpenAIModel,      // OpenAI integration
  AnthropicModel,   // Anthropic integration
  
  // Session
  createSession,    // Start conversations
  
  // Tools
  Tool,            // Add capabilities
} from '@prompttrail/core';
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License
