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
import { Agent, Source } from '@prompttrail/core';

const chat = Agent.create('chat')
  .system('system', "You're a helpful assistant.")
  .user('question', "What's TypeScript?")
  .assistant('reply', Source.llm()); // Uses OpenAI GPT-5.4 nano via the Responses API by default

const session = await chat.execute();
console.log(session.getLastMessage()?.content);
```

`Agent.execute(...)` takes a single options object. Pass initial state, runtime
context, observers, or graph execution input as
`execute({ session, context, observers, input, ... })`. Use `PromptTrail.app`
for durable runs.

### Interactive Chat Loop

```typescript
import { Agent, Source } from '@prompttrail/core';

const agent = Agent.create('chat')
  .system('system', 'You are a helpful assistant.')
  .loop(
    'chatLoop',
    (l) =>
      l
        .user('input', Source.cli()) // CLI input from user
        .assistant('reply', Source.llm()), // LLM response
    ({ session }) => {
      const lastUserMessage = session.getMessagesByType('user').slice(-1)[0];
      return lastUserMessage?.content.toLowerCase().trim() !== 'exit';
    },
  );

await agent.execute();
```

### Customizing the LLM

```typescript
import { Agent, Source } from '@prompttrail/core';

const agent = Agent.create('writer')
  .system('system', 'You are a creative writer.')
  .user('prompt', 'Write a haiku about TypeScript.')
  .assistant(
    'reply',
    Source.llm()
      .openai()
      .model('gpt-5.4-nano')
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
- **🛠️ Tool Integration** - Typed function calling with PromptTrail tools
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
const agent = Agent.create('tutor')
  .system('system', 'Help ${userName} learn ${language}')
  .user('prompt', 'Explain generics')
  .assistant('reply', Source.llm());

await agent.execute({ session });
```

### Sources - Where Content Comes From

```typescript
import { Source } from '@prompttrail/core';

// Different content sources
.user('fixed', Source.literal('Fixed text'))       // Static content
.user('cli', Source.cli())                         // User input from terminal
.user('random', Source.random(['A', 'B', 'C']))    // Random selection
.user('custom', Source.callback(session => '...')) // Custom logic

.assistant('model', Source.llm())                  // LLM generation
.assistant('manual', Source.cli())                 // Manual assistant input
```

### Generating Multiple Messages

```typescript
import { Agent, Message } from '@prompttrail/core';

const agent = Agent.create('summarizer')
  .user('prompt', 'Summarize the external workflow')
  .messages('summary', async (session) => [
    Message.assistant(`Processed ${session.messages.length} messages`),
  ]);
```

### Codex App Server Turns

Codex App Server is treated as an external runtime turn, not as an OpenAI model
provider. `codexTurn()` runs one Codex turn and inserts the final Codex answer
back into the PromptTrail session while preserving Codex metadata in message
attributes.

```typescript
const agent = Agent.create('repo-review')
  .user('prompt', 'Inspect this repository and suggest the next edit')
  .codexTurn('codex', {
    transport: { kind: 'websocket', url: 'ws://127.0.0.1:8390' },
    cwd: process.cwd(),
    sandboxPolicy: { type: 'readOnly' },
    approvalPolicy: 'never',
  });
```

To run the live Codex App Server integration test:

```bash
CODEX_APP_SERVER_URL=ws://127.0.0.1:8390 pnpm --filter @prompttrail/core exec vitest --run src/__tests__/integration/codex_app_server.integration.test.ts
```

### Control Flow

Named agents use explicit node ids. The ids become stable graph coordinates for
app bindings, events, and durable replay.

```typescript
import { Agent } from '@prompttrail/core';

const agent = Agent.create('support')
  .system('system', 'You are helpful.')
  .patch('init', (session) => session.withVar('attempts', 0))
  .conditional(
    'greeting',
    ({ session }) => session.getVar('isVip') === true,
    (then) => then.assistant('vipReply', 'Welcome VIP!'),
    (otherwise) => otherwise.assistant('defaultReply', 'Welcome!'),
  )
  .loop(
    'retry',
    (body) =>
      body.patch('increment', (session) =>
        session.withVar('attempts', Number(session.getVar('attempts')) + 1),
      ),
    ({ session }) => Number(session.getVar('attempts')) < 3,
    { maxIterations: 3 },
  )
  .subroutine(
    'draft',
    (draft) =>
      draft
        .user('request', 'Draft the customer reply')
        .assistant('reply', 'Draft response'),
    {
      isolatedContext: true,
      retainMessages: false,
      squashWith: (parent, sub) =>
        parent.withVar('draft', sub.getLastMessage()?.content),
    },
  );
```

For throwaway scripts and template-level utilities such as `Parallel`,
`Structured`, `codexTurn()`, and `claudeTurn()`, use `Agent.quick()`.
Quick agents are ephemeral and cannot run durable.

#### Agent Goals (Goal-Oriented Flow)

```typescript
import { Agent } from '@prompttrail/core';

const researcher = Agent.create('researcher')
  .system('system', 'You are a research assistant with access to tools.')
  .goal('collectQuestion', "Get the user's research question", {
    interaction: 'required',
  })
  .goal('researchTopic', 'Research the topic thoroughly', {
    maxAttempts: 6,
    isSatisfied: ({ session }) => {
      const toolResults = session.getMessagesByType('tool_result');
      return toolResults.length >= 3;
    },
  })
  .goal('finalAnswer', 'Provide a comprehensive answer');
```

Goal authoring compiles into the agent graph and executes through the graph
runtime with stable retry, tool, satisfaction, and interaction node paths.
`isSatisfied` is a deterministic session check; external effects belong in
tools, model calls, or middleware phases.

**Key Differences:**

- **Agent**: Low-level template composition, full control
- **Agent.goal**: High-level goal tracking on the same Agent graph API
- **Scenario**: Not a public authoring API; use `Agent.goal(...)`

### App Runtime & Bindings

`PromptTrail.app(...)` owns registered agents, run storage, observers, adapters,
platform bindings, and runtime defaults such as middleware configured at app
creation. Durability is a run/app mode, not a separate public `DurableAgent`
API.

```typescript
import {
  Agent,
  PromptTrail,
  Source,
  discord,
  discordGateway,
  memoryStore,
} from '@prompttrail/core';

const support = Agent.create('support')
  .system('system', 'You are a concise support assistant.')
  .turn('reply', (turn) =>
    turn
      .inbox('inbound')
      .assistant('model', Source.llm().openai())
      .tools('tools')
      .awaitInput('next'),
  );

const app = PromptTrail.app({ store: memoryStore() })
  .agent(support)
  .adapter(discordGateway({ token: process.env.DISCORD_TOKEN }))
  .bind(discord.messages(), (binding) =>
    binding
      .where(discord.notBot())
      .to(support)
      .conversation(discord.sessionKey({ threadSessionsPerUser: true }))
      .durable()
      .delivery(discord.replyToOriginThread()),
  );

const bundle = app.bundle('support-runtime'); // structural runtime IR
```

Use `app.bundle(name?)` or `PromptTrail.runtimeBundle({ name, agents, bindings })` as
runtime IR for servers, mocks, and deployment wiring. The bundle keeps
registered agents, handlers, and resolvers as live code; it is not a JSON
serialization boundary. Ordinary agent authoring stays on `Agent.create(...)`.

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
const typedAgent = Agent.quick<UserContext>()
  .system('Welcome ${role} user ${userId}')
  .user('My theme is ${preferences.theme}')
  .assistant();
```

### Tool Integration

```typescript
import { Agent, Source, Tool } from '@prompttrail/core';
import { z } from 'zod';

const weatherTool = Tool.create({
  description: 'Get weather info',
  inputSchema: z.object({
    location: z.string(),
  }),
  execute: async ({ location }) => {
    return { temp: 72, condition: 'sunny' };
  },
});

const agent = Agent.quick()
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

const agent = Agent.quick()
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
const agent = Agent.quick()
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
// Nested graph subroutines for memory management
const agent = Agent.create('processor')
  .system('system', 'Complex data processor')
  .subroutine(
    'stage1',
    (stage) =>
      stage
        .user('parse', 'Stage 1: Parse data')
        .assistant('parseReply', 'Parsed data')
        .subroutine(
          'validate',
          (inner) =>
            inner
              .user('format', 'Sub-process: Validate format')
              .assistant('formatReply', 'Format is valid'),
          {
            isolatedContext: true,
            retainMessages: false,
          },
        )
        .patch('markComplete', (session) =>
          session.withVar('stage1Complete', true),
        ),
    {
      squashWith: (parent, sub) =>
        parent.withVars({
          processed: sub.getVar('stage1Complete'),
          result: sub.getLastMessage()?.content,
        }),
    },
  );

// Multi-LLM parallel processing
const researchAgent = Agent.quick()
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
const smartResearcher = Agent.create('smartResearcher')
  .system('system', 'You are an expert researcher.')
  .goal('understandRequirements', 'Understand research requirements', {
    interaction: 'required',
  })
  .goal('gatherInformation', 'Gather comprehensive information', {
    maxAttempts: 8,
    isSatisfied: ({ session }) => {
      const toolResults = session.getMessagesByType('tool_result');
      const messages = session.getMessagesByType('assistant');
      const hasDetailedAnalysis = messages.some((message) =>
        message.content.includes('analysis'),
      );
      return toolResults.length >= 3 && hasDetailedAnalysis;
    },
  })
  .goal(
    'synthesizeFindings',
    'Synthesize findings and provide recommendations',
  );

// Dynamic flow with error handling
const robustAgent = Agent.create('robustProcessor')
  .system('system', 'Fault-tolerant processor')
  .patch('init', (session) => session.withVar('retryCount', 0))
  .loop(
    'attempts',
    (attempt) =>
      attempt.conditional(
        'canRetry',
        ({ session }) => Number(session.getVar('retryCount')) < 3,
        (then) =>
          then
            .user('operation', 'Attempt operation')
            .assistant('result', 'operation result')
            .patch('recordResult', (session) => {
              const success = session
                .getLastMessage()
                ?.content?.includes('success');
              return session.withVars({
                success,
                retryCount: Number(session.getVar('retryCount')) + 1,
              });
            }),
        (otherwise) =>
          otherwise.patch('markFailed', (session) =>
            session.withVar('failed', true),
          ),
      ),
    ({ session }) => !session.getVar('success') && !session.getVar('failed'),
    { maxIterations: 3 },
  );
```

**Advanced Patterns:**

- **Nested isolation** - Subroutines within subroutines for memory management
- **Multi-provider consensus** - Run multiple LLMs and aggregate results
- **Custom goal validation** - Define complex satisfaction criteria for agent goals
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

For the longer-term provider/runtime design, including Responses API,
Anthropic Messages API, Codex App Server, Claude Agent SDK, tools, skills, MCP,
and approvals, see
[`docs/provider-runtime-capabilities.md`](./docs/provider-runtime-capabilities.md).

### OpenAI

```typescript
const openaiConfig = Source.llm()
  .openai({ api: 'responses' })
  .model('gpt-5.4-nano')
  .temperature(0.7)
  .maxTokens(1000)
  .apiKey(process.env.OPENAI_API_KEY);
```

### Anthropic

```typescript
const anthropicConfig = Source.llm()
  .anthropic()
  .model('claude-haiku-4-5')
  .temperature(0.5)
  .apiKey(process.env.ANTHROPIC_API_KEY);
```

### Google

```typescript
const googleConfig = Source.llm()
  .google()
  .model('gemini-3.1-flash-lite')
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
