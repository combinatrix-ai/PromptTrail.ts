# 🚀 PromptTrail

Type-safe, composable framework for building LLM conversations in TypeScript.

Built on [Vercel's ai-sdk](https://github.com/vercel/ai), PromptTrail provides a fluent API for creating structured conversations with immutable state management.

## 🔧 Installation

```bash
# Using pnpm (recommended)
pnpm add github:combinatrix-ai/PromptTrail.ts

# Using npm
npm install github:combinatrix-ai/PromptTrail.ts
```

## 🚀 Quick Start

### 30-Second Example

```typescript
import { Agent } from '@prompttrail/core';

const chat = Agent.create()
  .system("You're a helpful assistant.")
  .user("What's TypeScript?")
  .assistant(); // Uses OpenAI GPT-4o-mini by default

const session = await chat.execute();
console.log(session.getLastMessage()?.content);
```

### Interactive Chat Loop

```typescript
import { Agent } from '@prompttrail/core';

const agent = Agent.create()
  .system('You are a helpful assistant.')
  .loop(
    (l) =>
      l
        .user() // CLI input from user
        .assistant(), // LLM response
  );

await agent.execute(); // Runs forever until user exits
```

### Customizing the LLM

```typescript
import { Agent, Source } from '@prompttrail/core';

const agent = Agent.create()
  .system('You are a creative writer.')
  .user('Write a haiku about TypeScript.')
  .assistant(
    Source.llm()
      .openai()
      .model('gpt-4')
      .temperature(0.9)
      .apiKey(process.env.OPENAI_API_KEY),
  );

await agent.execute();
```

## ✨ Key Features

- **🔒 TypeScript-First** - Full type safety with inference
- **🧩 Composable** - Mix and match conversation patterns
- **🔄 Immutable** - Predictable state management
- **🔌 Multi-Provider** - OpenAI, Anthropic, Google support
- **🛠️ Tool Integration** - Function calling via ai-sdk
- **🌊 Streaming** - Real-time response streaming
- **🛡️ Validation** - Input/output validation with retries
- **🧪 Structured Output** - Force LLMs to return typed data

## 📘 Core Concepts

### Session & Variables

Sessions store conversation state with type-safe variables:

```typescript
import { Session } from '@prompttrail/core';

// Variables for interpolation and state
const session = Session.create({
  vars: { userName: 'Alice', language: 'TypeScript' },
});

// Use variables in templates with ${variable} syntax
const agent = Agent.create()
  .system('Help ${userName} learn ${language}')
  .user('Explain generics')
  .assistant();

await agent.execute(session);
```

### Sources - Where Content Comes From

```typescript
import { Source } from '@prompttrail/core';

// Different content sources
.user(Source.literal('Fixed text'))      // Static content
.user(Source.cli())                      // User input from terminal
.user(Source.random(['A', 'B', 'C']))    // Random selection
.user(Source.callback(session => '...')) // Custom logic

.assistant(Source.llm())                 // LLM generation (default)
.assistant(Source.cli())                 // Manual assistant input
```

### Control Flow

PromptTrail offers two ways to build agents with sophisticated control flow:

#### 1. Agent Builder (Template-Level Control)

```typescript
import { Agent } from '@prompttrail/core';

const agent = Agent.create()
  .system('You are helpful.')

  // Conditional logic
  .conditional(
    (session) => session.getVar('isVip'),
    (agent) => agent.assistant('Welcome VIP!'),
    (agent) => agent.assistant('Welcome!'),
  )

  // Loops with conditions
  .loop(
    (agent) => agent.user().assistant(),
    (session) => session.getVar('continue', true),
  )

  // Subroutines with isolation
  .subroutine(
    (agent) =>
      agent
        .user('Process this data')
        .assistant()
        .transform((session) => session.withVar('processed', true)),
    {
      isolatedContext: true, // Fresh context
      retainMessages: false, // Don't keep internal messages
      squashWith: (parent, sub) =>
        parent.withVar('result', sub.getVar('processed')),
    },
  )

  // Parallel execution
  .add(
    new Parallel()
      .addSource(Source.llm().openai(), 2) // Run OpenAI twice
      .addSource(Source.llm().anthropic(), 1) // Run Anthropic once
      .setStrategy('best'), // Keep best result
  );
```

#### 2. Scenario API (Goal-Oriented Flow)

```typescript
import { Scenario } from '@prompttrail/core';

const scenario = Scenario.system(
  'You are a research assistant with access to tools.',
)
  .step("Get the user's research question", {
    allow_interaction: true, // Uses built-in ask_user tool
  })
  .step('Research the topic thoroughly', {
    max_attempts: 6,
    is_satisfied: (session, goal) => {
      // Custom validation for goal completion
      const toolCalls = getToolCallsFromSession(session);
      return toolCalls.length >= 3;
    },
  })
  .step('Provide a comprehensive answer');
```

**Key Differences:**

- **Agent**: Low-level template composition, full control
- **Scenario**: High-level goal tracking with built-in tools (`ask_user`, `check_goal`)

## 🛠️ Advanced Features

### Session Typing

PromptTrail provides **gradual typing** - start simple and add types as your app grows:

```typescript
// 1. Start simple - types inferred automatically
const session = Session.create({
  vars: { userName: 'Alice', score: 100 },
});

// 2. Convenience method with type inference
const sessionWithVars = Session.withVars({
  userId: 'user123',
  role: 'admin',
  preferences: { theme: 'dark', notifications: true },
});

// 3. Add explicit types when you need them
type UserContext = {
  userId: string;
  role: 'admin' | 'user' | 'guest';
  preferences: {
    theme: 'light' | 'dark';
    notifications: boolean;
  };
};

type MessageMeta = {
  timestamp: number;
  priority: 'low' | 'medium' | 'high';
  source: 'user' | 'system';
};

// 4. Type-only specification (no runtime values)
const typedSession = Session.withVarsType<UserContext>()
  .withAttrsType<MessageMeta>()
  .create({
    vars: {
      userId: 'user123',
      role: 'admin',
      preferences: { theme: 'dark', notifications: true },
    },
  });

// 5. Mix and match approaches
const session1 = Session.withVarsType<UserContext>().debug();
const session2 = Session.withAttrsType<MessageMeta>().empty();
const session3 = Session.withVars({ count: 42 }).withAttrsType<MessageMeta>();

// 6. Type-safe access with full IntelliSense
const userId = typedSession.getVar('userId'); // string
const role = typedSession.getVar('role'); // 'admin' | 'user' | 'guest'
const theme = typedSession.getVar('preferences').theme; // 'light' | 'dark'

// 7. Template with typed interpolation
const typedAgent = Agent.create<UserContext>()
  .system('Welcome ${role} user ${userId}')
  .user('My theme is ${preferences.theme}')
  .assistant();
```

### Tool Integration

```typescript
import { tool } from 'ai';
import { z } from 'zod';

const weatherTool = tool({
  description: 'Get weather info',
  parameters: z.object({
    location: z.string(),
  }),
  execute: async ({ location }) => {
    return { temp: 72, condition: 'sunny' };
  },
});

const agent = Agent.create()
  .system('You can check weather.')
  .user('Weather in SF?')
  .assistant(Source.llm().openai().addTool('weather', weatherTool));
```

### Structured Output

```typescript
import { Structured } from '@prompttrail/core';
import { z } from 'zod';

const userSchema = z.object({
  name: z.string(),
  age: z.number(),
  interests: z.array(z.string()),
});

const agent = Agent.create()
  .system('Extract user info from text.')
  .user("Hi, I'm Alice, 25, love coding and music.")
  .add(
    new Structured({
      schema: userSchema,
      source: Source.llm().openai(),
    }),
  );

const session = await agent.execute();
const userData = session.getLastMessage()?.structuredContent;
// userData is typed as { name: string, age: number, interests: string[] }
```

### Validation

PromptTrail provides comprehensive validation for all content sources with automatic retry:

```typescript
import { Validation } from '@prompttrail/core';

// Simple validation with Source.llm()
const simpleValidation = Source.llm()
  .openai()
  .validate(Validation.length({ max: 100 }))
  .withMaxAttempts(3)
  .withRaiseError(true);

// Complex multi-criteria validation
const complexValidation = Source.llm()
  .openai()
  .validate(
    Validation.all([
      Validation.length({ min: 10, max: 500 }),
      Validation.keyword(['explanation', 'example'], { mode: 'include' }),
      Validation.regex(/^\w+.*\w+$/), // Must start and end with word characters
    ]),
  )
  .withMaxAttempts(5);

// Use in templates
const agent = Agent.create()
  .system('Explain concepts clearly with examples.')
  .user('What is TypeScript?')
  .assistant(complexValidation);

// CLI validation with retries
const userInput = Source.cli('Enter your name (2-50 chars):')
  .validate(
    Validation.all([
      Validation.length({ min: 2, max: 50 }),
      Validation.regex(/^[a-zA-Z\s]+$/), // Only letters and spaces
    ]),
  )
  .withMaxAttempts(3)
  .withRaiseError(false); // Don't throw, just warn

// Schema validation for structured data
const structuredResponse = Source.schema(
  z.object({
    answer: z.string(),
    confidence: z.number().min(0).max(1),
    reasoning: z.array(z.string()),
  }),
  {
    mode: 'structured_output',
    maxAttempts: 3,
  },
);

// Custom validation with context access
const contextAwareValidation = Source.llm()
  .validate(
    Validation.custom((content, session) => {
      const maxWords = session?.getVar('maxWords', 50);
      const wordCount = content.split(/\s+/).length;

      if (wordCount <= maxWords) {
        return { isValid: true };
      }

      return {
        isValid: false,
        instruction: `Response must be ${maxWords} words or less (got ${wordCount})`,
      };
    }),
  )
  .withMaxAttempts(2);
```

**Validation Features:**

- **Automatic retry** - Failed validations trigger new attempts
- **Rich feedback** - Validation instructions help LLMs improve
- **All sources** - Works with LLM, CLI, callback, and literal sources
- **Composable** - Combine multiple validators with AND/OR logic
- **Context-aware** - Access session state in custom validators

### Advanced Control Flow

Beyond basic patterns, PromptTrail offers sophisticated control structures:

```typescript
// Nested subroutines for memory management
const agent = Agent.create()
  .system('Complex data processor')
  .subroutine(
    (agent) =>
      agent
        .user('Stage 1: Parse data')
        .assistant()
        .subroutine(
          (innerAgent) =>
            innerAgent.user('Sub-process: Validate format').assistant(),
          {
            isolatedContext: true, // Clean slate for validation
            retainMessages: false, // Don't pollute main conversation
          },
        )
        .transform((session) => session.withVar('stage1Complete', true)),
    {
      squashWith: (parent, sub) =>
        parent.withVars({
          processed: sub.getVar('stage1Complete'),
          result: sub.getLastMessage()?.content,
        }),
    },
  );

// Multi-LLM parallel processing
const researchAgent = Agent.create()
  .system('Research assistant')
  .user('Compare machine learning frameworks')
  .add(
    new Parallel()
      .addSource(Source.llm().openai().temperature(0.2), 1) // Conservative
      .addSource(Source.llm().anthropic().temperature(0.8), 1) // Creative
      .addSource(Source.llm().google().temperature(0.5), 1) // Balanced
      .setAggregationFunction(
        (session) => session.getLastMessage()?.content?.length || 0,
      )
      .setStrategy('best'), // Keep longest response
  );

// Goal-oriented research with custom satisfaction
const smartScenario = Scenario.system('You are an expert researcher.')
  .step('Understand research requirements', { allow_interaction: true })
  .step('Gather comprehensive information', {
    max_attempts: 8,
    is_satisfied: (session, goal) => {
      const messages = session.getMessagesByType('assistant');
      const hasToolCalls = messages.some((m) => m.toolCalls?.length > 0);
      const hasDetailedAnalysis = messages.some(
        (m) => m.content?.length > 500 && m.content.includes('analysis'),
      );
      return hasToolCalls && hasDetailedAnalysis;
    },
  })
  .step('Synthesize findings and provide recommendations');

// Dynamic flow with error handling
const robustAgent = Agent.create()
  .system('Fault-tolerant processor')
  .transform((session) => session.withVar('retryCount', 0))
  .loop(
    (agent) =>
      agent.conditional(
        (session) => session.getVar('retryCount') < 3,
        (agent) =>
          agent
            .user('Attempt operation')
            .assistant()
            .transform((session) => {
              const success = session
                .getLastMessage()
                ?.content?.includes('success');
              return session.withVars({
                success,
                retryCount: session.getVar('retryCount') + 1,
              });
            }),
        (agent) =>
          agent.transform((session) => session.withVar('failed', true)),
      ),
    (session) => !session.getVar('success') && !session.getVar('failed'),
  );
```

**Advanced Patterns:**

- **Nested isolation** - Subroutines within subroutines for memory management
- **Multi-provider consensus** - Run multiple LLMs and aggregate results
- **Custom goal validation** - Define complex satisfaction criteria for scenarios
- **Error recovery** - Retry logic with fallback strategies

### Streaming Responses

```typescript
import { generateTextStream } from '@prompttrail/core';

const session = Session.create().addMessage({
  type: 'user',
  content: 'Explain async/await',
});

for await (const chunk of generateTextStream(session, Source.llm().openai())) {
  process.stdout.write(chunk.content);
}
```

## 🔧 Provider Configuration

### OpenAI

```typescript
const openaiConfig = Source.llm()
  .openai()
  .model('gpt-4')
  .temperature(0.7)
  .maxTokens(1000)
  .apiKey(process.env.OPENAI_API_KEY);
```

### Anthropic

```typescript
const anthropicConfig = Source.llm()
  .anthropic()
  .model('claude-3-5-haiku-latest')
  .temperature(0.5)
  .apiKey(process.env.ANTHROPIC_API_KEY);
```

### Google

```typescript
const googleConfig = Source.llm()
  .google()
  .model('gemini-pro')
  .temperature(0.8)
  .apiKey(process.env.GOOGLE_API_KEY);
```

## 🌐 Browser Support

```typescript
// Enable browser mode (⚠️ Don't expose API keys in production!)
const browserConfig = Source.llm()
  .openai()
  .apiKey('sk-...')
  .dangerouslyAllowBrowser(true);
```

## 📦 Package Structure

- `@prompttrail/core` - Main framework
- `@prompttrail/react` - React integration (coming soon)

## 💡 Examples

Check the [`examples/`](./examples) directory for more:

- [`chat.ts`](./examples/chat.ts) - Simple chat interface
- [`coding_agent.ts`](./examples/coding_agent.ts) - AI coding assistant
- [`autonomous_researcher.ts`](./examples/autonomous_researcher.ts) - Research agent
- [`gradual_typing_demo.ts`](./examples/gradual_typing_demo.ts) - TypeScript typing patterns

## 🤝 Contributing

1. Fork the repository
2. Run tests: `cd packages/core && pnpm test`
3. Check types: `pnpm -C packages/core typecheck`
4. Format code: `pnpm format`
5. Submit a pull request

## 📄 License

MIT - See [LICENSE](LICENSE) for details.
