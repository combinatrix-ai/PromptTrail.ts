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
      b: { type: 'number', description: 'Second number' }
    },
    required: ['a', 'b']
  },
  execute: async (input) => input.a + input.b
});
```

### 2. Model
The foundation for LLM interactions.

```typescript
interface ModelConfig {
  modelName: string;
  temperature?: number;
  tools?: Tool[];  // Tools available to the model
  // Other model-specific settings
}
class Model {
  // Base class for model implementations
  constructor(config: ModelConfig) {}
  addTool(tool: Tool): Model;  // Chain-friendly tool addition
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
      apiKey: config.apiKey
    });
  }
}

class AnthropicModel extends Model {
  constructor(config: AnthropicConfig) {
    super({
      modelName: config.modelName,
      temperature: config.temperature,
      apiKey: config.apiKey
    });
  }
}

// Example usage with tools
const weatherTool = createTool({
  name: 'weather_forecast',
  description: 'Get weather forecast for location',
  schema: {
    properties: {
      location: { type: 'string', description: 'Location name' },
      date: { type: 'string', description: 'Forecast date' }
    },
    required: ['location']
  },
  execute: async (input) => ({ forecast: 'sunny' })
});

const model = new OpenAIModel({
  modelName: 'gpt-4o-mini',
  temperature: 0.7,
  apiKey: process.env.OPENAI_API_KEY
})
.addTool(weatherTool);  // Add tool capabilities
class AnthropicModel extends Model { ... }
```

### 2. Agent
High-level interface for conversation management.

```typescript
interface AgentConfig {
  debug?: boolean;  // Enables console logging of all messages
  model: Model | ModelConfig;  // Model instance or config
  inputSource?: InputSource;  // Optional custom input source
}

class Agent<T extends Record<string, unknown> = Record<string, unknown>> {
  constructor(config: AgentConfig) {}
  
  // Builder pattern for conversation setup
  addSystem(content: string): Agent<T>;
  addUser(description: string, defaultValue?: string): Agent<T>;
  addAssistant(options?: { model?: Model }): Agent<T>;
  addLoop(loop: LoopTemplate): Agent<T>;
  
  // Initialize with context and type-safe metadata
  initWith(options: {
    context?: string;
    metadata?: T;
  }): Agent<T>;
  
  // Start conversation
  async start(): Promise<Session<T>>;
}

// Example: CLI chat with validation (based on chat.ts)
const inputSource = new CLIInputSource();
const model = new OpenAIModel({
  modelName: 'gpt-4o-mini',
  temperature: 0.7,
  apiKey: process.env.OPENAI_API_KEY
});

const agent = new Agent({
  debug: true,  // Replaces LoggingSession
  model,
  inputSource
})
.addSystem('You are a helpful AI assistant')
.addLoop(
  new LoopTemplate()
    .addUser('Your message (type "exit" to end):', '', {
      validate: async (input) => {
        if (!input.trim()) {
          console.log('Please enter a message');
          return false;
        }
        return true;
      }
    })
    .addAssistant()
    .setExitCondition(session => {
      const lastMessage = session.getMessagesByType('user').slice(-1)[0];
      return lastMessage?.content.toLowerCase().trim() === 'exit';
    })
);

// Start chat
const session = await agent.start();
```

### 3. Session
Immutable state container with strict validation.

```typescript
interface SessionOptions<T> {
  messages?: Message[];
  metadata?: T;
}

