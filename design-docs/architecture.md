# PromptTrail Architecture

## Core Components

### 1. Tool

Type-safe function execution with schema validation.

```typescript
interface Tool<TSchema extends SchemaType, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: TSchema;
  execute(input: InferSchemaType<TSchema>): Promise<ToolResult<TOutput>>;
}

// Tool creation with type inference
const calculator = createTool({
  name: 'calculator',
  description: 'Add two numbers',
  schema: {
    properties: {
      a: { type: 'number', description: 'First number' },
      b: { type: 'number', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
  execute: async (input) => input.a + input.b,
});
```

### 2. Model

The foundation for LLM interactions.

```typescript
interface ModelConfig {
  modelName: string;
  temperature?: number;
  tools?: Tool[]; // Tools available to the model
  // Other model-specific settings
}

class Model {
  // Base class for model implementations
  constructor(config: ModelConfig) {}
  addTool(tool: Tool): Model; // Chain-friendly tool addition
  async send(session: Session): Promise<Message>;
  async *sendAsync(): AsyncGenerator<Message>;
  // Other model capabilities
}

// Example implementations
class OpenAIModel extends Model {
  constructor(config: OpenAIConfig) {
    super({
      modelName: config.modelName,
      temperature: config.temperature,
      apiKey: config.apiKey,
    });
  }
}

class AnthropicModel extends Model {
  constructor(config: AnthropicConfig) {
    super({
      modelName: config.modelName,
      temperature: config.temperature,
      apiKey: config.apiKey,
    });
  }
}
```

### 3. Template

Core building block for conversation flows, with support for metadata interpolation.

```typescript
abstract class Template {
  /**
   * Helper method to interpolate content with session metadata
   * Supports ${variable} syntax with nested paths (e.g., ${user.name})
   */
  protected interpolateContent(content: string, session: Session): string;

  abstract execute(session: Session): Promise<Session>;
}

// Example: Template with metadata interpolation
interface ProjectContext {
  user: { name: string; role: string };
  project: { name: string; language: string };
}

const template = new LinearTemplate()
  .addSystem("I'm helping with ${project.name}")
  .addAssistant("Hi ${user.name}, I see you're working on ${project.language}") // Context with interpolation
  .addUser({ inputSource: new CLIInputSource() }) // Get real user input
  .addAssistant("I understand you're a ${user.role}. Let me help with that.") // Predefined response
  .addUser('Please explain the code') // Impersonate user
  .addAssistant({ model }); // Let model generate response

const session = await template.execute(
  createSession<ProjectContext>({
    metadata: {
      user: { name: 'Alice', role: 'developer' },
      project: { name: 'AwesomeApp', language: 'TypeScript' },
    },
  }),
);

// System message template
class SystemTemplate extends Template {
  constructor(options: { content: string }) {}
  async execute(session: Session): Promise<Session>;
}

// User input template
class UserTemplate extends Template {
  constructor(options: {
    description: string;
    default?: string;
    inputSource?: InputSource;
    validate?: (input: string) => Promise<boolean>;
  }) {}
  async execute(session: Session): Promise<Session>;
}

// Assistant response template
class AssistantTemplate extends Template {
  constructor(options: { model?: Model; content?: string }) {}
  async execute(session: Session): Promise<Session>;
}

// Linear sequence of templates
class LinearTemplate extends Template {
  addSystem(content: string): this;
  addUser(
    description: string,
    defaultValue?: string,
    options?: {
      inputSource?: InputSource;
      validate?: (input: string) => Promise<boolean>;
    },
  ): this;
  addAssistant(options?: { model?: Model }): this;
  addLoop(loop: LoopTemplate): this;
  async execute(session: Session): Promise<Session>;
}

// Looping sequence of templates
class LoopTemplate extends Template {
  addUser(
    description: string,
    defaultValue?: string,
    options?: {
      inputSource?: InputSource;
    },
  ): this;
  addAssistant(options?: { model?: Model }): this;
  setExitCondition(condition: (session: Session) => boolean): this;
  async execute(session: Session): Promise<Session>;
}

// Nested conversation template
class SubroutineTemplate extends Template {
  constructor(options: {
    template: Template;
    initWith: (parentSession: Session) => Session;
    squashWith?: (parentSession: Session, childSession: Session) => Session;
  }) {}
  async execute(session: Session): Promise<Session>;
}
```

### 4. Session

Immutable state container with strict validation.

```typescript
interface SessionOptions<T> {
  messages?: Message[];
  metadata?: T;
  print?: boolean; // Enable conversation flow printing
}

class Session<T extends Record<string, unknown>> {
  // Core properties
  readonly messages: Message[];
  readonly metadata: Metadata<T>;
  readonly print: boolean; // Print conversation flow

  // Example usage with print mode
  session = createSession({
    print: true, // Enable conversation flow printing
  });

  devSession = createSession<ProjectContext>({
    metadata: {
      user: { name: 'Alice', role: 'developer' },
    },
    print: true, // See template interpolation in action
  });

  // Print mode will automatically log messages:
  // System: [content]
  // User: [content]
  // Assistant: [content]

  // Immutable updates
  addMessage(message: Message): Session<T>;
  updateMetadata<U>(metadata: U): Session<T & U>;

  // Message operations
  getMessagesByType<U extends Message['type']>(type: U): Message[];
  getLastMessage(): Message | undefined;

  // Validation & Serialization
  validate(): void;
  toJSON(): Record<string, unknown>;
  static fromJSON(json: Record<string, unknown>): Session;
}
```

