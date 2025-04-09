# Comprehensive Refactoring Proposal for PromptTrail

## Executive Summary

This document outlines a comprehensive refactoring plan for the PromptTrail library, focusing on simplifying the API, improving developer experience, and enhancing maintainability. The proposal retains the core functionality while streamlining the implementation and making it more intuitive for developers to use.

## Implementation Strategy

We recommend a phased approach:

1. **Phase 1**: Rename and simplify content sources (as already started)
2. **Phase 2**: Restructure the template system
3. **Phase 3**: Enhance session and metadata handling
4. **Phase 4**: Improve tool integration and validation
5. **Phase 5**: Reorganize package structure

Each phase can be released as a minor version update, with deprecated APIs maintained for at least one release cycle to ensure smooth migration.

## Detailed Refactoring Proposals

### 1. Content Source Simplification

**Goal**: Simplify the naming and API of content sources

#### Implementation

```typescript
// Base content source class
abstract class Source<T = unknown> {
  protected validator?: Validator;
  protected maxAttempts: number;
  protected raiseError: boolean;

  constructor(options?: {
    validator?: Validator;
    maxAttempts?: number;
    raiseError?: boolean;
  }) {
    this.validator = options?.validator;
    this.maxAttempts = options?.maxAttempts ?? 1;
    this.raiseError = options?.raiseError ?? true;
  }

  abstract getContent(session: Session): Promise<T>;

  // Shared validation logic
  protected async validateContent(
    content: string,
    session: Session,
  ): Promise<ValidationResult> {
    if (!this.validator) return { isValid: true };

    let attempts = 0;
    let lastResult: ValidationResult | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;
      lastResult = await this.validator.validate(content, session);

      if (lastResult.isValid) return lastResult;

      if (attempts >= this.maxAttempts && this.raiseError) {
        throw new ValidationError(
          `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`,
          lastResult,
        );
      }
    }

    return lastResult || { isValid: false, instruction: 'Validation failed' };
  }
}

// Text-based sources
class TextSource extends Source<string> {
  // Implementation...
}

// Concrete implementations
class StaticSource extends TextSource {
  constructor(
    private content: string,
    options?: ValidationOptions,
  ) {
    super(options);
  }

  async getContent(session: Session): Promise<string> {
    const content = interpolateTemplate(this.content, session.metadata);
    return this.validateContent(content, session).then(() => content);
  }
}

// Model sources with rich output
class ModelSource extends Source<ModelOutput> {
  // Implementation...
}

// LLM implementation
class LlmSource extends ModelSource {
  constructor(
    private generateOptions: GenerateOptions,
    options?: ValidationOptions,
  ) {
    super(options);
  }

  async getContent(session: Session): Promise<ModelOutput> {
    // Implementation with shared validation
  }
}
```

### 2. Template System Restructuring

**Goal**: Create a more intuitive and composable template API

#### Implementation

```typescript
// Core template interface
interface Template<TIn = Record<string, unknown>, TOut = TIn> {
  execute(session?: Session<TIn>): Promise<Session<TOut>>;
}

// Base template with composition methods
abstract class BaseTemplate<TIn = Record<string, unknown>, TOut = TIn>
  implements Template<TIn, TOut>
{
  abstract execute(session?: Session<TIn>): Promise<Session<TOut>>;

  // Composition method
  then<TNext>(next: Template<TOut, TNext>): ComposedTemplate<TIn, TNext> {
    return new ComposedTemplate<TIn, TNext>([this, next]);
  }

  // Factory methods for common templates
  static system(content: string | Source<string>): SystemTemplate {
    return new SystemTemplate(content);
  }

  static user(content: string | Source<string>): UserTemplate {
    return new UserTemplate(content);
  }

  static assistant(
    content: string | Source<ModelOutput> | GenerateOptions,
  ): AssistantTemplate {
    return new AssistantTemplate(content);
  }

  // Flow control templates
  static if(
    condition: (session: Session) => boolean,
    thenTemplate: Template,
    elseTemplate?: Template,
  ): IfTemplate {
    return new IfTemplate({ condition, thenTemplate, elseTemplate });
  }

  static loop(
    bodyTemplate: Template,
    exitCondition: (session: Session) => boolean,
  ): LoopTemplate {
    return new LoopTemplate({ bodyTemplate, exitCondition });
  }
}

// Linear template composition
class Sequence extends BaseTemplate {
  constructor(private templates: Template[] = []) {
    super();
  }

  add(template: Template): this {
    this.templates.push(template);
    return this;
  }

  async execute(session?: Session): Promise<Session> {
    let currentSession = session || createSession();

    for (const template of this.templates) {
      currentSession = await template.execute(currentSession);
    }

    return currentSession;
  }

  // Convenience methods
  addSystem(content: string): this {
    return this.add(BaseTemplate.system(content));
  }

  addUser(content: string): this {
    return this.add(BaseTemplate.user(content));
  }

  addAssistant(content: string | GenerateOptions): this {
    return this.add(BaseTemplate.assistant(content));
  }
}

// Now called Sequence instead of LinearTemplate
const agent = new Sequence()
  .addSystem('You are a helpful assistant.')
  .addUser('Hello!')
  .addAssistant(generateOptions);
```