class Session<T extends Record<string, unknown>> {
  // Core properties
  readonly messages: Message[];
  readonly metadata: Metadata<T>;
  
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

### 4. Metadata
Type-safe key-value store.

```typescript
class Metadata<T extends Record<string, unknown>> {
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  toObject(): T;
  // Other metadata operations
}
```

### 5. Message
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

### 6. InputSource
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
const agent = new Agent({
  debug: true,
  model: 'gpt-4o-mini'
})
  .addSystem("I'm a helpful assistant")
  .addLoop(
    new LoopTemplate()
      .addUser("What's on your mind?")
      .addAssistant()
  )
  .initWith({
    metadata: { tone: 'casual' }
  });

const session = await agent.start();
```
### 2. Tool Integration
```typescript
// Create a calculator tool
const calculator = createTool({
  name: 'calculator',
  description: 'Perform calculations',
  schema: {
    properties: {
      expression: { type: 'string', description: 'Math expression to evaluate' }
    },
    required: ['expression']
  },
  execute: async (input) => eval(input.expression)
});

// Use tool with model
const agent = new Agent({
  debug: true,
  model: {
    name: 'gpt-4o-mini',
    temperature: 0.7,
    tools: [calculator]  // Make tool available to model
  }
})
  .addSystem("I'm a math assistant with calculation abilities")
  .addLoop(
    new LoopTemplate()
      .addUser("What would you like to calculate?")
      .addAssistant()  // Model can use calculator tool here
  )
  .initWith({
    metadata: { mode: 'math' }
  });

const session = await agent.start();
```

### 3. Template Control Flow
```typescript
// Conditional template for branching conversations
class IfTemplate extends Template {
  constructor(options: {
    condition: (session: Session) => boolean;
    then: Template;
    else?: Template;
  }) {}
}

// Example: Different tools per template
const mathModel = new OpenAIModel(config).addTool(tools.calculator);
const weatherModel = new OpenAIModel(config).addTool(tools.weather);

const agent = new Agent({
  debug: true,
  model: new OpenAIModel(config)  // Base model without tools
})
.addSystem('I can help with math and weather')
.addLoop(
  new LoopTemplate()
    .addUser('What would you like to know?')
    .addIf({
      condition: session => session.getLastMessage()?.content.includes('calculate'),
      then: new AssistantTemplate({ model: mathModel }),  // Use calculator tool
      else: new IfTemplate({
        condition: session => session.getLastMessage()?.content.includes('weather'),
        then: new AssistantTemplate({ model: weatherModel }),  // Use weather tool
        else: new AssistantTemplate()  // Use base model
      })
    })
    .setExitCondition(session =>
      session.getLastMessage()?.content === 'exit'
    )
);
```

### 4. Model Specialization
```typescript
// Create specialized models for different tasks
const codeModel = new OpenAIModel({
  modelName: 'gpt-4o-mini',
  temperature: 0.1,  // More precise for code
  tools: [tools.linter, tools.formatter]
});

const explainerModel = new AnthropicModel({
  modelName: 'claude-3-5-haiku-latest',
  temperature: 0.7,  // More creative for explanations
});

// Use different models for different parts of conversation
const agent = new Agent({
  debug: true,
  model: new OpenAIModel(config)  // Default model
})
.addSystem('I can help write and explain code')
.addLoop(
  new LoopTemplate()
    .addUser('What would you like to do?')
    .addAssistant({ model: codeModel })  // Generate code with tools
    .addUser('Can you explain this code?')
    .addAssistant({ model: explainerModel })  // Explain with different model
    .setExitCondition(session =>
      session.getLastMessage()?.content === 'exit'
    )
);
```

### 5. Advanced Tool Integration
```typescript
// Define tool-aware metadata
interface ToolingMetadata {
  activeTools: string[];  // Currently enabled tools
  preferences: {
    language: string;
    style: 'formal' | 'casual';
    debug: boolean;
  };
}

// Create multiple tools
const tools = {
  calculator: createTool({
    name: 'calculator',
    description: 'Perform calculations',
    schema: {
      properties: {
        expression: { type: 'string', description: 'Math expression' }
      },
      required: ['expression']
    },
    execute: async (input) => eval(input.expression)
  }),
  
  weather: createTool({
    name: 'weather',
    description: 'Get weather forecast',
    schema: {
      properties: {
        location: { type: 'string', description: 'Location name' }
      },
      required: ['location']
    },
    execute: async (input) => ({ forecast: 'sunny' })
  })
};

// Create base model with all tools
const model = new OpenAIModel({
  modelName: 'gpt-4o-mini',
  temperature: 0.7,
  apiKey: process.env.OPENAI_API_KEY
})
.addTool(tools.calculator)
.addTool(tools.weather);

// Create agent with tool-aware metadata
const agent = new Agent<ToolingMetadata>({
  debug: true,
  model,
  inputSource: new CLIInputSource()
})
.addSystem(`
  You are an AI assistant with multiple capabilities:
  - Perform calculations
  - Check weather forecasts
  Choose the appropriate tool based on user requests.
`)
.addLoop(
  new LoopTemplate()
    .addUser('What can I help you with? (type "exit" to end)')
    .addAssistant()
    .setExitCondition(session => {
      const lastMessage = session.getMessagesByType('user').slice(-1)[0];
      return lastMessage?.content.toLowerCase().trim() === 'exit';
    })
)
.initWith({
  metadata: {
    activeTools: ['calculator', 'weather'],
    preferences: {
      language: 'en',
      style: 'casual',
      debug: true
    }
  }
});

// Start multi-tool conversation
const session = await agent.start();
```

### 6. Nested Conversations
```typescript
// Template for running nested conversations
class SubroutineTemplate extends Template {
  constructor(options: {
    template: Template;  // Template to run as subroutine
    init_with: (parentSession: Session) => Session;  // Transform parent session for subroutine
    squash_with: (parentSession: Session, childSession: Session) => Session;  // Merge results back
  }) {}
}

// Example: Code review conversation within larger development chat
interface ReviewMetadata {
  fileType: string;
  severity: 'low' | 'medium' | 'high';
}

// Create review subroutine
const codeReviewTemplate = new LinearTemplate()
  .addSystem('You are a code review expert')
  .addUser('Here is the code to review:')
  .addAssistant({ model: reviewModel })
  .addUser('Any security concerns?')
  .addAssistant({ model: securityModel });

// Use subroutine in main conversation
const agent = new Agent({
  debug: true,
  model: new OpenAIModel(config)
})
.addSystem('I am a development assistant')
.addLoop(
  new LoopTemplate()
    .addUser('What would you like to do?')
    .addAssistant()
    .addIf({
      condition: session => session.getLastMessage()?.content.includes('review'),
      then: new SubroutineTemplate({
        template: codeReviewTemplate,
        // Initialize subroutine session with relevant metadata
        init_with: (parentSession) => {
          const lastMessage = parentSession.getLastMessage();
          return createSession<ReviewMetadata>({
            metadata: {
              fileType: detectFileType(lastMessage?.content),
              severity: 'low'
            }
          });
        },
        // Merge review results back to parent conversation
        squash_with: (parentSession, childSession) => {
          const reviewResult = childSession.getLastMessage();
          const severity = childSession.metadata.get('severity');
          return parentSession
            .addMessage(createSystemMessage(
              `Code review completed with ${severity} severity`
            ))
            .addMessage(reviewResult)
            .updateMetadata({
              lastReviewSeverity: severity,
              reviewCount: (parentSession.metadata.get('reviewCount') || 0) + 1
            });
        }
      })
    })
    .setExitCondition(session =>
      session.getLastMessage()?.content === 'exit'
    )
);

// Example: Nested conversation with shared context
interface SharedContext {
  projectId: string;
  userRole: string;
  preferences: Record<string, unknown>;
}

const setupChildSession = (parentSession: Session<SharedContext>) => {
  // Keep only relevant metadata for child conversation
  const { projectId, preferences } = parentSession.metadata.toObject();
  return createSession({
    metadata: { projectId, preferences }
  });
};

const mergeChildResults = (
  parentSession: Session<SharedContext>,
  childSession: Session
) => {
  // Keep parent context but add child conversation results
  const relevantMessages = childSession
    .getMessagesByType('assistant')
    .slice(-2);  // Last two assistant responses
  
  return relevantMessages.reduce(
    (session, message) => session.addMessage(message),
    parentSession
  );
};
```

## Key Features

1. **Type Safety**
   - Full TypeScript support
   - Metadata type inference
   - Strict message validation

2. **Immutability**
   - Session state changes create new instances
   - Predictable state management
   - Thread-safe operations

3. **Flexibility**
   - Multiple model support
   - Custom input sources
   - Extensible template system

4. **Developer Experience**
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