### 5. Metadata

Type-safe key-value store.

```typescript
class Metadata<T extends Record<string, unknown>> {
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  toObject(): T;
  // Other metadata operations
}
```

### 6. Message

Core message types and utilities.

```typescript
type MessageType = 'system' | 'user' | 'assistant';

interface Message {
  type: MessageType;
  content: string;
  metadata: Metadata;
}

// Message creation utilities
function createSystemMessage(content: string): Message;
function createUserMessage(content: string): Message;
function createAssistantMessage(content: string): Message;
```

### 7. InputSource

Abstract input handling.

```typescript
interface InputSource {
  getInput(description: string): Promise<string>;
  close(): void;
}

// Implementations
class CLIInputSource implements InputSource { ... }
class CallbackInputSource implements InputSource { ... }
```

## Flow Examples

### 1. Basic Chat

```typescript
const inputSource = new CLIInputSource();
const model = new OpenAIModel({
  modelName: 'gpt-4o-mini',
  temperature: 0.7,
  apiKey: process.env.OPENAI_API_KEY,
});

const chat = new LinearTemplate().addSystem("I'm a helpful assistant").addLoop(
  new LoopTemplate()
    .addUser("What's on your mind?", '', { inputSource })
    .addAssistant({ model })
    .setExitCondition((session) => {
      const lastMessage = session.getMessagesByType('user').slice(-1)[0];
      return lastMessage?.content.toLowerCase().trim() === 'exit';
    }),
);

const session = await chat.execute(createSession());
```

### 2. Tool Integration

```typescript
// Create a calculator tool
const calculator = createTool({
  name: 'calculator',
  description: 'Perform calculations',
  schema: {
    properties: {
      expression: {
        type: 'string',
        description: 'Math expression to evaluate',
      },
    },
    required: ['expression'],
  },
  execute: async (input) => eval(input.expression),
});

// Create model with tool
const mathModel = new OpenAIModel({
  modelName: 'gpt-4o-mini',
  temperature: 0.7,
  tools: [calculator],
});

// Create chat template
const mathChat = new LinearTemplate()
  .addSystem("I'm a math assistant with calculation abilities")
  .addLoop(
    new LoopTemplate()
      .addUser('What would you like to calculate?', '', { inputSource })
      .addAssistant({ model: mathModel }),
  );

const session = await mathChat.execute(
  createSession({
    metadata: { mode: 'math' },
  }),
);
```

### 3. Nested Conversations

```typescript
// Code review template
const codeReview = new LinearTemplate()
  .addSystem('I am a code review expert')
  .addUser('Here is the code to review:', '', { inputSource })
  .addAssistant({ model: reviewModel })
  .addUser('Any security concerns?', '', { inputSource })
  .addAssistant({ model: securityModel });

// Main development flow
const mainFlow = new LinearTemplate()
  .addSystem('I am a development assistant')
  .addLoop(
    new LoopTemplate()
      .addUser('What would you like to do?', '', { inputSource })
      .addAssistant({ model })
      .addIf({
        condition: (session) =>
          session.getLastMessage()?.content.includes('review'),
        then: new SubroutineTemplate({
          template: codeReview,
          initWith: (session) =>
            createSession({
              metadata: {
                fileType: detectFileType(session.getLastMessage()?.content),
                severity: 'low',
              },
            }),
          squashWith: (parentSession, childSession) => {
            const severity = childSession.metadata.get('severity');
            return parentSession
              .addMessage(
                createSystemMessage(
                  `Code review completed with ${severity} severity`,
                ),
              )
              .updateMetadata({
                lastReviewSeverity: severity,
                reviewCount:
                  (parentSession.metadata.get('reviewCount') || 0) + 1,
              });
          },
        }),
      }),
  );

const session = await mainFlow.execute(createSession());
```

## Key Features

1. **Type Safety**

   - Full TypeScript support
   - Metadata type inference
   - Strict message validation

2. **Template Interpolation**

   - Dynamic content using ${variable} syntax
   - Support for nested object paths
   - Type-safe metadata access
   - Automatic empty string fallback for undefined values

3. **Immutability**

   - Session state changes create new instances
   - Predictable state management
   - Thread-safe operations

4. **Flexibility**

   - Multiple model support
   - Custom input sources
   - Extensible template system

5. **Developer Experience**
   - Builder pattern API
   - Built-in debugging
   - Clear error messages

## Best Practices

1. **Session Management**

   - Always validate sessions before use
   - Handle metadata types explicitly
   - Use immutable updates

2. **Error Handling**

   - Validate input before sending to models
   - Handle model errors gracefully
   - Provide clear error messages

3. **Performance**

   - Reuse templates when possible
   - Clean up resources (close input sources)
   - Handle large conversations efficiently

4. **Template Design**
   - Keep templates focused and composable
   - Pass dependencies explicitly
   - Use SubroutineTemplate for complex flows