<!-- ### 3. Enhanced Session and Metadata

**Goal**: Provide a more intuitive session API while maintaining immutability

#### Implementation

```typescript
// Enhanced session interface
interface Session<T = Record<string, unknown>> {
  readonly messages: ReadonlyArray<Message>;
  readonly metadata: Metadata<T>;
  readonly print: boolean;

  // Basic operations
  withMessage(message: Message): Session<T>;
  withMetadata<U extends Record<string, unknown>>(metadata: U): Session<T & U>;

  // Convenience methods
  systemMessage(content: string): Session<T>;
  userMessage(content: string): Session<T>;
  assistantMessage(content: string, toolCalls?: ToolCall[]): Session<T>;

  // Metadata operations
  set<K extends keyof T>(key: K, value: T[K]): Session<T>;
  get<K extends keyof T>(key: K): T[K] | undefined;

  // Message operations
  getLastMessage(): Message | undefined;
  getLastMessageByType(type: MessageType): Message | undefined;
}

// Implementation
class SessionImpl<T extends Record<string, unknown>> implements Session<T> {
  constructor(
    public readonly messages: ReadonlyArray<Message> = [],
    public readonly metadata: Metadata<T> = createMetadata<T>(),
    public readonly print: boolean = false
  ) {}

  // Base operations
  withMessage(message: Message): Session<T> {
    // Logging for print mode
    if (this.print) {
      console.log(`${message.type}: ${message.content}`);
    }

    return new SessionImpl(
      [...this.messages, message],
      this.metadata,
      this.print
    );
  }

  // Message convenience methods
  systemMessage(content: string): Session<T> {
    return this.withMessage({
      type: 'system',
      content,
      metadata: createMetadata(),
    });
  }

  userMessage(content: string): Session<T> {
    return this.withMessage({
      type: 'user',
      content,
      metadata: createMetadata(),
    });
  }

  assistantMessage(content: string, toolCalls?: ToolCall[]): Session<T> {
    return this.withMessage({
      type: 'assistant',
      content,
      toolCalls,
      metadata: createMetadata(),
    });
  }

  // Other methods...
}

// Example usage
const session = createSession()
  .systemMessage("You are an AI assistant.")
  .userMessage("Hello, can you help me?")
  .set('lastQuery', 'help request');
``` -->

<!-- ### 4. Improved Validation System

**Goal**: Create a more composable and reusable validation system

#### Implementation

