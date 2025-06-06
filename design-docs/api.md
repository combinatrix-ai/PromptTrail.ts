# PromptTrail.ts API Documentation

## Overview

PromptTrail.ts is a TypeScript-first framework for building structured LLM conversations with type safety and composability. This document provides comprehensive API documentation for all major objects and classes.

## Core Objects

### Session

The immutable conversation state manager that holds messages and variables.

```typescript
class Session<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>

// Factory methods
Session.create<TVars, TAttrs>(options?: {
  vars?: TVars;
  messages?: Message<Attrs<TAttrs>>[];
  print?: boolean;
}): Session<Vars<TVars>, Attrs<TAttrs>>

// Convenience factory methods
Session.empty<TVars, TAttrs>(): Session<Vars<TVars>, Attrs<TAttrs>>
Session.debug<TVars, TAttrs>(options?: { vars?: TVars; messages?: Message<Attrs<TAttrs>>[] }): Session<Vars<TVars>, Attrs<TAttrs>>
Session.withVars<TVars>(vars: TVars, options?: { messages?: Message<Attrs<{}>>[], print?: boolean }): Session<Vars<TVars>, Attrs<{}>>
Session.withMessages<TAttrs>(messages: Message<Attrs<TAttrs>>[], options?: { vars?: Record<string, unknown>; print?: boolean }): Session<Vars<{}>, Attrs<TAttrs>>
```

**Methods:**

- `addMessage(message: Message<TAttrs>): Session<TVars, TAttrs>` - Add message and return new session
- `getVar<K>(key: K, defaultValue?: TVars[K]): TVars[K]` - Get variable value
- `withVar<K, V>(key: K, value: V): Session<TVars & {[P in K]: V}, TAttrs>` - Set variable
- `withVars<U>(vars: U): Session<TVars & U, TAttrs>` - Set multiple variables
- `withAttrsType<U>(): Session<TVars, Attrs<U>>` - **NEW**: Add attrs type specification (type-only)
- `getLastMessage(): Message<TAttrs> | undefined` - Get last message
- `getMessagesByType<U>(type: U): Extract<Message<TAttrs>, {type: U}>[]` - Filter messages by type
- `validate(): void` - Validate session state
- `toJSON(): Record<string, unknown>` - Serialize to JSON
- `toString(): string` - Convert to string

**Properties:**

- `messages: readonly Message<TAttrs>[]` - Immutable message array
- `vars: TVars` - Session variables
- `print: boolean` - Console output flag
- `varsSize: number` - Variable count

**Usage Examples:**

```typescript
// Simple session creation
const session = Session.create({ vars: { userName: 'Alice' } });

// Typed session creation
type UserContext = { userId: string; role: string };
const typedSession = Session.create<UserContext>({
  vars: { userId: '123', role: 'admin' },
});

// Debug session with logging
const debugSession = Session.debug({ vars: { debug: true } });

// Session with messages
const sessionWithMessages = Session.create({
  vars: { userName: 'Alice' },
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
interface Template<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars> {
  execute(session?: Session<TVars, TAttrs>): Promise<Session<TVars, TAttrs>>;
}
```

### TemplateBase (Abstract)

Base class for all templates with common functionality.

```typescript
abstract class TemplateBase<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
```

**Methods:**

- `abstract execute(session?: Session<TVars, TAttrs>): Promise<Session<TVars, TAttrs>>`
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

