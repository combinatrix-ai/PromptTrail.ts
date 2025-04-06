# ContentSource Abstraction Proposal

## Overview

This proposal introduces a unified `ContentSource` abstraction to replace the current parallel mechanisms of `InputSource` and `GenerateOptions` in PromptTrail. This abstraction provides a more consistent interface for content generation across templates while maintaining type safety and proper metadata handling.

## Core Abstractions

```typescript
/**
 * Base interface for all content sources
 */
export abstract class ContentSource<T = unknown> {
  /**
   * Get content with session context
   * @param session Session context for content generation
   * @returns Promise resolving to content of type T
   */
  abstract getContent(session: ISession): Promise<T>;

  /**
   * Check if this content source has a validator
   * @returns True if a validator is available
   */
  hasValidator?(): boolean;

  /**
   * Get the validator associated with this content source
   * @returns The validator or undefined if no validator is set
   */
  getValidator?(): IValidator | undefined;
}

/**
 * For simple string content (like user inputs)
 */
export abstract class StringContentSource extends ContentSource<string> {
  // Returns plain string content
}

/**
 * Interface for AI model outputs with metadata and structured data
 */
export interface ModelContentOutput {
  content: string; // Plain text content
  toolCalls?: Array<{
    // Tool calls if any were made
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
  structuredOutput?: Record<string, unknown>; // Schema-based structured output
  metadata?: Record<string, unknown>; // Additional metadata to update in session
}

/**
 * For AI responses with rich outputs
 */
export abstract class ModelContentSource extends ContentSource<ModelContentOutput> {
  // Returns structured content with content, toolCalls, structuredOutput and metadata
}
```

## String Content Source Implementations

```typescript
/**
 * Static content source that returns the same content every time
 * Supports template interpolation with session metadata
 */
export class StaticContentSource extends StringContentSource {
  constructor(private content: string) {
    super();
  }

  async getContent(session: ISession): Promise<string> {
    // Support template interpolation
    return interpolateTemplate(this.content, session.metadata);
  }
}

/**
 * CLI input source that reads from command line
 */
export class CLIContentSource extends StringContentSource {
  private validator?: IValidator;
  private maxAttempts: number;
  private raiseError: boolean;

  constructor(
    private prompt: string,
    private defaultValue?: string,
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    super();
    // Setup validator logic
    if (
      validatorOrOptions &&
      typeof validatorOrOptions === 'object' &&
      !('validate' in validatorOrOptions)
    ) {
      this.validator = validatorOrOptions.validator;
      this.maxAttempts = validatorOrOptions.maxAttempts ?? 1;
      this.raiseError = validatorOrOptions.raiseError ?? true;
    } else {
      this.validator = validatorOrOptions as IValidator | undefined;
      this.maxAttempts = 1;
      this.raiseError = true;
    }
  }

  async getContent(session: ISession): Promise<string> {
    // CLI input logic with validation
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      let attempts = 0;
      let lastValidationError: string | undefined;

      while (attempts < this.maxAttempts) {
        attempts++;

        const input = await rl.question(this.prompt);
        const finalInput = input || this.defaultValue || '';

        if (!this.validator) {
          return finalInput;
        }

        const result = await this.validator.validate(finalInput, session);

        if (result.isValid) {
          return finalInput;
        }

        lastValidationError = result.instruction || 'Invalid input';
        console.log(
          `Input validation failed: ${lastValidationError}. Please try again.`,
        );

        if (attempts >= this.maxAttempts && this.raiseError) {
          throw new Error(
            `Input validation failed after ${attempts} attempts: ${lastValidationError}`,
          );
        }
      }

      return this.defaultValue || '';
    } finally {
      rl.close();
    }
  }

  hasValidator(): boolean {
    return !!this.validator;
  }

  getValidator(): IValidator | undefined {
    return this.validator;
  }
}

/**
 * Callback-based content source
 */
export class CallbackContentSource extends StringContentSource {
  private validator?: IValidator;
  private maxAttempts: number;
  private raiseError: boolean;

  constructor(
    private callback: (context: { metadata?: Metadata }) => Promise<string>,
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    super();
    // Setup validator logic
    if (
      validatorOrOptions &&
      typeof validatorOrOptions === 'object' &&
      !('validate' in validatorOrOptions)
    ) {
      this.validator = validatorOrOptions.validator;
      this.maxAttempts = validatorOrOptions.maxAttempts ?? 1;
      this.raiseError = validatorOrOptions.raiseError ?? true;
    } else {
      this.validator = validatorOrOptions as IValidator | undefined;
      this.maxAttempts = 1;
      this.raiseError = true;
    }
  }

  async getContent(session: ISession): Promise<string> {
    let attempts = 0;
    let lastValidationError: string | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;

      const input = await this.callback({ metadata: session.metadata });

      if (!this.validator) {
        return input;
      }

      const result = await this.validator.validate(input, session);

      if (result.isValid) {
        return input;
      }

      lastValidationError = result.instruction || 'Invalid input';

      if (attempts >= this.maxAttempts && this.raiseError) {
        throw new Error(
          `Input validation failed after ${attempts} attempts: ${lastValidationError}`,
        );
      }
    }

    return this.callback({ metadata: session.metadata });
  }

  hasValidator(): boolean {
    return !!this.validator;
  }

  getValidator(): IValidator | undefined {
    return this.validator;
  }
}
```