```typescript
// Validation result
interface ValidationResult {
  isValid: boolean;
  instruction?: string;
}

// Simple validator interface
interface Validator {
  validate(content: string, session: Session): Promise<ValidationResult>;
  description: string;
}

// Factory function for validators
function createValidator(
  validateFn: (content: string, session: Session) => Promise<ValidationResult>,
  description: string
): Validator {
  return {
    validate: validateFn,
    description,

    // Composition methods
    and(other: Validator): Validator {
      return createValidator(
        async (content, session) => {
          const result = await this.validate(content, session);
          if (!result.isValid) return result;
          return other.validate(content, session);
        },
        `${this.description} AND ${other.description}`
      );
    },

    or(other: Validator): Validator {
      return createValidator(
        async (content, session) => {
          const result = await this.validate(content, session);
          if (result.isValid) return result;
          return other.validate(content, session);
        },
        `${this.description} OR ${other.description}`
      );
    }
  };
}

// Common validators
const validators = {
  regex: (pattern: RegExp, description?: string) => createValidator(
    async (content) => ({
      isValid: pattern.test(content),
      instruction: pattern.test(content) ? undefined : `Content must match ${pattern}`
    }),
    description || `Match pattern: ${pattern}`
  ),

  jsonSchema: <T>(schema: z.ZodType<T>, description?: string) => createValidator(
    async (content) => {
      try {
        const data = JSON.parse(content);
        const result = schema.safeParse(data);
        return result.success
          ? { isValid: true }
          : { isValid: false, instruction: result.error.message };
      } catch (e) {
        return { isValid: false, instruction: "Invalid JSON" };
      }
    },
    description || "Match JSON schema"
  ),

  length: (options: { min?: number, max?: number }) => createValidator(
    async (content) => {
      const length = content.length;
      let isValid = true;
      let instruction = "";

      if (options.min !== undefined && length < options.min) {
        isValid = false;
        instruction = `Content must be at least ${options.min} characters`;
      }

      if (options.max !== undefined && length > options.max) {
        isValid = false;
        instruction = `Content must be at most ${options.max} characters`;
      }

      return { isValid, instruction };
    },
    `Length: ${options.min || 0} to ${options.max || '∞'}`
  )
};
``` -->

<!-- ### 5. Enhanced Tool Integration

**Goal**: Simplify tool definition, registration, and execution

#### Implementation

```typescript
// Tool definition interface
interface Tool<TArgs = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TArgs>;
  execute: (args: TArgs) => Promise<TResult>;
}

// Tool registry for managing tools
class ToolRegistry {
  private tools = new Map<string, Tool>();

  // Register a tool
  register<TArgs, TResult>(tool: Tool<TArgs, TResult>): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  // Execute a tool by name
  async execute<TResult = unknown>(
    name: string,
    args: Record<string, unknown>
  ): Promise<TResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    // Validate arguments
    const parsedArgs = tool.parameters.safeParse(args);
    if (!parsedArgs.success) {
      throw new Error(`Invalid arguments: ${parsedArgs.error.message}`);
    }

    // Execute the tool
    return tool.execute(parsedArgs.data) as Promise<TResult>;
  }

  // Get tool definitions for the model
  getDefinitions(): Record<string, unknown>[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.parameters)
    }));
  }
}

// Enhanced GenerateOptions with tool registry
class GenerateOptions {
  private toolRegistry = new ToolRegistry();

  // Other options...

  // Add a tool to the registry
  addTool<TArgs, TResult>(tool: Tool<TArgs, TResult>): this {
    this.toolRegistry.register(tool);
    return this;
  }

  // Get tool definitions for the model
  getToolDefinitions(): Record<string, unknown>[] {
    return this.toolRegistry.getDefinitions();
  }

  // Execute a tool
  async executeTool<TResult = unknown>(
    name: string,
    args: Record<string, unknown>
  ): Promise<TResult> {
    return this.toolRegistry.execute(name, args);
  }
}

// Helper function for creating tools
function createTool<TArgs, TResult>({
  name,
  description,
  parameters,
  execute
}: {
  name: string;
  description: string;
  parameters: z.ZodType<TArgs>;
  execute: (args: TArgs) => Promise<TResult>;
}): Tool<TArgs, TResult> {
  return { name, description, parameters, execute };
}

// Example usage
const calculatorTool = createTool({
  name: 'calculator',
  description: 'Perform arithmetic operations',
  parameters: z.object({
    a: z.number().describe('First number'),
    b: z.number().describe('Second number'),
    operation: z.enum(['add', 'subtract', 'multiply', 'divide'])
               .describe('Operation to perform')
  }),
  execute: async ({ a, b, operation }) => {
    switch (operation) {
      case 'add': return a + b;
      case 'subtract': return a - b;
      case 'multiply': return a * b;
      case 'divide': return a / b;
    }
  }
});

const options = createGenerateOptions({/*...*/})
  .addTool(calculatorTool);
``` -->

### 6. Result-based Error Handling

**Goal**: Improve error handling throughout the library