class System<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
constructor(contentOrSource: SystemContentInput)
```

#### User

**Instantiation Methods:**

1. **Direct instantiation**: `new User(contentOrSource?: string | Source<string>)`
2. **🎯 Preferred: Agent method**: `agent.user(contentOrSource?, options?)` - Type-safe, inherits Agent's type parameters

```typescript
class User<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
constructor(contentOrSource?: string | Source<string>)
```

#### Assistant

**Instantiation Methods:**

1. **Direct instantiation**: `new Assistant(contentOrSource?, validatorOrOptions?)`
2. **🎯 Preferred: Agent method**: `agent.assistant(contentOrSource?, options?)` - Type-safe, inherits Agent's type parameters

```typescript
class Assistant<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
constructor(
  contentOrSource?: string | Source<ModelOutput> | Source<string>,
  validatorOrOptions?: IValidator | ValidationOptions
)
```

### Composite Templates

#### Loop

**Instantiation Methods:**

1. **Direct instantiation**: `new Loop(options)`
2. **🎯 Preferred: Agent method**: `agent.loop(builderFn, loopIf, maxIterations?)` - Function-based with nested agent builder

```typescript
class Loop<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
constructor(options: {
  bodyTemplate?: Template<any, any> | Template<any, any>[];
  loopIf?: (session: Session<TVars, TAttrs>) => boolean;
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
class Sequence<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
constructor(templates?: Template<TAttrs, TVars>[])
```

#### Subroutine

**Instantiation Methods:**

1. **Direct instantiation**: `new Subroutine(template, options?)`
2. **🎯 Preferred: Agent method**: `agent.subroutine(builderFn, options?)` - Function-based with nested agent builder

```typescript
class Subroutine<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
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
class Conditional<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
constructor(options: {
  condition: (s: Session<TVars, TAttrs>) => boolean;
  thenTemplate: Template<TAttrs, TVars>;
  elseTemplate?: Template<TAttrs, TVars>;
})
```

#### Parallel

**Instantiation Methods:**

1. **Direct instantiation**: `new Parallel(options?)`
2. **🎯 Preferred: Agent method**: `agent.parallel(builderFn)` - Function-based with ParallelBuilder

```typescript
class Parallel<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
constructor(options?: {
  sources?: Array<{ source: LlmSource; repetitions?: number }>;
  scoringFunction?: ScoringFunction<TVars, TAttrs>;
  strategy?: Strategy<TVars, TAttrs>;
})

// Used within Agent.parallel() method
class ParallelBuilder<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
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
class Transform<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
constructor(transform: (s: Session<TVars, TAttrs>) => Session<TVars, TAttrs>)
```

#### Structured

**Instantiation Methods:**

1. **Direct instantiation**: `new Structured(schema, options?)`
2. **🎯 Preferred: Agent method**: Use `agent.assistant()` with `Source.llm().withSchema()` - Better integration with LLM sources

```typescript
class Structured<T, TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
constructor(schema: SchemaType<T>, options?: StructuredOptions)
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
class Agent<TC extends Vars = Vars, TM extends Attrs = Attrs>
```

**Static Factories:**

- `Agent.create<TC, TM>(): Agent<TC, TM>`
- `Agent.system<TC, TM>(content: string): Agent<TC, TM>`
- `Agent.user<TC, TM>(contentOrSource?: string | Source<string>): Agent<TC, TM>`
- `Agent.assistant<TC, TM>(contentOrSource?, validatorOrOptions?): Agent<TC, TM>`

**Template Building:**

- `add(template: Template<TM, TC>): Agent<TC, TM>` - Add any template

**Message Builders:**

- `system(content: string): Agent<TC, TM>` - Add system message
- `user(contentOrSource?: string | Source<string>): Agent<TC, TM>` - Add user message
- `assistant(contentOrSource?, validatorOrOptions?): Agent<TC, TM>` - Add assistant message

**Composite Template Builders:**

- `conditional(condition, thenBuilderFn, elseBuilderFn?): Agent<TC, TM>` - Add conditional with nested agents
- `transform(transform): Agent<TC, TM>` - Add transform
- `loop(builderFn, loopIf, maxIterations?): Agent<TC, TM>` - Add loop with nested agent
- `loopForever(builderFn): Agent<TC, TM>` - Add infinite loop with nested agent
- `subroutine(builderFn, options?): Agent<TC, TM>` - Add subroutine with nested agent
- `sequence(builderFn): Agent<TC, TM>` - Add sequence with nested agent

**Execution:**

- `build(): Template<TM, TC>` - Build final template
- `execute(session?: Session<TC, TM>): Promise<Session<TC, TM>>` - Execute agent

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

interface BaseMessage<TAttrs extends Attrs = Attrs> {
  content: string;
  attrs?: TAttrs;
  structuredContent?: Record<string, unknown>;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
}

interface SystemMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'system';
}

interface UserMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'user';
}

interface AssistantMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'assistant';
}

interface ToolResultMessage<TAttrs extends Attrs = Attrs>
  extends BaseMessage<TAttrs> {
  type: 'tool_result';
}

type Message<TAttrs extends Attrs = Attrs> =
  | SystemMessage<TAttrs>
  | UserMessage<TAttrs>
  | AssistantMessage<TAttrs>
  | ToolResultMessage<TAttrs>;
```

### Message Utilities

```typescript
const Message = {
  create<M>(type: MessageRole, content: string, attrs?: M): Message<M>
  setAttrs<M>(message: Message<M>, attrs: M): Message<M>
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
generateText<TVars, TAttrs>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions
): Promise<Message<TAttrs>>

// Schema-based generation
generateWithSchema<TVars, TAttrs>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions,
  schemaOptions: SchemaGenerationOptions
): Promise<Message<TAttrs> & {structuredOutput?: unknown}>

// Streaming generation
generateTextStream<TVars, TAttrs>(
  session: Session<TVars, TAttrs>,
  options: LLMOptions
): AsyncGenerator<Message<TAttrs>, void, unknown>
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