## Model Content Source Implementations

```typescript
/**
 * Basic model content generation
 */
export class BasicModelContentSource extends ModelContentSource {
  private validator?: IValidator;
  private maxAttempts: number;
  private raiseError: boolean;

  constructor(
    private generateOptions: GenerateOptions,
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    super();
    // Setup validator logic
    if (
      validatorOrOptions &&
      typeof validatorOrOptions === 'object' &&
      !('validate' in validatorOrOptions)
    ) {
      this.validator = validatorOrOptions.validator;
      this.maxAttempts = validatorOrOptions.maxAttempts ?? 1;
      this.raiseError = validatorOrOptions.raiseError ?? true;
    } else {
      this.validator = validatorOrOptions as IValidator | undefined;
      this.maxAttempts = 1;
      this.raiseError = true;
    }
  }

  async getContent(session: ISession): Promise<ModelContentOutput> {
    let attempts = 0;
    let lastValidationError: string | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;

      const response = await generateText(session, this.generateOptions);

      if (
        !this.validator ||
        response.type !== 'assistant' ||
        !response.content
      ) {
        return {
          content: response.content,
          toolCalls: response.toolCalls,
          metadata: response.metadata?.toObject(),
        };
      }

      const result = await this.validator.validate(response.content, session);

      if (result.isValid) {
        return {
          content: response.content,
          toolCalls: response.toolCalls,
          metadata: response.metadata?.toObject(),
        };
      }

      lastValidationError = result.instruction || 'Invalid content';

      if (attempts >= this.maxAttempts && this.raiseError) {
        throw new Error(
          `Content validation failed after ${attempts} attempts: ${lastValidationError}`,
        );
      }
    }

    const finalResponse = await generateText(session, this.generateOptions);

    return {
      content: finalResponse.content,
      toolCalls: finalResponse.toolCalls,
      metadata: finalResponse.metadata?.toObject(),
    };
  }

  hasValidator(): boolean {
    return !!this.validator;
  }

  getValidator(): IValidator | undefined {
    return this.validator;
  }
}

/**
 * Schema-based content generation
 */
export class SchemaModelContentSource<
  T extends Record<string, unknown>,
> extends ModelContentSource {
  constructor(
    private generateOptions: GenerateOptions,
    private schema: z.ZodType<T>,
    private options: {
      functionName?: string;
      maxAttempts?: number;
      raiseError?: boolean;
    } = {},
  ) {
    super();
  }

  async getContent(session: ISession): Promise<ModelContentOutput> {
    // Create a tool from the schema
    const schemaFunction = {
      name: this.options.functionName || 'generateStructuredOutput',
      description: 'Generate structured output according to schema',
      parameters: this.schema,
    };

    // Add the schema function as a tool
    const enhancedOptions = this.generateOptions
      .clone()
      .addTool(schemaFunction.name, schemaFunction)
      .setToolChoice('required'); // Force the model to use this tool

    // Generate response with retry logic
    let attempts = 0;
    let error: Error | null = null;

    while (attempts < (this.options.maxAttempts || 3)) {
      try {
        const response = await generateText(session, enhancedOptions);

        // Extract structured output from tool call
        if (response.toolCalls && response.toolCalls.length > 0) {
          const toolCall = response.toolCalls.find(
            (tc) => tc.name === schemaFunction.name,
          );

          if (toolCall) {
            // Validate against schema
            const result = this.schema.safeParse(toolCall.arguments);

            if (result.success) {
              // Return both text content and structured output
              return {
                content: response.content,
                toolCalls: response.toolCalls,
                structuredOutput: result.data,
                metadata: response.metadata?.toObject(),
              };
            } else if (this.options.raiseError !== false) {
              error = new Error(
                `Schema validation failed: ${result.error.message}`,
              );
            }
          }
        }

        attempts++;
      } catch (err) {
        error = err as Error;
        attempts++;
      }
    }

    if (error && this.options.raiseError !== false) {
      throw error;
    }

    // Return best effort if not raising errors
    const fallbackResponse = await generateText(session, this.generateOptions);
    return {
      content: fallbackResponse.content,
      toolCalls: fallbackResponse.toolCalls,
      metadata: fallbackResponse.metadata?.toObject(),
    };
  }
}
```

