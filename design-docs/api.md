# PromptTrail.ts API Documentation

## Table of Contents

### Core APIs

- [Session](#session) - Immutable conversation state management
- [Agent](#agent-template-builder) - Fluent template composition builder
- [Source Classes](#source-classes) - Content generation sources
- [Template Classes](#template-classes) - Conversation flow templates

### Advanced Features

- [Structured Output & Variable Extraction](#structured-output--variable-extraction)
- [Middleware System](#middleware-system) - Request/response processing
- [Scenario API](#scenario-api-multi-step-conversations) - Multi-step conversations
- [Validation System](#validation-system) - Input/output validation

### Developer Tools

- [CLI and Debugging](#cli-and-debugging) - Development interface
- [Testing Support](#testing-and-development) - Mocking and utilities
- [Error Classes](#error-classes) - Error handling

### Reference

- [Type Definitions](#type-definitions-reference) - Complete type reference
- [Usage Examples](#usage-examples) - Real-world examples

---

## Overview

PromptTrail.ts is a TypeScript-first framework for building structured LLM conversations with type safety and composability. This document provides comprehensive API documentation for all major objects and classes.

## Core Objects

### Session

The immutable conversation state manager that holds messages and variables.

```typescript
class Session<TContext extends SessionContext = Record<string, any>, TMetadata extends MessageMetadata = Record<string, any>>

// Factory methods
Session.create<TContext, TMetadata>(options?: {
  context?: TContext;
  messages?: Message<MessageMetadata<TMetadata>>[];
  debug?: boolean;
  ui?: 'console' | 'ink' | 'auto';
  print?: boolean; // Backward compatibility - mapped to debug
}): Session<SessionContext<TContext>, MessageMetadata<TMetadata>>

// Convenience factory methods
Session.empty<TContext, TMetadata>(): Session<Vars<TContext>, Attrs<TMetadata>>
Session.debug<TContext, TMetadata>(options?: {
  context?: TContext;
  messages?: Message<MessageMetadata<TMetadata>>[];
  ui?: 'console' | 'ink' | 'auto'
}): Session<SessionContext<TContext>, MessageMetadata<TMetadata>>  // ✨ Debugging convenience: equivalent to Session.create({ debug: true, ...options })
Session.withContext<TContext>(context: TContext, options?: {
  messages?: Message<MessageMetadata<{}>>[],
  debug?: boolean
}): Session<SessionContext<TContext>, MessageMetadata<{}>>
Session.withMessages<TMetadata>(messages: Message<MessageMetadata<TMetadata>>[], options?: {
  context?: Record<string, unknown>;
  debug?: boolean
}): Session<SessionContext<{}>, MessageMetadata<TMetadata>>
Session.withContextAndMessages<TContext, TMetadata>(context: TContext, messages: Message<MessageMetadata<TMetadata>>[], options?: {
  debug?: boolean
}): Session<SessionContext<TContext>, MessageMetadata<TMetadata>>
Session.typed<TContext, TMetadata>(): TypedSessionBuilder<TContext, TMetadata>
Session.fromJSON<TContext, TMetadata>(json: any): Session<SessionContext<TContext>, MessageMetadata<TMetadata>>
```

**Methods:**

- `addMessage(message: Message<TMetadata>): Session<TContext, TMetadata>` - Add message and return new session
- `getVar<K>(key: K, defaultValue?: TContext[K]): TContext[K]` - Get variable value
- `withVar<K, V>(key: K, value: V): Session<TContext & {[P in K]: V}, TMetadata>` - Set variable
- `withContext<U>(context: U): Session<TContext & U, TMetadata>` - Set multiple context variables
- `withMetadataType<U>(): Session<TContext, MessageMetadata<U>>` - Add metadata type specification (type-only)
- `getLastMessage(): Message<TMetadata> | undefined` - Get last message
- `getMessagesByType<U>(type: U): Extract<Message<TMetadata>, {type: U}>[]` - Filter messages by type
- `validate(): void` - Validate session state
- `toJSON(): Record<string, unknown>` - Serialize to JSON
- `toString(): string` - Convert to string

**Properties:**

- `messages: readonly Message<TMetadata>[]` - Immutable message array
- `vars: TContext` - Session context variables
- `context: TContext` - Alias for vars (same object)
- `debug: boolean` - Debug/print flag
- `ui: 'console' | 'ink' | 'auto'` - UI mode for debug output
- `varsSize: number` - Variable count

**Usage Examples:**

```typescript
// Simple session creation
const session = Session.create({ context: { userName: 'Alice' } });

// Typed session creation
type UserContext = { userId: string; role: string };
const typedSession = Session.create<UserContext>({
  context: { userId: '123', role: 'admin' },
});

// Debug session with logging - convenient for development
const debugSession = Session.debug({
  context: { userName: 'Alice' },
  ui: 'console',
});
// Tip: You can easily switch Session.create() → Session.debug() to enable debugging

// Session with messages
const sessionWithMessages = Session.create({
  context: { userName: 'Alice' },
  messages: [{ type: 'system', content: 'Hello!' }],
});
```

---

## Source Classes

Content sources define where data comes from in templates.

### Source (Abstract Base)

```typescript
abstract class Source<T = unknown>
```

**Methods:**

- `abstract getContent(session: Session<any, any>): Promise<T>` - Get content with session context
- `hasValidator(): boolean` - Check if validator exists
- `getValidator(): IValidator | undefined` - Get validator instance

### LlmSource

LLM-powered content generation with fluent API.

```typescript
class LlmSource extends ModelSource
```

**Factory:**

```typescript
Source.llm(options?: Partial<LLMOptions>): LlmSource
```

**Provider Configuration:**

- `openai(config?: Partial<OpenAIProviderConfig>): LlmSource`
- `anthropic(config?: Partial<AnthropicProviderConfig>): LlmSource`
- `google(config?: Partial<GoogleProviderConfig>): LlmSource`

**Model Configuration:**

- `model(modelName: string): LlmSource`
- `apiKey(apiKey: string): LlmSource`

**Generation Parameters:**

- `temperature(value: number): LlmSource`
- `maxTokens(value: number): LlmSource`
- `topP(value: number): LlmSource`
- `topK(value: number): LlmSource`

**Tool Configuration:**

- `withTool(name: string, tool: unknown): LlmSource`
- `withTools(tools: Record<string, unknown>): LlmSource`
- `toolChoice(choice: 'auto' | 'required' | 'none'): LlmSource`

**Schema Support:**

- `withSchema<T>(schema: z.ZodType<T>, options?: {mode?: 'tool' | 'structured_output'; functionName?: string}): LlmSource`

**Validation:**

- `validate(validator: IValidator): LlmSource`
- `withMaxAttempts(attempts: number): LlmSource`
- `withRaiseError(raise: boolean): LlmSource`

**Browser Support:**

- `dangerouslyAllowBrowser(allow?: boolean): LlmSource`

**Debug/Testing:**

- `maxCalls(limit: number): LlmSource`
- `mock(): MockedLlmSource` - Create mocked version for testing

### CLISource

Command-line input source.

```typescript
class CLISource extends StringSource

// Factory
Source.cli(prompt?: string, defaultValue?: string, options?: ValidationOptions): CLISource
```

**Methods:**

- `prompt(text: string): CLISource` - Set prompt text
- `defaultValue(value: string): CLISource` - Set default value
- `validate(validator: IValidator): CLISource` - Add validation
- `withMaxAttempts(attempts: number): CLISource` - Set retry limit
- `withRaiseError(raise: boolean): CLISource` - Configure error handling

### LiteralSource

Static text content source.

```typescript
class LiteralSource extends StringSource

// Factory
Source.literal(content: string, options?: ValidationOptions): LiteralSource
```

**Methods:**

- `withContent(content: string): LiteralSource` - Set content
- `validate(validator: IValidator): LiteralSource` - Add validation

### CallbackSource

Custom function-based content source.

```typescript
class CallbackSource extends StringSource

// Factory
Source.callback(callback: (context: {context?: Vars}) => Promise<string>, options?: ValidationOptions): CallbackSource
```

**Methods:**

- `withCallback(callback: Function): CallbackSource` - Set callback function
- `validate(validator: IValidator): CallbackSource` - Add validation

### Other Sources

- `Source.random(contentList: string[], options?: ValidationOptions): RandomSource` - Random element from array
- `Source.list(contentList: string[], options?: ValidationOptions & { loop?: boolean }): ListSource` - Sequential elements from array with optional looping

---

## Template Classes

Templates define conversation structure and flow.

### Template (Interface)

```typescript
interface Template<
  TMetadata extends Attrs = Attrs,
  TContext extends Vars = Vars,
> {
  execute(
    session?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>>;
}
```

### TemplateBase (Abstract)

Base class for all templates with common functionality.

```typescript
abstract class TemplateBase<TMetadata extends Attrs = Attrs, TContext extends Vars = Vars>
```

**Methods:**

- `abstract execute(session?: Session<TContext, TMetadata>): Promise<Session<TContext, TMetadata>>`
- `getContentSource(): Source<unknown> | undefined` - Get content source

## Template Instantiation Methods

### Message Templates

#### System

**Instantiation Methods:**

1. **Direct instantiation**: `new System(contentOrSource: SystemContentInput)`
2. **🎯 Preferred: Agent method**: `agent.system(contentOrSource: SystemContentInput)` - Type-safe, inherits Agent's type parameters

```typescript
type SystemContentInput =
  | string
  | Source<string>
  | ((session: Session<any, any>) => Promise<string>);

class System<TMetadata extends Attrs = Attrs, TContext extends Vars = Vars>
constructor(contentOrSource: SystemContentInput)
```

#### User

**Instantiation Methods:**

1. **Direct instantiation**: `new User(content?, options?)`
2. **🎯 Preferred: Agent method**: `agent.user(content?, options?)` - Type-safe, inherits Agent's type parameters

```typescript
type UserContentInput =
  | string
  | string[]  // Sequential content with optional looping
  | { cli: string; defaultValue?: string }  // CLI input options
  | Source<string>
  | ((session: Session<any, any>) => Promise<string>);

class User<TMetadata extends Attrs = Attrs, TContext extends Vars = Vars>
constructor(content?: UserContentInput, options?: UserOptions)
```

#### Assistant

**Instantiation Methods:**

1. **Direct instantiation**: `new Assistant(content?, options?)`
2. **🎯 Preferred: Agent method**: `agent.assistant(content?, options?)` - Type-safe, inherits Agent's type parameters

```typescript
type AssistantContentInput =
  | LLMConfig  // Direct LLM configuration object
  | string     // Static response content
  | Source<ModelOutput>
  | ((session: Session<any, any>) => Promise<ModelOutput>);

class Assistant<TMetadata extends Attrs = Attrs, TContext extends Vars = Vars>
constructor(
  content?: AssistantContentInput,
  options?: AssistantOptions & ValidationOptions
)
```

### Composite Templates

#### Loop

**Instantiation Methods:**

1. **Direct instantiation**: `new Loop(options)`
2. **🎯 Preferred: Agent method**: `agent.loop(builderFn, loopIf, maxIterations?)` - Function-based with nested agent builder

```typescript
class Loop<TMetadata extends Attrs = Attrs, TContext extends Vars = Vars>
constructor(options: {
  bodyTemplate?: Template<any, any> | Template<any, any>[];
  loopIf?: (session: Session<TContext, TMetadata>) => boolean;
  maxIterations?: number;
})
```

**Methods:**

- `setBody(template: Template<any, any>): this` - Set loop body
- `setLoopIf(condition: Function): this` - Set continuation condition
- `setMaxIterations(max: number): this` - Set iteration limit

#### Sequence

**Instantiation Methods:**

1. **Direct instantiation**: `new Sequence(templates?: Template[])`
2. **🎯 Preferred: Agent method**: `agent.sequence(builderFn)` - Function-based with nested agent builder

```typescript
class Sequence<TMetadata extends Attrs = Attrs, TContext extends Vars = Vars>
constructor(templates?: Template<TMetadata, TContext>[])
```

#### Subroutine

**Instantiation Methods:**

1. **Direct instantiation**: `new Subroutine(template, options?)`
2. **🎯 Preferred: Agent method**: `agent.subroutine(builderFn, options?)` - Function-based with nested agent builder

```typescript
class Subroutine<TMetadata extends Attrs = Attrs, TContext extends Vars = Vars>
constructor(
  template: Template<TM, TC> | Template<TM, TC>[],
  options?: ISubroutineTemplateOptions<TM, TC>
)
```

#### Conditional

**Instantiation Methods:**

1. **Direct instantiation**: `new Conditional(options)`
2. **🎯 Preferred: Agent method**: `agent.conditional(condition, thenBuilderFn, elseBuilderFn?)` - Function-based with nested agent builders

```typescript
class Conditional<TMetadata extends Attrs = Attrs, TContext extends Vars = Vars>
constructor(options: {
  condition: (s: Session<TContext, TMetadata>) => boolean;
  thenTemplate: Template<TMetadata, TContext>;
  elseTemplate?: Template<TMetadata, TContext>;
})
```

#### Parallel

**Instantiation Methods:**

1. **Direct instantiation**: `new Parallel(options?)`
2. **🎯 Preferred: Agent method**: `agent.parallel(builderFn)` - Function-based with ParallelBuilder

```typescript
class Parallel<TMetadata extends Attrs = Attrs, TContext extends Vars = Vars>
constructor(options?: {
  sources?: Array<{ source: LlmSource; repetitions?: number }>;
  scoringFunction?: ScoringFunction<TContext, TMetadata>;
  strategy?: Strategy<TContext, TMetadata>;
})

// Used within Agent.parallel() method
class ParallelBuilder<TMetadata extends Attrs = Attrs, TContext extends Vars = Vars>
```

**ParallelBuilder Methods (used in Agent.parallel()):**

- `withSource(source: ParallelSourceInput, repetitions?: number): this` - Accepts LLMConfig or LlmSource
- `withSources(sources: Array<{ source: ParallelSourceInput; repetitions?: number }>): this`
- `withStrategy(strategy: 'keep_all' | 'best' | AggregationStrategy): this`
- `withAggregationFunction(scoringFunction: ScoringFunction): this`

**ParallelSourceInput Type:**

```typescript
type ParallelSourceInput = LLMConfig | LlmSource;
```

Where `LLMConfig` includes provider configuration and generation parameters like temperature, maxTokens, etc.

#### Transform

**Instantiation Methods:**

1. **Direct instantiation**: `new Transform(transformFn)`
2. **🎯 Preferred: Agent method**: `agent.transform(transformFn)` - Type-safe, inherits Agent's type parameters

```typescript
class Transform<TMetadata extends Attrs = Attrs, TContext extends Vars = Vars>
constructor(transform: (s: Session<TContext, TMetadata>) => Session<TContext, TMetadata>)
```

### 🎯 Recommended Instantiation Patterns

**For type safety and better developer experience, prefer Agent methods over direct instantiation:**

✅ **Preferred (Function-based with Agent):**

```typescript
const agent = Agent.create<MyVars, MyAttrs>()
  .system('Hello')
  .user('Question?')
  .assistant()
  .conditional(
    (s) => s.getVar('isAdmin'),
    (a) => a.system('Admin mode').assistant(),
    (a) => a.system('User mode').assistant(),
  );
```

❌ **Avoid (Direct instantiation with type issues):**

```typescript
// Type error: new User<any, any> doesn't match Agent<MyVars, MyAttrs>
const agent = Agent.create<MyVars, MyAttrs>()
  .then(new User('Question?'))  // ❌ Type mismatch
  .then(new Conditional({...})) // ❌ Type mismatch
  .then(new Parallel({...}));   // ❌ Type mismatch
```

**Why Agent methods are preferred:**

- **Type inheritance**: Agent methods automatically inherit the correct type parameters
- **No type casting needed**: Direct instantiation creates `Template<any, any>` which doesn't match typed Agents
- **Better intellisense**: IDE provides better autocompletion and error detection
- **Cleaner syntax**: Function-based builders are more readable and composable

---

## Agent (Template Builder)

Fluent API for building complex template compositions.

```typescript
class Agent<TContext extends SessionContext = Record<string, any>, TMetadata extends MessageMetadata = Record<string, any>>
```

**Static Factories:**

- `Agent.create<TContext, TMetadata>(): Agent<TContext, TMetadata>`
- `Agent.system<TContext, TMetadata>(content: string): Agent<TContext, TMetadata>`
- `Agent.user<TContext, TMetadata>(contentOrSource?: string | Source<string>): Agent<TContext, TMetadata>`
- `Agent.assistant<TContext, TMetadata>(contentOrSource?, validatorOrOptions?): Agent<TContext, TMetadata>`

**Template Building:**

- `add(template: Template<TMetadata, TContext>): Agent<TContext, TMetadata>` - Add any template
- `then(template: Template<TMetadata, TContext>): Agent<TContext, TMetadata>` - Alias for add()

**Message Builders:**

- `system(content: SystemContentInput): Agent<TContext, TMetadata>` - Add system message
- `user(content?: UserContentInput, options?: UserOptions): Agent<TContext, TMetadata>` - Add user message
- `assistant(content?: AssistantContentInput, options?: AssistantOptions): Agent<TContext, TMetadata>` - Add assistant message
- `extract(schema: z.ZodType, config?: LLMConfig): Agent<TContext, TMetadata>` - Extract with auto-mapping (all fields)
- `extract(schema: z.ZodType, mapping: boolean | string | string[] | Record<string, string>, config?: LLMConfig): Agent<TContext, TMetadata>` - Extract with custom mapping

**Composite Template Builders:**

- `conditional(condition, thenBuilderFn, elseBuilderFn?): Agent<TContext, TMetadata>` - Add conditional with nested agents
- `transform(transform): Agent<TContext, TMetadata>` - Add transform
- `loop(builderFn, loopIf, maxIterations?): Agent<TContext, TMetadata>` - Add loop with nested agent
- `loopForever(builderFn): Agent<TContext, TMetadata>` - Add infinite loop with nested agent
- `subroutine(builderFn, options?): Agent<TContext, TMetadata>` - Add subroutine with nested agent
- `sequence(builderFn): Agent<TContext, TMetadata>` - Add sequence with nested agent
- `parallel(builderFn): Agent<TContext, TMetadata>` - Add parallel execution with ParallelBuilder

**Execution:**

- `build(): Template<TMetadata, TContext>` - Build final template
- `execute(session?: Session<TContext, TMetadata>): Promise<Session<TContext, TMetadata>>` - Execute agent
- `stream(session?: Session<TContext, TMetadata>): AsyncGenerator<Session<TContext, TMetadata>>` - Stream execution results
- `validate(): void` - Validate the agent configuration

---

## Vars and Attrs (Tagged Records)

Type-safe immutable containers for session variables and message metadata.

### Vars

```typescript
type Vars<T extends Record<string, unknown> = {}> = Readonly<T> & {
  readonly [varsBrand]: void;
};

// Factory function
function Vars<T>(v: T): Vars<T>;
```

**Namespace Methods:**

- `Vars.create<T>(v: T): Vars<T>` - Create vars object
- `Vars.is(x: unknown): x is Vars<any>` - Type guard
- `Vars.set<M, U>(vars: Vars<M>, patch: Pick<M, U>): Vars<M>` - Update existing keys
- `Vars.extend<M, U>(vars: Vars<M>, patch: U): Vars<M & U>` - Add/update keys

### Attrs

```typescript
type Attrs<T extends Record<string, unknown> = {}> = Readonly<T> & {
  readonly [attrsBrand]: void;
};

// Factory function
function Attrs<T>(v: T): Attrs<T>;
```

**Namespace Methods:**

- `Attrs.create<T>(v: T): Attrs<T>` - Create attrs object
- `Attrs.is(x: unknown): x is Attrs<any>` - Type guard
- `Attrs.set<M, U>(attrs: Attrs<M>, patch: Pick<M, U>): Attrs<M>` - Update existing keys
- `Attrs.extend<M, U>(attrs: Attrs<M>, patch: U): Attrs<M & U>` - Add/update keys

---

## Message Types

### Message Interfaces

```typescript
type MessageRole = 'system' | 'user' | 'assistant' | 'tool_result';

interface BaseMessage<TMetadata extends Attrs = Attrs> {
  content: string;
  attrs?: TMetadata;
  structuredContent?: Record<string, unknown>;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
}

interface SystemMessage<TMetadata extends Attrs = Attrs>
  extends BaseMessage<TMetadata> {
  type: 'system';
}

interface UserMessage<TMetadata extends Attrs = Attrs>
  extends BaseMessage<TMetadata> {
  type: 'user';
}

interface AssistantMessage<TMetadata extends Attrs = Attrs>
  extends BaseMessage<TMetadata> {
  type: 'assistant';
}

interface ToolResultMessage<TMetadata extends Attrs = Attrs>
  extends BaseMessage<TMetadata> {
  type: 'tool_result';
}

type Message<TMetadata extends Attrs = Attrs> =
  | SystemMessage<TMetadata>
  | UserMessage<TMetadata>
  | AssistantMessage<TMetadata>
  | ToolResultMessage<TMetadata>;
```

### Message Utilities

```typescript
const Message = {
  create<M>(type: MessageRole, content: string, attrs?: M): Message<M>
  seTMetadata<M>(message: Message<M>, attrs: M): Message<M>
  expandAttrs<M, U>(message: Message<Attrs<M>>, attrs: U): Message<Attrs<M & U>>
  setStructuredContent<M, S>(message: Message<M>, content: S): Message<M>
  setContent<M>(message: Message<M>, content: string): Message<M>
  system<M>(content: string, attrs?: M): Message<M>
  user<M>(content: string, attrs?: M): Message<M>
  assistant<M>(content: string, attrs?: M): Message<M>
}
```

---

## Validation System

### IValidator Interface

```typescript
interface IValidator {
  validate(content: string, context: Session): Promise<TValidationResult>;
  getDescription(): string;
  getErrorMessage(): string;
}

type TValidationResult =
  | { isValid: true }
  | { isValid: false; instruction: string };
```

### Validation Namespace

Factory methods for creating validators:

```typescript
namespace Validation {
  // Text validators
  regex(pattern: string | RegExp, options?: RegexOptions): IValidator
  keyword(keywords: string | string[], options?: KeywordOptions): IValidator
  length(options: LengthOptions): IValidator

  // Structure validators
  json(options?: {schema?: Record<string, unknown>; description?: string}): IValidator
  schema<T>(schema: SchemaType<T>, description?: string): IValidator

  // Custom validators
  custom(validateFn: Function, options?: {description?: string}): IValidator

  // Composite validators
  all(validators: IValidator[], description?: string): IValidator
  any(validators: IValidator[], description?: string): IValidator
}
```

### Built-in Validators

- `RegexMatchValidator` / `RegexNoMatchValidator` - Pattern matching
- `KeywordValidator` - Keyword inclusion/exclusion
- `LengthValidator` - Text length constraints
- `JsonValidator` - JSON format validation
- `SchemaValidator` - Schema-based validation
- `CustomValidator` - Custom validation logic
- `AllValidator` - AND logic (all must pass)
- `AnyValidator` - OR logic (any must pass)

---

## Provider Configuration

### LLMOptions

```typescript
interface LLMOptions {
  provider: ProviderConfig;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  tools?: Record<string, unknown>;
  toolChoice?: 'auto' | 'required' | 'none';
  dangerouslyAllowBrowser?: boolean;
  sdkOptions?: Record<string, unknown>;
  maxCallLimit?: number;
}
```

### Provider Configs

```typescript
interface OpenAIProviderConfig {
  type: 'openai';
  apiKey: string;
  modelName: string;
  baseURL?: string;
  organization?: string;
  dangerouslyAllowBrowser?: boolean;
}

interface AnthropicProviderConfig {
  type: 'anthropic';
  apiKey: string;
  modelName: string;
  baseURL?: string;
}

interface GoogleProviderConfig {
  type: 'google';
  apiKey?: string;
  modelName: string;
  baseURL?: string;
}
```

---

## Generation and Utilities

### Text Generation

```typescript
// Core generation function
generateText<TContext, TMetadata>(
  session: Session<TContext, TMetadata>,
  options: LLMOptions
): Promise<Message<TMetadata>>

// Schema-based generation
generateWithSchema<TContext, TMetadata>(
  session: Session<TContext, TMetadata>,
  options: LLMOptions,
  schemaOptions: SchemaGenerationOptions
): Promise<Message<TMetadata> & {structuredOutput?: unknown}>

// Streaming generation
generateTextStream<TContext, TMetadata>(
  session: Session<TContext, TMetadata>,
  options: LLMOptions
): AsyncGenerator<Message<TMetadata>, void, unknown>
```

### Error Handling

```typescript
class ValidationError extends Error {
  constructor(message: string);
}
```

---

## Testing Support

### MockedLlmSource

```typescript
interface MockedLlmSource extends LlmSource {
  mockResponse(response: MockResponse): MockedLlmSource;
  mockResponses(...responses: MockResponse[]): MockedLlmSource;
  mockCallback(callback: MockCallback): MockedLlmSource;
  getCallHistory(): Array<{
    session: Session;
    options: LLMOptions;
    response: MockResponse;
  }>;
  getLastCall():
    | { session: Session; options: LLMOptions; response: MockResponse }
    | undefined;
  getCallCount(): number;
  reset(): MockedLlmSource;
}

interface MockResponse {
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
  toolResults?: Array<{ toolCallId: string; result: unknown }>;
  metadata?: Record<string, unknown>;
  structuredOutput?: Record<string, unknown>;
}
```

### Debug Utilities

```typescript
namespace Source {
  resetCallCounters(): void
  getCallCount(instanceId: string): number
}
```

---

## Middleware System

### Middleware Interface

```typescript
interface Middleware<TIn, TOut> {
  process(input: TIn, context: MiddlewareContext): Promise<TOut>;
}
```

### Pipeline and Context

```typescript
class MiddlewarePipeline<TIn, TOut>

interface MiddlewareContext {
  session: Session<any, any>;
  requestId: string;
  timestamp: Date;
}

interface RequestContext extends MiddlewareContext {
  request: TIn;
}

interface ResponseContext extends MiddlewareContext {
  response: TOut;
  processingTime: number;
}
```

### Interceptors

```typescript
type RequestInterceptor<T> = (
  request: T,
  context: RequestContext,
) => Promise<T>;
type ResponseInterceptor<T> = (
  response: T,
  context: ResponseContext,
) => Promise<T>;
```

---

## Scenario API (Multi-Step Conversations)

### Core Classes

```typescript
class Scenario<TContext extends Vars = Vars, TMetadata extends Attrs = Attrs>

// Factory methods
Scenario.create<TContext, TMetadata>(config?: ScenarioConfig): Scenario<TContext, TMetadata>
Scenario.interactive<TContext, TMetadata>(config?: ScenarioConfig): Scenario<TContext, TMetadata>
```

### Configuration

```typescript
interface ScenarioConfig {
  debug?: boolean;
  ui?: 'console' | 'ink' | 'auto';
  maxSteps?: number;
  allowEarlyExit?: boolean;
}

interface InteractiveStepOptions {
  prompt?: string;
  validation?: IValidator;
  optional?: boolean;
  exitKeywords?: string[];
}

interface NonInteractiveStepOptions {
  skipCondition?: (session: Session) => boolean;
  retryConfig?: RetryConfig;
}
```

### Utilities

```typescript
namespace Scenarios {
  create<TContext, TMetadata>(config?: ScenarioConfig): Scenario<TContext, TMetadata>
  interactive<TContext, TMetadata>(config?: ScenarioConfig): Scenario<TContext, TMetadata>
}

namespace StepTemplates {
  interactive(options: InteractiveStepOptions): Template
  nonInteractive(template: Template, options?: NonInteractiveStepOptions): Template
}

// Type guards
function isInteractiveStep(step: unknown): step is InteractiveStep;
```

---

## CLI and Debugging

### Ink-based Debug Interface

```typescript
interface InkDebugContext {
  session: Session<any, any>;
  events: DebugEvent[];
  ui: 'console' | 'ink' | 'auto';
}

class InkDebugRenderer {
  constructor(context: InkDebugContext);
  render(): React.ReactElement;
}

class EnhancedInkDebugRenderer extends InkDebugRenderer {
  renderWithEnhancements(): React.ReactElement;
}
```

### Debug Events

```typescript
namespace debugEvents {
  templateStart(templateName: string): DebugEvent
  templateEnd(templateName: string, duration: number): DebugEvent
  messageAdded(message: Message): DebugEvent
  variableSet(key: string, value: unknown): DebugEvent
  llmCall(provider: string, model: string): DebugEvent
  llmResponse(content: string, tokens?: number): DebugEvent
  validationFailed(error: string): DebugEvent
  error(error: Error): DebugEvent
}

namespace debugEventHelpers {
  formatDuration(ms: number): string
  formatTokens(count: number): string
  summarizeMessage(message: Message): string
  colorizeOutput(text: string, type: 'success' | 'error' | 'info'): string
}
```

---

## Utility Functions

### Template Interpolation

```typescript
function interpolateTemplate(
  template: string,
  context: Record<string, unknown>,
): string;
```

### Built-in Handlebars Helpers

```typescript
// Length and formatting
length(array: unknown[]): number
join(array: unknown[], separator: string): string
truncate(text: string, maxLength: number): string
formatNumber(num: number): string

// List formatting
numberedList(items: string[]): string  // "1. Item A\n2. Item B"
bulletList(items: string[]): string    // "• Item A\n• Item B"

// Comparison helpers
eq(a: unknown, b: unknown): boolean
gt(a: number, b: number): boolean
lt(a: number, b: number): boolean
gte(a: number, b: number): boolean
lte(a: number, b: number): boolean

// Debug helper
debug(value: unknown, label?: string): string
```

### Helper Registration

```typescript
function registerHelper(name: string, helper: Function): void;
```

---

## Error Classes

### Core Errors

```typescript
class PromptTrailError extends Error {
  constructor(message: string, cause?: Error);
}

class ValidationError extends PromptTrailError {
  constructor(message: string, validator?: IValidator);
}
```

---

## Testing and Development

### Mock Sources

```typescript
interface MockedLlmSource extends LlmSource {
  mockResponse(response: MockResponse): MockedLlmSource;
  mockResponses(...responses: MockResponse[]): MockedLlmSource;
  mockCallback(callback: MockCallback): MockedLlmSource;
  getCallHistory(): Array<CallHistoryEntry>;
  getLastCall(): CallHistoryEntry | undefined;
  getCallCount(): number;
  reset(): MockedLlmSource;
}

interface MockResponse {
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  metadata?: Record<string, unknown>;
  structuredOutput?: Record<string, unknown>;
}

interface CallHistoryEntry {
  session: Session;
  options: LLMOptions;
  response: MockResponse;
}

type MockCallback = (
  session: Session,
  options: LLMOptions,
) => MockResponse | Promise<MockResponse>;
```

### Debug Utilities

```typescript
namespace Source {
  resetCallCounters(): void;
  getCallCount(instanceId: string): number;
}
```

---

## Type Definitions Reference

### Core Type Aliases

```typescript
// Branded types for type safety
type Vars<T extends Record<string, unknown> = {}> = Readonly<T> & {
  readonly [varsBrand]: void;
};
type Attrs<T extends Record<string, unknown> = {}> = Readonly<T> & {
  readonly [attrsBrand]: void;
};

// Session and message types
type SessionContext<T = Record<string, unknown>> = Vars<T>;
type MessageMetadata<T = Record<string, unknown>> = Attrs<T>;

// Content input types
type SystemContentInput =
  | string
  | Source<string>
  | ((session: Session) => Promise<string>);
type UserContentInput =
  | string
  | string[]
  | { cli: string; defaultValue?: string }
  | Source<string>
  | ((session: Session) => Promise<string>);
type AssistantContentInput =
  | LLMConfig
  | string
  | Source<ModelOutput>
  | ((session: Session) => Promise<ModelOutput>);

// Template options
type UserTemplateOptions = UserOptions & ValidationOptions;
type AssistantTemplateOptions = AssistantOptions & ValidationOptions;

// Parallel execution types
type AggregationStrategy<TContext, TMetadata> = (
  responses: Session<TContext, TMetadata>[],
) => Session<TContext, TMetadata>;
type ScoringFunction<TContext, TMetadata> = (
  session: Session<TContext, TMetadata>,
) => number;
type Strategy<TContext, TMetadata> =
  | 'keep_all'
  | 'best'
  | AggregationStrategy<TContext, TMetadata>;
type BuiltInStrategy = 'keep_all' | 'best';

// Extraction configuration
type ExtractConfig = string | string[] | Record<string, string>;

// Validation types
type TValidationResult =
  | { isValid: true }
  | { isValid: false; instruction: string };
type ValidationOptions = {
  validator?: IValidator;
  maxAttempts?: number;
  raiseOnError?: boolean;
};

// Schema types
type SchemaType<T> = z.ZodType<T>;
type SchemaGenerationOptions = {
  mode?: 'tool' | 'structured_output';
  functionName?: string;
};

// Tool types (re-exported from AI SDK)
type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
  id: string;
};
type ToolResult = { toolCallId: string; result: unknown };

// Provider configuration unions
type ProviderConfig =
  | OpenAIProviderConfig
  | AnthropicProviderConfig
  | GoogleProviderConfig;
type LLMConfig = Partial<LLMOptions & { provider: string; model: string }>;

// Retry configuration
interface RetryConfig {
  maxAttempts?: number;
  backoffMs?: number;
  exponential?: boolean;
}
```

### Advanced Types

```typescript
// Template composition types
type TemplateOrArray<TMetadata, TContext> =
  | Template<TMetadata, TContext>
  | Template<TMetadata, TContext>[];

// Builder function types
type AgentBuilderFn<TContext, TMetadata> = (
  agent: Agent<TContext, TMetadata>,
) => Agent<TContext, TMetadata>;
type ConditionalBuilderFn<TContext, TMetadata> = (
  agent: Agent<TContext, TMetadata>,
) => Agent<TContext, TMetadata>;
type LoopBuilderFn<TContext, TMetadata> = (
  agent: Agent<TContext, TMetadata>,
) => Agent<TContext, TMetadata>;

// Parallel execution input types
type ParallelSourceInput = LLMConfig | LlmSource;
type ParallelSourceConfig = {
  source: ParallelSourceInput;
  repetitions?: number;
};

// CLI configuration
interface CLIOptions {
  prompt?: string;
  defaultValue?: string;
  validation?: IValidator;
}

// Model output types
interface ModelOutput {
  content: string;
  toolCalls?: ToolCall[];
  structuredContent?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
```

---

## Re-exports from AI SDK

PromptTrail.ts re-exports several utilities from the AI SDK for convenience:

```typescript
// Tool utilities
export { tool } from 'ai';
export type { Tool } from 'ai';

// Core generation functions
export { generateText } from 'ai';
export { generateObject } from 'ai';
export { streamText } from 'ai';

// Provider imports
export { openai } from '@ai-sdk/openai';
export { anthropic } from '@ai-sdk/anthropic';
export { google } from '@ai-sdk/google';
```

---

## Namespace Summary

### Major Namespaces and Their Methods

**Source** - Content source factories and utilities

- `Source.llm()`, `Source.cli()`, `Source.literal()`, `Source.callback()`, `Source.random()`, `Source.list()`
- `Source.resetCallCounters()`, `Source.getCallCount()`

**Session** - Session creation and manipulation

- `Session.create()`, `Session.debug()`, `Session.fromJSON()`, `Session.typed()`
- `Session.empty()`, `Session.withContext()`, `Session.withMessages()`

**Agent** - Template builder factories

- `Agent.create()`, `Agent.system()`, `Agent.user()`, `Agent.assistant()`

**Message** - Message utilities and factories

- `Message.create()`, `Message.system()`, `Message.user()`, `Message.assistant()`
- `Message.setMetadata()`, `Message.setContent()`, `Message.expandAttrs()`

**Validation** - Validator factories and utilities

- `Validation.regex()`, `Validation.keyword()`, `Validation.length()`, `Validation.json()`, `Validation.schema()`
- `Validation.custom()`, `Validation.all()`, `Validation.any()`

**Tool** - Tool creation utilities (enhanced AI SDK integration)

- `Tool.create()` - PromptTrail-style tool factory

**Vars/Attrs** - Tagged record utilities

- `Vars.create()`, `Vars.is()`, `Vars.set()`, `Vars.extend()`
- `Attrs.create()`, `Attrs.is()`, `Attrs.set()`, `Attrs.extend()`

**Scenarios** - Multi-step conversation utilities

- `Scenarios.create()`, `Scenarios.interactive()`

**StepTemplates** - Step template builders

- `StepTemplates.interactive()`, `StepTemplates.nonInteractive()`

**debugEvents** - Debug event factories

- `debugEvents.templateStart()`, `debugEvents.messageAdded()`, `debugEvents.llmCall()`, etc.

**debugEventHelpers** - Debug formatting utilities

- `debugEventHelpers.formatDuration()`, `debugEventHelpers.colorizeOutput()`, etc.

---

## Usage Examples

### Basic Agent

```typescript
import { Agent, Source, Session } from '@prompttrail/core';

const agent = Agent.create()
  .system('You are a helpful assistant')
  .user('Hello!')
  .assistant(Source.llm().anthropic());

const session = Session.debug();
const result = await agent.execute(session);
```

### With Validation

```typescript
import { Validation } from '@prompttrail/core';

const agent = Agent.create()
  .user(Source.cli('Enter a number: '))
  .assistant(
    Source.llm(),
    Validation.regex(/^\d+$/, { description: 'Must be a number' }),
  );
```

### Loop Example

```typescript
const agent = Agent.create()
  .system('You are a chatbot')
  .loop(
    (a) => a.user(Source.cli('You: ')).assistant(Source.llm()),
    (session) => session.getVar('continue', true),
    10,
  );
```

### Parallel Example with New API

```typescript
// Simple parallel execution with LLMConfig
const agent = Agent.create()
  .system('You are a helpful assistant')
  .user('What is the weather?')
  .parallel((p) =>
    p
      .withSource({ provider: 'openai', temperature: 0.2 }, 2)
      .withSource({ provider: 'anthropic', temperature: 0.8 })
      .withStrategy('best'),
  );

// Advanced configuration mixing LLMConfig and Source objects
const advancedAgent = Agent.create()
  .system('Research assistant')
  .user('Compare AI frameworks')
  .parallel((p) =>
    p
      .withSource(
        {
          provider: 'openai',
          model: 'gpt-4',
          temperature: 0.1,
          maxTokens: 1000,
        },
        3,
      )
      .withSource(Source.llm().anthropic().temperature(0.8))
      .withAggregationFunction((session) => session.messages.length)
      .withStrategy('best'),
  );
```

### Schema-based Generation

```typescript
import { z } from 'zod';

const schema = z.object({
  name: z.string(),
  age: z.number(),
});

const agent = Agent.create()
  .user('Tell me about yourself')
  .assistant(Source.llm().withSchema(schema));
```

### Conditional Example

```typescript
const agent = Agent.create()
  .system('You are a helpful assistant')
  .user(Source.cli('Enter your question: '))
  .conditional(
    (session) => session.getVar('isAdvanced', false),
    // Then branch - for advanced users
    (a) =>
      a
        .system('Use technical language and detailed explanations')
        .assistant(Source.llm()),
    // Else branch - for regular users
    (a) =>
      a
        .system('Use simple language and brief explanations')
        .assistant(Source.llm()),
  );
```

### Advanced Extract Example

```typescript
import { z } from 'zod';

// Complex extraction with nested data
const analysisSchema = z.object({
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  confidence: z.number().min(0).max(1),
  keyTopics: z.array(z.string()),
  actionItems: z.array(
    z.object({
      task: z.string(),
      priority: z.enum(['high', 'medium', 'low']),
      dueDate: z.string().optional(),
    }),
  ),
});

const textAnalyzer = Agent.create()
  .system('You are an expert text analyzer')
  .user('Analyze this meeting transcript: {{transcript}}')
  .extract(analysisSchema, {
    sentiment: 'overallSentiment',
    confidence: 'analysisConfidence',
    keyTopics: 'mainTopics',
    actionItems: 'tasks',
  })
  .user(
    `
Analysis Summary:
- Sentiment: {{overallSentiment}} (confidence: {{analysisConfidence}})
- Key topics: {{join mainTopics ", "}}
- Action items: {{length tasks}} tasks identified

Would you like me to elaborate on any of these findings?
  `,
  )
  .assistant();

// Execute with context
const session = Session.create({
  context: { transcript: 'Meeting discussion about Q4 planning...' },
});
const result = await textAnalyzer.execute(session);
```

### Subroutine Example

```typescript
const agent = Agent.create()
  .system('You are a research assistant')
  .user('Research topic: AI safety')
  .subroutine(
    (a) =>
      a
        .system('You are a fact-checker. Verify information carefully.')
        .user('Fact-check the previous research')
        .assistant(Source.llm()),
    { isolateContext: true },
  )
  .assistant('Based on the research and fact-checking, here is my summary...');
```

### Sequence Example

```typescript
const agent = Agent.create()
  .system('You are a creative writing assistant')
  .sequence((a) =>
    a
      .user('Write a short story about space exploration')
      .assistant(Source.llm())
      .user('Now create a title for this story')
      .assistant(Source.llm())
      .user('Finally, write a brief synopsis')
      .assistant(Source.llm()),
  );
```
