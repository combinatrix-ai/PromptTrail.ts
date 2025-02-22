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
  temperature: 0.7,
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

## Advanced Features

### Interactive Loops

Create conversations that can loop based on conditions:

```typescript
const template = new LinearTemplate()
  .addSystem("You're a math teacher bot.")
  .addLoop(
    new LoopTemplate()
      .addUser("Let's ask a question:", "Why can't you divide by zero?")
      .addAssistant({ llm: model })
      .addAssistant('Are you satisfied?')
      .addUser('Input:', 'Yes.')
      .addAssistant('If satisfied, answer END. Otherwise, RETRY.')
      .addAssistant({ llm: model })
      .setExitCondition(
        (session) => session.getLastMessage()?.content.includes('END') ?? false,
      ),
  );
```

### Tool Integration

Define and use tools with LLMs:

```typescript
const calculatorTool = {
  name: 'calculator',
  description: 'A simple calculator that can add two numbers',
  schema: {
    type: 'object',
    properties: {
      a: { type: 'number', description: 'First number' },
      b: { type: 'number', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
  execute: async (input: { a: number; b: number }) => {
    return { result: input.a + input.b };
  },
};

const modelWithTools = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4',
  temperature: 0.7,
  tools: [calculatorTool],
});
```

### Session Management

Handle conversation state and metadata:

```typescript
// Create a session with custom metadata
type CustomMetadata = {
  userId: string;
  settings: {
    language: string;
  };
};

const session = createSession<CustomMetadata>({
  metadata: {
    userId: 'user123',
    settings: { language: 'en' },
  },
});

// Add messages to session
const newSession = session.addMessage({
  type: 'user',
  content: 'Hello!',
  metadata: createMetadata(),
});
```

### Streaming Responses

Stream responses for real-time interactions:

```typescript
const model = new AnthropicModel({
  apiKey: process.env.ANTHROPIC_API_KEY,
  modelName: 'claude-3-haiku-20240307',
});

for await (const chunk of model.sendAsync(session)) {
  process.stdout.write(chunk.content);
}
```

## API Reference

### Templates

- `LinearTemplate`: Create sequential conversation flows
- `LoopTemplate`: Create conditional loops in conversations
- `SystemTemplate`: Define system messages
- `UserTemplate`: Define user messages
- `AssistantTemplate`: Define assistant responses

### Models

- `OpenAIModel`: Interface with OpenAI models
- `AnthropicModel`: Interface with Anthropic Claude models

### Session Management

- `createSession()`: Create a new conversation session
- `Session.addMessage()`: Add a message to the session
- `Session.updateMetadata()`: Update session metadata
- `Session.getMessagesByType()`: Get messages of a specific type

### Metadata

- `createMetadata()`: Create typed metadata containers
- `Metadata.set()`: Set metadata values
- `Metadata.get()`: Get metadata values
- `Metadata.merge()`: Merge multiple metadata objects

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License