## Template Refactoring

Templates would be refactored to use the new ContentSource abstraction:

```typescript
/**
 * Base template class with proper generic typing
 */
export abstract class Template<
  TOutput = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  protected contentSource?: ContentSource<TOutput>;

  getContentSource(): ContentSource<TOutput> | undefined {
    return this.contentSource;
  }

  hasOwnContentSource(): boolean {
    return !!this.contentSource;
  }

  abstract execute(session?: ISession<TMetadata>): Promise<ISession<TMetadata>>;
}

/**
 * Message template for handling any message type
 */
export class MessageTemplate<
  TOutput = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends Template<TOutput, TMetadata> {
  constructor(
    private messageType: TMessage['type'],
    contentSource: ContentSource<TOutput>,
  ) {
    super();
    this.contentSource = contentSource;
  }

  async execute(session?: ISession<TMetadata>): Promise<ISession<TMetadata>> {
    if (!session) {
      session = createSession<TMetadata>();
    }

    if (!this.contentSource) {
      throw new Error('ContentSource is required for MessageTemplate');
    }

    const content = await this.contentSource.getContent(session);

    // Type-specific handling based on the content type
    if (typeof content === 'string') {
      return session.addMessage({
        type: this.messageType,
        content,
        metadata: createMetadata(),
      });
    } else if (this.isModelContentOutput(content)) {
      // Handle ModelContentOutput
      let updatedSession = session.addMessage({
        type: this.messageType,
        content: content.content,
        toolCalls: content.toolCalls,
        metadata: createMetadata(),
      });

      // Update session metadata if provided
      if (content.metadata) {
        updatedSession = updatedSession.updateMetadata(content.metadata as any);
      }

      // Add structured output to metadata if available
      if (content.structuredOutput) {
        updatedSession = updatedSession.updateMetadata({
          structured_output: content.structuredOutput,
        } as any);
      }

      return updatedSession;
    } else {
      // Handle other types of content
      throw new Error(`Unsupported content type: ${typeof content}`);
    }
  }

  // Type guard to check if content is ModelContentOutput
  private isModelContentOutput(content: any): content is ModelContentOutput {
    return (
      content &&
      typeof content === 'object' &&
      typeof content.content === 'string'
    );
  }
}

/**
 * System template for system messages
 */
export class SystemTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends MessageTemplate<string, TMetadata> {
  constructor(contentSource: ContentSource<string> | string) {
    // Convert string to StaticContentSource if needed
    const source =
      typeof contentSource === 'string'
        ? new StaticContentSource(contentSource)
        : contentSource;

    super('system', source);
  }
}

/**
 * User template for user messages
 */
export class UserTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends MessageTemplate<string, TMetadata> {
  constructor(contentSource: ContentSource<string> | string) {
    // Convert string to StaticContentSource if needed
    const source =
      typeof contentSource === 'string'
        ? new StaticContentSource(contentSource)
        : contentSource;

    super('user', source);
  }
}

/**
 * Assistant template for assistant messages
 */
export class AssistantTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TMetadata & {
    structured_output?: Record<string, unknown>;
  },
> extends MessageTemplate<ModelContentOutput, TOutput> {
  constructor(
    contentSource: ContentSource<ModelContentOutput> | GenerateOptions,
  ) {
    // Convert GenerateOptions to BasicModelContentSource if needed
    const source =
      contentSource instanceof ContentSource
        ? contentSource
        : new BasicModelContentSource(contentSource);

    super('assistant', source);
  }
}
```