#### Implementation

```typescript
// Result type for better error handling
type Result<T> = { success: true; value: T } | { success: false; error: Error };

// Helper function for async operations
async function tryAsync<T>(promise: Promise<T>): Promise<Result<T>> {
  try {
    const value = await promise;
    return { success: true, value };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

// Error types
class ValidationError extends Error {
  constructor(
    message: string,
    public readonly result?: ValidationResult,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

class GenerationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

// Usage in generate function
async function generateText(
  session: Session,
  options: GenerateOptions,
): Promise<Result<Message>> {
  // Preparation
  const prepResult = await tryAsync(prepareGenerateRequest(session, options));
  if (!prepResult.success) {
    return prepResult;
  }

  // API call
  const apiResult = await tryAsync(callModelApi(prepResult.value));
  if (!apiResult.success) {
    return apiResult;
  }

  // Processing
  return tryAsync(processModelResponse(apiResult.value));
}

// Usage in client code
const result = await generateText(session, options);
if (result.success) {
  const message = result.value;
  // Do something with the message
} else {
  // Handle error
  console.error(`Generation failed: ${result.error.message}`);
}
```

### 7. Package Structure Reorganization

**Goal**: Improve code organization and maintainability

#### Directory Structure

```
packages/
  core/
    src/
      session/         # Session management
        index.ts       # Public API
        session.ts     # Session implementation
        metadata.ts    # Metadata implementation

      template/        # Templates
        index.ts       # Public API
        base.ts        # Template interface and base class
        message.ts     # Message templates (System, User, Assistant)
        flow.ts        # Flow control templates (If, Loop)
        composed.ts    # Composition templates (Sequence, Parallel)

      source/          # Content sources
        index.ts       # Public API
        base.ts        # Source base classes
        text.ts        # Text sources
        model.ts       # Model sources

      validator/       # Validators
        index.ts       # Public API
        base.ts        # Validator interface and result types
        text.ts        # Text validators
        schema.ts      # Schema validators

      generate/        # Model generation
        index.ts       # Public API
        options.ts     # Generate options
        generate.ts    # Generate functions

      tool/            # Tool integrations
        index.ts       # Public API
        base.ts        # Tool interface
        registry.ts    # Tool registry

      util/            # Utilities
        index.ts       # Public API
        result.ts      # Result type
        async.ts       # Async utilities
        template.ts    # Template interpolation
```

#### Module Boundaries

- Each subdirectory exports a well-defined public API
- Internal implementation details are not exported
- Circular dependencies are eliminated
- Clear separation of concerns between modules

#### Public API

```typescript
// index.ts - Main public API
export * from './session';
export * from './template';
export * from './source';
export * from './validator';
export * from './generate';
export * from './tool';

// Export only what's needed from utils
export { Result, tryAsync } from './util/result';
```

## Migration Strategy

1. **Create New APIs**: Implement the new APIs alongside existing ones
2. **Add Deprecation Notices**: Mark old APIs as deprecated with guidance on migration
3. **Provide Migration Utilities**: Create helper functions to convert between old and new formats
4. **Documentation**: Create comprehensive migration guides and examples
5. **Incremental Adoption**: Allow gradual adoption of new APIs in existing codebases

### Example Migration Guide

```typescript
// Old way
const template = new LinearTemplate()
  .addSystem('You are an assistant.')
  .addUser('Hello!')
  .addAssistant(generateOptions);

// New way
const template = new Sequence()
  .addSystem('You are an assistant.')
  .addUser('Hello!')
  .addAssistant(generateOptions);

// Or using factory methods
const template = BaseTemplate.system('You are an assistant.')
  .then(BaseTemplate.user('Hello!'))
  .then(BaseTemplate.assistant(generateOptions));
```

## Conclusion

This comprehensive refactoring proposal aims to significantly improve the developer experience while maintaining the core functionality of the PromptTrail library. By simplifying the API, reducing complexity, and improving code organization, the library will be more maintainable, more intuitive for new users, and more powerful for advanced use cases.

The proposed changes maintain backward compatibility through careful deprecation and migration strategies, allowing existing users to adopt the new APIs gradually. The end result will be a more cohesive, consistent, and user-friendly library that better serves its users' needs.
