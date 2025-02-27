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
      mcpServers: config.mcpServers, // MCP server configurations
    });
  }

  // MCP integration methods
  private async initializeMcpClients(
    serverConfigs: MCPServerConfig[],
  ): Promise<void>;
  getAllTools(): Tool<SchemaType>[]; // Get all tools including MCP tools
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
  addIf(options: {
    condition: (session: Session) => boolean;
    thenTemplate: Template;
    elseTemplate?: Template;
  }): this;
  addTransformer(transformer: SessionTransformer<any, any>): this;
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

// Conditional template for branching logic
class IfTemplate extends Template {
  constructor(options: {
    condition: (session: Session) => boolean;
    thenTemplate: Template;
    elseTemplate?: Template;
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

### 8. SessionTransformer

Transforms sessions to extract structured data from LLM outputs.

```typescript
/**
 * Session transformer interface
 */
interface SessionTransformer<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> {
  transform(
    session: Session<TInput>,
  ): Promise<Session<TOutput>> | Session<TOutput>;
}

// Function-based transformers
type SessionTransformerFn<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> = (session: Session<TInput>) => Promise<Session<TOutput>> | Session<TOutput>;

// Create a transformer from a function
function createTransformer<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
>(
  transformFn: SessionTransformerFn<TInput, TOutput>,
): SessionTransformer<TInput, TOutput> {
  return {
    transform: (session) => transformFn(session),
  };
}

// Integration with templates
class LinearTemplate extends Template {
  // Add a transformer to the template sequence
  addTransformer<U extends Record<string, unknown>>(
    transformer: SessionTransformer<any, U>,
  ): this {
    this.templates.push(createTransformerTemplate(transformer));
    return this;
  }
}
```

### 9. Guardrails

Validation system for ensuring LLM responses meet quality criteria.

```typescript
/**
 * Interface for validator functions that check if a response meets certain criteria
 */
interface Validator {
  validate(content: string): Promise<ValidationResult>;
}

/**
 * Result of a validation operation
 */
interface ValidationResult {
  passed: boolean;
  score?: number;
  feedback?: string;
  fix?: string;
}

/**
 * Action to take when validation fails
 */
enum OnFailAction {
  EXCEPTION = 'exception', // Throw an exception
  RETRY = 'retry', // Retry with the model
  FIX = 'fix', // Apply the suggested fix
  CONTINUE = 'continue', // Continue despite the failure
}

/**
 * Template that applies guardrails to ensure responses meet quality criteria
 */
class GuardrailTemplate extends Template {
  constructor(options: {
    template: Template;
    validators: Validator[];
    onFail?: OnFailAction;
    maxAttempts?: number;
    onRejection?: (
      result: ValidationResult,
      content: string,
      attempt: number,
    ) => void;
  }) {}

  async execute(session: Session): Promise<Session>;
}

// Base validator class
abstract class BaseValidator implements Validator {
  abstract validate(content: string): Promise<ValidationResult>;

  protected createResult(
    passed: boolean,
    options?: {
      score?: number;
      feedback?: string;
      fix?: string;
    },
  ): ValidationResult;
}

// Example validators
class RegexMatchValidator extends BaseValidator {
  constructor(options: { regex: RegExp | string; description?: string }) {}

  async validate(content: string): Promise<ValidationResult>;
}

class KeywordValidator extends BaseValidator {
  constructor(options: {
    keywords: string[];
    mode: 'include' | 'exclude';
    description?: string;
    caseSensitive?: boolean;
  }) {}

  async validate(content: string): Promise<ValidationResult>;
}

class LengthValidator extends BaseValidator {
  constructor(options: { min?: number; max?: number; description?: string }) {}

  async validate(content: string): Promise<ValidationResult>;
}

// Composite validators
class AllValidator extends BaseValidator {
  constructor(validators: Validator[]) {}
  async validate(content: string): Promise<ValidationResult>;
}

class AnyValidator extends BaseValidator {
  constructor(validators: Validator[]) {}
  async validate(content: string): Promise<ValidationResult>;
}

// Model-based validators
class ModelValidator extends BaseValidator {
  constructor(options: {
    model: Model;
    prompt?: string;
    scoreThreshold?: number;
  }) {}

  async validate(content: string): Promise<ValidationResult>;
}

class ToxicLanguageValidator extends BaseValidator {
  constructor(options: {
    model: Model;
    threshold?: number;
    validationMethod?: 'full' | 'sentence';
  }) {}

  async validate(content: string): Promise<ValidationResult>;
}

// Create a guardrail transformer for session validation
function createGuardrailTransformer<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput & {
    guardrail: { passed: boolean; validationResults: ValidationResult[] };
  },
>(options: {
  validators: Validator[];
  messageTypes?: string[];
}): SessionTransformer<TInput, TOutput>;
```

### 11. Schema Validation

System for enforcing structured output from LLMs using schemas.

```typescript
/**
 * Schema property types
 */
type SchemaPropertyType = 'string' | 'number' | 'boolean';

/**
 * Schema property definition
 */
interface SchemaProperty {
  type: SchemaPropertyType;
  description: string;
}

/**
 * Schema definition
 */
interface Schema {
  properties: Record<string, SchemaProperty>;
  required?: string[];
}

/**
 * Create a schema definition
 */
function defineSchema(schema: Schema): Schema;

/**
 * Create a string property
 */
function createStringProperty(description: string): SchemaProperty;

/**
 * Create a number property
 */
function createNumberProperty(description: string): SchemaProperty;

/**
 * Create a boolean property
 */
function createBooleanProperty(description: string): SchemaProperty;

/**
 * Schema validation options
 */
interface SchemaValidationOptions<TModel extends Model = Model> {
  model: TModel;
  maxAttempts?: number;
  onValidationFail?: (error: Error, attempt: number) => void;
}

/**
 * Add schema validation to a template
 */
class LinearTemplate extends Template {
  /**
   * Add schema validation to ensure structured output
   * @param schema The schema to validate against (can be a native schema or a Zod schema)
   * @param options Options for schema validation
   */
  async addSchema<TSchema>(
    schema: TSchema | z.ZodType<any>,
    options: SchemaValidationOptions,
  ): Promise<this>;
}

/**
 * Schema validator for enforcing structured output
 */
class SchemaValidator {
  constructor(options: {
    schema: Schema | z.ZodType<any>;
    model: Model;
    maxAttempts?: number;
  });

  /**
   * Validate a response against the schema
   */
  async validate(content: string): Promise<any>;

  /**
   * Format the schema for the model
   */
  formatSchema(): string | object;
}
```

This feature is inspired by Zod-GPT but has been reimplemented and enhanced for PromptTrail with TypeScript-first design.

#### Specialized Extractors

```typescript
// Markdown extractor for headings and code blocks
function extractMarkdown<T extends Record<string, unknown>>(options: {
  messageTypes?: MessageRole[]; // Default to ['assistant']
  headingMap?: Record<string, keyof T>; // Map heading to metadata key
  codeBlockMap?: Record<string, keyof T>; // Map language to metadata key
}): SessionTransformer<Record<string, unknown>, Record<string, unknown> & T> {
  return createTransformer((session) => {
    // Implementation that extracts markdown sections and code blocks
    // and returns a new session with updated metadata
  });
}

// Pattern extractor for regex-based extraction
function extractPattern<T extends Record<string, unknown>>(
  options:
    | {
        pattern: RegExp | string;
        key: keyof T;
        transform?: (match: string) => unknown;
        defaultValue?: unknown;
      }
    | Array<{
        pattern: RegExp | string;
        key: keyof T;
        transform?: (match: string) => unknown;
        defaultValue?: unknown;
      }>,
): SessionTransformer<Record<string, unknown>, Record<string, unknown> & T> {
  return createTransformer((session) => {
    // Implementation that extracts data based on patterns
    // and returns a new session with updated metadata
  });
}
```

### 10. MCP Integration

Anthropic Model Context Protocol (MCP) integration for accessing external tools and resources.

```typescript
/**
 * MCP server configuration
 */
interface MCPServerConfig {
  url: string;
  name?: string;
  version?: string;
}

/**
 * MCP client wrapper for PromptTrail
 */
class MCPClientWrapper {
  constructor(config: MCPServerConfig) {}

  // Connection management
  async connect(): Promise<void>;
  async disconnect(): Promise<void>;

  // Tool management
  async loadTools(): Promise<Tool<SchemaType>[]>;
  getTool(name: string): Tool<SchemaType> | undefined;
  getAllTools(): Tool<SchemaType>[];

  // Resource management
  async readResource(uri: string): Promise<string>;
  async listResources(): Promise<
    { uri: string; name: string; description?: string }[]
  >;

  // Prompt management
  async getPrompt(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<{ role: string; content: string }[]>;
}

// Enhanced Anthropic configuration
interface AnthropicConfig extends ModelConfig {
  readonly apiKey: string;
  readonly apiBase?: string;
  readonly modelName: string;
  readonly temperature: number;
  readonly maxTokens?: number;
  readonly tools?: readonly Tool<SchemaType>[];
  readonly mcpServers?: MCPServerConfig[]; // MCP server configurations
}
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

### 4. Conditional Branching

```typescript
// Create a template with conditional branching
const conditionalTemplate = new LinearTemplate()
  .addSystem("I'm a programming assistant")
  .addUser('Help me with: ${task}')
  .addAssistant({ model })
  .addIf({
    condition: (session) =>
      session.getLastMessage()?.content.toLowerCase().includes('error'),
    thenTemplate: new LinearTemplate()
      .addSystem('Switching to debugging mode')
      .addUser('Please explain the error in detail')
      .addAssistant({ model }),
    elseTemplate: new LinearTemplate()
      .addSystem('Continuing with implementation')
      .addUser('Show me how to implement this')
      .addAssistant({ model }),
  });

// Execute with different tasks
const debugSession = await conditionalTemplate.execute(
  createSession({
    metadata: { task: "I'm getting a TypeError in my code" },
  }),
);
// Will execute the thenTemplate branch

const implementSession = await conditionalTemplate.execute(
  createSession({
    metadata: { task: 'I need to create a sorting algorithm' },
  }),
);
// Will execute the elseTemplate branch
```

### 5. Metadata Extraction

````typescript
// Extract code blocks from LLM responses
const codeTemplate = new LinearTemplate()
  .addSystem(
    "You're a TypeScript expert. Include code in ```typescript blocks.",
  )
  .addUser('Write a function to calculate the factorial of a number.')
  .addAssistant({ model })
  .addTransformer(
    extractMarkdown({
      codeBlockMap: { typescript: 'factorialCode' },
    }),
  )
  .addUser('Now optimize it for performance.')
  .addAssistant({ model })
  .addTransformer(
    extractMarkdown({
      codeBlockMap: { typescript: 'optimizedCode' },
    }),
  );

const session = await codeTemplate.execute(createSession());
console.log('Original code:', session.metadata.get('factorialCode'));
console.log('Optimized code:', session.metadata.get('optimizedCode'));

// Extract structured analysis from LLM responses
const analysisTemplate = new LinearTemplate()
  .addSystem("You're a code reviewer. Use ## headings for different sections.")
  .addUser('Analyze this function: function add(a,b) { return a+b; }')
  .addAssistant({ model })
  .addTransformer(
    extractMarkdown({
      headingMap: {
        Summary: 'summary',
        Strengths: 'strengths',
        Weaknesses: 'weaknesses',
        Suggestions: 'suggestions',
      },
    }),
  );

const session = await analysisTemplate.execute(createSession());
console.log('Analysis summary:', session.metadata.get('summary'));
console.log('Suggestions:', session.metadata.get('suggestions'));

// Extract data using regex patterns
const jsonTemplate = new LinearTemplate()
  .addSystem('Generate user profile data in JSON format')
  .addUser('Create a profile for a software developer')
  .addAssistant({ model })
  .addTransformer(
    extractPattern({
      pattern: /```json\n([\s\S]*?)\n```/,
      key: 'profile',
      transform: (json) => JSON.parse(json),
    }),
  );

const session = await jsonTemplate.execute(createSession());
const profile = session.metadata.get('profile');
console.log('Name:', profile.name);
console.log('Skills:', profile.skills);

// Custom transformer for specific needs
const customTransformer = createTransformer((session) => {
  const lastMessage = session.getLastMessage();
  if (lastMessage?.type === 'assistant') {
    // Extract specific data
    const data = processMessage(lastMessage.content);
    // Return updated session
    return session.updateMetadata({ extractedData: data });
  }
  return session;
});

// Chain multiple transformers
const template = new LinearTemplate()
  .addSystem("I'm a coding assistant")
  .addUser('Write a factorial function with explanation')
  .addAssistant({ model })
  .addTransformer(
    extractMarkdown({
      codeBlockMap: { typescript: 'code' },
    }),
  )
  .addTransformer(
    extractMarkdown({
      headingMap: { Explanation: 'explanation' },
    }),
  );
````

### 6. MCP Integration

```typescript
// Create an Anthropic model with MCP integration
const model = new AnthropicModel({
  apiKey: process.env.ANTHROPIC_API_KEY,
  modelName: 'claude-3-5-haiku-latest',
  temperature: 0.7,
  mcpServers: [
    {
      url: 'http://localhost:8080', // MCP server URL
      name: 'github-mcp-server',
      version: '1.0.0',
    },
  ],
});

// Create a template that uses the model with MCP tools
const template = new LinearTemplate()
  .addSystem(
    `You are a helpful assistant with access to external tools.
             You can use these tools when needed to provide accurate information.`,
  )
  .addUser('Can you check the latest commits in our repository?', '')
  .addAssistant({ model });

// Execute the template
const session = await template.execute(createSession());

// The model will automatically discover and use tools from the MCP server
// For example, it might use a git_list_commits tool to fetch commit information
```

### 7. Schema Validation

```typescript
// Create a model
const model = new AnthropicModel({
  apiKey: process.env.ANTHROPIC_API_KEY,
  modelName: 'claude-3-5-haiku-latest',
  temperature: 0.7,
});

// Define a schema using PromptTrail's native schema format
const productSchema = defineSchema({
  properties: {
    name: createStringProperty('The name of the product'),
    price: createNumberProperty('The price of the product in USD'),
    inStock: createBooleanProperty('Whether the product is in stock'),
    description: createStringProperty('A short description of the product'),
  },
  required: ['name', 'price', 'inStock'],
});

// Or define a schema using Zod
const userSchema = z.object({
  username: z.string().min(3).max(20).describe('Username (3-20 characters)'),
  email: z.string().email().describe('Valid email address'),
  age: z.number().int().min(18).max(120).describe('Age (must be 18 or older)'),
  roles: z.array(z.enum(['admin', 'user', 'moderator'])).describe('User roles'),
});

// Create a template with schema validation
const template = new LinearTemplate()
  .addSystem('Extract product information from the text.')
  .addUser(
    'The new iPhone 15 Pro costs $999 and comes with a titanium frame. It is currently in stock.',
  );

// Add schema validation
await template.addSchema(productSchema, { model, maxAttempts: 3 });

// Execute the template
const session = await template.execute(createSession());

// Get the structured output from the session metadata
const product = session.metadata.get('structured_output');
console.log(product);
// Output: { name: 'iPhone 15 Pro', price: 999, inStock: true, description: 'Smartphone with a titanium frame' }
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

5. **Structured Data Extraction**

   - Extract markdown sections and code blocks
   - Pattern-based extraction with regex
   - Transform free-form LLM outputs to structured data
   - Chain multiple transformers for complex extraction

6. **External Tool Integration**

   - Native function calling with OpenAI
   - Anthropic MCP support for external tools and resources
   - Automatic tool discovery and loading

7. **Developer Experience**
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

5. **Metadata Extraction**
   - Place transformers immediately after the messages they should process
   - Use multiple specialized transformers instead of one complex transformer
   - Provide default values for optional extractions
   - Document extraction patterns for reliable extraction
   - Leverage TypeScript's type system for type safety