## Composed Templates

The composed templates (Linear, Loop, etc.) would be updated to use the new ContentSource abstraction:

```typescript
/**
 * Linear template composition with fluent API
 */
export class LinearTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends ComposedTemplate<TMetadata> {
  constructor(options?: {
    templates?: Template<unknown, TMetadata>[];
    contentSource?: ContentSource<unknown>;
  }) {
    super();
    this.contentSource = options?.contentSource;

    // Add initial templates if provided
    if (options?.templates) {
      for (const template of options.templates) {
        this.addTemplate(template);
      }
    }
  }

  async execute(session?: ISession<TMetadata>): Promise<ISession<TMetadata>> {
    let currentSession = session ? session : createSession<TMetadata>();
    const ownContentSource = this.getContentSource();

    for (const template of this.templates) {
      // If template doesn't have its own content source but we do, provide ours
      if (!template.hasOwnContentSource() && ownContentSource) {
        // This requires a bit of type gymnastics in real implementation
        const templateWithSource = Object.create(template);
        templateWithSource.contentSource = ownContentSource;
        currentSession = await templateWithSource.execute(currentSession);
      } else {
        currentSession = await template.execute(currentSession);
      }
    }

    return currentSession;
  }
}
```

## Usage Examples

### Basic Conversation

```typescript
// Create a simple conversation
const template = new LinearTemplate()
  .addSystem("You're a helpful assistant.")
  .addUser(new CLIContentSource("What's your question? "))
  .addAssistant(
    new BasicModelContentSource(
      createGenerateOptions({
        provider: {
          type: 'openai',
          apiKey: process.env.OPENAI_API_KEY || '',
          modelName: 'gpt-4o-mini',
        },
      }),
    ),
  );

// Execute the template
const session = await template.execute();
```

### Schema-Based Structured Output

```typescript
// Define a schema
const userSchema = z.object({
  name: z.string().describe("User's full name"),
  age: z.number().describe("User's age"),
  interests: z.array(z.string()).describe("User's interests"),
});

// Create a template with schema-based output
const template = new LinearTemplate()
  .addSystem('You are a user profile generator.')
  .addUser('Generate a profile for a fictional user.')
  .addAssistant(
    new SchemaModelContentSource(
      createGenerateOptions({
        provider: {
          type: 'openai',
          apiKey: process.env.OPENAI_API_KEY || '',
          modelName: 'gpt-4o-mini',
        },
      }),
      userSchema,
      { functionName: 'generateUserProfile' },
    ),
  );

// Execute and access structured data with proper typing
const session = await template.execute();
const userProfile = session.metadata.get('structured_output');
// TypeScript knows userProfile has name, age, and interests properties
console.log(userProfile.name, userProfile.age, userProfile.interests);
```

## Implementation Plan

1. **Phase 1: Core Abstractions**

   - Create ContentSource, StringContentSource, and ModelContentSource base classes
   - Implement ModelContentOutput interface

2. **Phase 2: Content Source Implementations**

   - Implement StaticContentSource, CLIContentSource, CallbackContentSource
   - Implement BasicModelContentSource, SchemaModelContentSource

3. **Phase 3: Template Base Classes**

   - Update Template to use contentSource
   - Create MessageTemplate as base for message-type templates

4. **Phase 4: Template Implementations**

   - Refactor SystemTemplate, UserTemplate, and AssistantTemplate
   - Update constructors to handle both ContentSource and legacy inputs

5. **Phase 5: Composed Templates**

   - Update LinearTemplate, LoopTemplate, etc.
   - Ensure proper contentSource propagation

6. **Phase 6: Testing**
   - Create unit tests for all new classes
   - Update existing tests to use new abstractions

## Benefits

1. **Unified Interface**: One consistent abstraction for all content sources.
2. **Type Safety**: Different content types are handled appropriately through generics.
3. **Simplified Implementation**: Templates have a clearer, more consistent implementation.
4. **Extensibility**: Easy to add new content source types without changing templates.
5. **Improved Composability**: Content sources can be easily shared between templates.
6. **Unified Tooling**: Schema-based outputs use the same mechanisms as tool calls.
7. **Richer Response Handling**: Clear separation of content, tool calls, structured output, and metadata.
