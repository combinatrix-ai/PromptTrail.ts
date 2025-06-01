# 🚀 PromptTrail

A type-safe, composable framework for building structured LLM conversations with various LLMs and tools.

PromptTrail helps TypeScript developers build robust, maintainable LLM applications with incremental strong typing, composable templates, and powerful validation tools. Built on Vercel's widely-adopted [ai-sdk](https://github.com/vercel/ai), PromptTrail leverages its ecosystem for LLM and tool interactions, enabling seamless integration with a broad range of language models and function calling capabilities.

You can write agents with multigranular level templates, from simple chatbots to complex workflows, using a fluent API.
PromptTrail is designed to be extensible and adaptable, allowing you to create custom templates and integrate with various LLMs and tools.

You can write turn-by-turn conversation management (Agent Level):

```typescript
import { Agent } from '@prompttrail/core';
const agent = Agent.system('You are a helpful assistant.')
  .loop(
    (l) =>
      l
        .user() // Use CLI for user input
        .assistant(), // Use LLM for assistant responses
    true, // Forever loop (You can also use `.loopForever()`)
  )
  .execute();
```

(Default: `OpenAI GPT-4o-mini` model for assistant, `CLI` for user input)

Or, you can automate the conversation by defining the steps (Scenario Level):

```typescript
import { Scenario, Source } from '@prompttrail/core';
import { tool } from 'ai';
import { z } from 'zod';

// Define your research tools
const researchTools = {
  searchDocs: tool({
    description: 'Search documentation',
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }) => ({ results: ['...'] }),
  }),
};

const scenario = Scenario.system(
  'You are a research assistant. Help users find information.',
  {
    tools: researchTools,
    llmSource: Source.llm().openai({ model: 'gpt-4' }),
  },
)
  .step('Ask the user for their question', { allow_interaction: true })
  .step('Research the question using tools 2-3 times', { max_attempts: 6 })
  .step('Provide a comprehensive answer')
  .execute();
```

### How Scenario API Works

The Scenario API provides a high-level, goal-oriented interface for building autonomous agents. Each step represents a goal that the LLM must accomplish using available tools:

1. **Interactive Steps** (`allow_interaction: true`): The LLM must use the `ask_user` tool to get user input
2. **Processing Steps**: The LLM uses provided tools autonomously to achieve the goal
3. **Goal Validation**: Each step includes an automatic `check_goal` tool that the LLM uses to self-evaluate completion

Behind the scenes, Scenario compiles to Agent-based subroutines with loops that continue until goals are satisfied or max attempts are reached.

### Key Features

- **Built-in Tools**:
  - `ask_user`: Get user input (only in interactive steps)
  - `check_goal`: LLM self-evaluates goal completion
  - Custom tools: Your domain-specific tools
- **Step Control**:
  - `max_attempts`: Limit iterations per step (default: 10)
  - `is_satisfied`: Custom validation function
  - `interaction_prompt`: Custom prompt for user interaction
- **Convenience Methods**:
  - `.interact()`: Interactive step shorthand
  - `.process()`: Processing step shorthand
  - `.collect()`: Collect specific information
  - `.decide()`: Make decisions with branches

We're focusing on providing sensible defaults for the most common use cases, but you can customize everything.

```typescript
  .assistant() // Uses default Source.llm() with OpenAI GPT-4o-mini
```

You can pass `Source` objects, which yield ModelOutput or string content:

```typescript
  .assistant(Source.llm()) // Explicit default LLM source
```

You can impersonate the assistant with user input:

```typescript
  .assistant(Source.cli()) // Use CLI response to impersonate the assistant
```

You can customize LLM settings with the `Source` object:

```typescript
  .assistant(
    Source.llm()
      .openai()
      .apiKey(process.env.OPENAI_API_KEY!)
      .modelName('gpt-4o-mini')
      .temperature(0.7)
  )
```

Or, you can use `ai-sdk` style configuration to set up everything at once:

```typescript
  .assistant(Source.llm(
    {
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY!,
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    }
  ))
```

This also applies to `User` templates:

```typescript
  .assistant("Hello!")
  .user(Source.cli().prompt('What\'s your name?')) // CLI prompt for user input
```

This will appear like this in the terminal:

```bash
Assistant: Hello!
What's your name? >
```

You can interact with the user in a more structured way, by defining the data structure of the conversation:

## ✨ Features

- 🔒 [**TypeScript-First**](#-typescript-first-design) - Full TypeScript support with inference and generics
- 📝 [**Template-Based**](#%EF%B8%8F-building-templates) - Composable conversation building blocks
- 🧩 [**Composable Patterns**](#-complex-control-flow) - Mix and match templates for complex flows using the `Agent` builder
- 🔌 [**Multi-Provider**](#-model-configuration) - Works with OpenAI, Anthropic, and extensible for more
- 🔄 [**Stateless Architecture**](#-session-management) - Immutable sessions for predictable state management
- 🌊 [**Streaming Support**](#-streaming-responses) - Real-time response streaming
- 📊 [**Vars Transformation**](#-vars-transformation) - Modify session vars during execution using `Transform`
- 🛡️ [**Validation**](#%EF%B8%8F-validation) - Validate both user input and LLM responses using `Source` options or `Assistant` parameters
- 🧪 [**Structured Output**](#-structured-output) - Force LLMs to produce structured outputs using the `Structured` template and Zod schemas
- 🛠️ [**Tool Integration**](#%EF%B8%8F-tool-integration) - First-class support for function calling via `ai-sdk`
- 🔌 [**MCP Support**](#-mcp-support) - Integration with Anthropic's Model Context Protocol via `generateOptions`
- 🌐 [**Browser Compatible**](#-browser-support) - Works in both Node.js and browser environments

## 🔧 Installation

> **Note:** This package is not yet published on npm. Install directly from GitHub:

```bash
# Using pnpm (recommended)
pnpm add github:combinatrix-ai/PromptTrail.ts

# Using npm
npm install github:combinatrix-ai/PromptTrail.ts

# Using yarn
yarn add github:combinatrix-ai/PromptTrail.ts
```

## Package Structure

- `@prompttrail/core`: Core library for building LLM applications.
- `@prompttrail/react`: React components for building LLM applications (coming soon)

## 🚀 Quick Start

```typescript
// Usually all imports are from @prompttrail/core
import { Agent, Source, createSession } from '@prompttrail/core';

// Create a simple conversation template using the Agent builder
const chat = Agent.create()
  .system("I'm a helpful assistant.")
  .user("What's TypeScript?")
  .assistant(
    Source.llm()
      .openai()
      .apiKey(process.env.OPENAI_API_KEY!)
      .model('gpt-4o-mini')
      .temperature(0.7),
  );

// Execute the template
const session = await chat.execute(
  createSession({
    print: true, // Enable console logging of the conversation
  }),
);
// Console Output:
//     System: I'm a helpful assistant.
//     User: What's TypeScript?
//     Assistant: TypeScript is a superset of JavaScript that ...

// Access the conversation state with the session object
console.log('last message:', session.getLastMessage()?.content);
//     last message: TypeScript is a superset of JavaScript that ...
```

## 📘 Usage

### Core Concepts

- In PromptTrail, all conversation state is stored in a `Session` object.
  - `Session` is an immutable object with `vars` and `messages`.
    - `vars` is a structured object that holds conversation state.
      - You can store formatted LLM responses or external data for later use.
        - For example, if `session.vars == { userName: 'Alice' }`, writing `Hi ${userName}!` becomes `Hi Alice!`.
        - We'll show how to save data to `vars` later.
    - `messages` is an immutable array of conversation history.
      - For example, `[{role: 'user', content: 'Hello!'}, {role: 'assistant', content: 'Hi!'}...]`.
      - Messages can include `attrs` metadata.
        - For instance `{ role: 'user', content: 'Hello!', attrs: { timestamp: "2025-03-25T12:00:00Z" } }` attaches a timestamp.
        - We'll cover how to save data to `attrs` later.
- Because `Session` uses `vars` and `attrs` types, TypeScript can safely infer conversation state.
  - ```
      type UserVars = { userName: string; userId: string; } extends Vars;
      type UserAttrs = { timestamp: number; customRole: string; } extends Attrs;
      const session = createSession<UserVars, UserAttrs>();
    ```

### API Convention

- PromptTrail is designed so typing the object name gives autocompletion.

  - Every object has a `[Thing].create()` factory method.
    - For example, `Session.create()`, `Vars.create()`, `Attrs.create()`, `Agent.create()`.
  - Use `set` or `extend` to update Session, Vars or Attrs.
    - `set` overwrites values while `extend` adds keys and may change types.
      - `Vars.create({ userName: 'Alice' }).set({ userName: 'Bob' })` // userName becomes `Bob` and returns `Vars<{ userName: string }>`
      - `Vars.create({ userName: 'Alice' }).set({ age: '20' })` // TypeError
      - `Vars.create({ userName: 'Alice' }).extend({ userName: 'Bob' })` // userName becomes `Bob` and returns `Vars<{ userName: string }>`
      - `Vars.create({ userName: 'Alice' }).extend({ age: '20' })` // Works and returns `Vars<{ userName: string, age: string }>`
    - For example, `session.setVars({ userName: 'Alice' })` or `session.extendVars({ userName: 'Alice' })`
      - `extend` lets you append to existing values.
  - Build templates with `Agent.create()`.
    - The fluent API lets you compose templates: `Agent.create().system(...).loop(...)`.
    - You can also write `Agent.create(new Loop([System(...), User(...), Assistant(...)])).
  - Text generation functions work the same way.
    - `Source.create().useLLM().useOpenAI().setTemperature(...)`
    - Or:
      - `Source.llm().openai().temperature(...)` // Modern factory API
      - `Source.cli().prompt(...)` // Modern factory API

- **Session**: Represents a conversation with `vars` and `messages`. Immutable.
  ```typescript
  import { createSession } from '@prompttrail/core';
  const session = createSession(); // Creates an empty session
  const sessionWithContext = createSession({ context: { userName: 'Alice' } });
  ```
  - **Vars**: A read-only structured object (`Vars<T>`) holding conversation state (e.g., user info, settings). Used for interpolation (`Hi ${userName}`) or storing information (`vars.loopCounter`).
    ```typescript
    import { Vars, Assistant } from '@prompttrail/core';
    // Vars objects have a hidden brand property
    const userVars = Vars.create({ userName: 'Alice', userId: 'u-123' });
    // Usage in interpolation:
    const greeting = new Assistant('Hi ${userName}!'); // Resolves to "Hi Alice!" if vars has userName: 'Alice'
    // Accessing values: session.getVar('userId')
    ```
  - **Messages**: An immutable array of conversation history. `[{role: 'user', content: 'Hello!'}, {role: 'assistant', content: 'Hi!'}...]`.
    ```typescript
    const messages = [
      { type: 'system', content: 'You are helpful.' },
      { type: 'user', content: 'Hello!' },
      { type: 'assistant', content: 'Hi there!' },
    ];
    const sessionWithMessages = createSession({ messages });
    ```
    - **Attrs**: Optional read-only data (`Attrs<T>`) attached to messages. Used for storing additional information (e.g., non-default roles, timestamps).
      ```typescript
      import { Attrs } from '@prompttrail/core';
      const messageWithMeta = {
        type: 'user',
        content: 'User input',
        metadata: Attrs.create({
          timestamp: Date.now(),
          customRole: 'tester',
        }),
      };
      // Access: messageWithMeta.metadata.timestamp
      ```
- **Template**: A reusable piece of conversation logic (`System`, `User`, `Assistant`, `Conditional`, `Loop`, `Transform`, `Structured`, `Subroutine`, `Sequence`, `Agent`).
  ```typescript
  import { System } from '@prompttrail/core';
  const systemPrompt = new System('You are a helpful AI assistant.');
  ```
- **Agent**: A fluent builder (`Agent.create()`) for composing templates sequentially.
  ```typescript
  import { Agent } from '@prompttrail/core';
  const myAgent = Agent.create().system('System prompt').user('User query');
  // .assistant(...) etc.
  ```
- **Source**: Defines where content comes from. Use the `Source` namespace for factory methods (`Source.literal()`, `Source.llm()`, `Source.cli()`, `Source.callback()`, `Source.random()`, `Source.list()`). Passed to templates like `User` or `Assistant`.
  ```typescript
  import { Source, User } from '@prompttrail/core';
  const staticUserMessage = new User(
    Source.literal('This is a fixed user message.'),
  );
  ```
- **GenerateOptions**: Configuration for LLM generation (provider, model, temperature, tools, etc.). Used by `LlmSource` and `SchemaSource`.
  ```typescript
  import { createGenerateOptions, Assistant } from '@prompttrail/core';
  const options = createGenerateOptions({ provider: { type: 'openai', ... } });
  const assistantResponse = new Assistant(options); // Uses LlmSource internally
  ```

```typescript
import {
  Agent,
  createSession,
  createGenerateOptions,
  Source,
} from '@prompttrail/core';

// Example of a simple template execution using Agent
const simpleTemplate = Agent.create()
  .system('Welcome to the conversation!')
  .user('Tell me about TypeScript.')
  .assistant(Source.literal('TypeScript is a typed superset of JavaScript.')); // Use Source.literal() for fixed response

const session = await simpleTemplate.execute(
  createSession({
    context: {
      // Vars are type-safe if generics are provided
      userId: 'user-123',
      language: 'TypeScript',
    },
    print: true,
  }),
);
```

### 🔒 TypeScript-First Design

PromptTrail leverages TypeScript for strong typing, better IDE support, and a robust development experience.

```typescript
import { createSession, Vars, Attrs } from '@prompttrail/core';

// Define types for context and metadata
interface MyVars extends Vars {
  name: string;
  preferences: {
    theme: 'light' | 'dark';
    language: string;
  };
}
interface MyAttrs extends Attrs {
  timestamp: number;
}

// Type-safe session creation
const session = createSession<MyVars, MyAttrs>({
  context: {
    name: 'Alice',
    preferences: {
      theme: 'dark',
      language: 'TypeScript',
    },
  },
});

// Type-safe context access
const userName = session.getVar('name'); // Type: string | undefined
const theme = session.getVar('preferences')?.theme; // Type: 'light' | 'dark' | undefined

// Immutable operations maintain type safety
const updatedSession = session.addMessage({
  type: 'user',
  content: 'Hi',
  metadata: { timestamp: Date.now() }, // Attrs match MyAttrs
});
const newSession = updatedSession.withVars({ name: 'Bob' }); // Updates context immutably
```

PromptTrail's immutable architecture ensures predictable state management:

- Session operations (`addMessage`, `withVar`, `withVars`) return new `Session` instances.
- Templates operate on sessions without side effects.
- Consistent use of `Vars<T>` and `Attrs<T>` ensures type safety.

### 🏗️ Building Templates

Use the `Agent` builder for fluent template composition:

```typescript
import {
  Agent,
  createSession,
  createGenerateOptions,
  User,
  Assistant,
  Vars,
} from '@prompttrail/core';

// Define generateOptions for OpenAI
let openAIgenerateOptions = createGenerateOptions({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
});

// Define vars type
interface UserInfo extends Vars {
  name: string;
  language: string;
}

// Create a personalized chat using Agent
const techSupportFlow = new Agent<UserInfo>()
  .system("You're a helpful programming assistant.")
  // Interpolate context: ${name}, ${language}
  .assistant(`Hello, \${name}! Ready to dive into \${language}?`)
  // User message directly
  .user("What's tricky about type inference?")
  // Generate response using LLM
  .assistant(openAIgenerateOptions);

// Execute with initial context
const session = await techSupportFlow.execute(
  createSession<UserInfo>({
    context: {
      name: 'Alice',
      language: 'TypeScript',
    },
    print: true, // Enable console output
  }),
);

// Console Output:
//     System: You're a helpful programming assistant.
//     Assistant: Hello, Alice! Ready to dive into TypeScript?
//     User: What's tricky about type inference?
//     Assistant: Alice, one tricky part of type inference is when unions are involved—TypeScript can lose precision. Want me to walk you through an example?
```

#### 🔄 Complex control flow

Combine `Agent`, `Conditional`, `Loop`, `Subroutine`, and `Transform` for intricate logic:

```typescript
import {
  Agent,
  Sequence,
  Loop,
  Conditional,
  Subroutine,
  Transform,
  System,
  User,
  Assistant,
  Source,
  createSession,
  createGenerateOptions,
  Vars,
  Attrs,
} from '@prompttrail/core';

// Define generateOptions (assuming openAIgenerateOptions is defined elsewhere)

interface QuizVars extends Vars {
  quizComplete?: boolean;
  summary?: string;
}

const quiz = new Agent<QuizVars>() // Use Agent as the main builder
  .system("You're a TypeScript quiz bot.")
  // Greet based on time using conditional
  .conditional(
    (session) => new Date().getHours() < 12,
    (agent) => agent.assistant('Good morning!'),
    (agent) => agent.assistant('Good afternoon!'),
  )
  // Quiz loop
  .loop(
    (agent) =>
      agent
        .user(
          Source.list([
            // Use Source.list() for predefined questions/statements
            "What's TypeScript?",
            'Explain type inference.',
            "I'm satisfied now.", // Loop exit trigger
          ]),
        )
        .assistant(openAIgenerateOptions), // LLM answers the question
    // Loop condition: Continue as long as the last user message doesn't indicate satisfaction
    (session) => {
      const lastUserMessage = session.getMessagesByType('user').pop();
      // Loop if no user message yet OR if the last user message doesn't contain 'satisfied'
      return !lastUserMessage?.content.toLowerCase().includes('satisfied');
    },
  )
  // Subroutine to summarize the quiz
  .subroutine(
    (agent) =>
      agent
        .system(
          'You are an educational coach. Write a three-sentence summary of the conversation and suggest one topic for further study.',
        )
        .assistant(openAIgenerateOptions), // LLM generates the summary
    {
      // Subroutine options
      // initWith: (optional) Customize how the subroutine session starts. Default clones parent.
      // squashWith: Customize how the subroutine result merges back.
      squashWith: (parentSession, subroutineSession) => {
        const summaryMessage = subroutineSession.getLastMessage();
        if (summaryMessage?.type === 'assistant') {
          // Add the summary to the parent context instead of as a message
          return parentSession.withVars({
            summary: summaryMessage.content,
          });
        }
        return parentSession; // Return parent unchanged if no summary
      },
      retainMessages: false, // Don't add the subroutine's internal messages to the final history
      // isolatedContext: true, // Optionally run subroutine with empty context
    },
  )
  // Final message, potentially using the summary from context
  .assistant(
    (session) =>
      `Quiz finished! 🚀\n**Summary:**\n${session.getVar('summary', 'No summary generated.')}`,
  );

// Execute the quiz
const session = await quiz.execute(createSession<QuizVars>({ print: true }));

console.log('Final Vars:', session.getVarsObject());
```

### 🤖 Model Configuration

Configure LLM interactions via `GenerateOptions`:

```typescript
import { createGenerateOptions, MCPServerConfig } from '@prompttrail/core';

// OpenAI configuration
const openAIgenerateOptions = createGenerateOptions({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
  maxTokens: 1000,
});

// Anthropic configuration
const anthropicGenerateOptions = createGenerateOptions({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    modelName: 'claude-3-5-haiku-latest', // Use claude-3-5-haiku-latest
  },
  temperature: 0.5,
});

// Anthropic with MCP integration
const mcpServer: MCPServerConfig = {
  type: 'mcp', // Required field for MCP config
  url: 'http://localhost:8080', // Your MCP server URL
  name: 'github-mcp-server', // Optional name
  version: '1.0.0', // Optional version
  toolName: 'mcp-tool-name', // Specify the tool name the MCP server provides
  serverName: 'unique-server-identifier', // A unique name for this server instance
};

const anthropicMcpOptions = createGenerateOptions({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    modelName: 'claude-3-5-haiku-latest',
  },
  temperature: 0.7,
}).addMCPServer(mcpServer); // Use fluent API to add MCP server
```

### 💾 Session Management

`Session` objects are immutable records of the conversation state (`messages` and `context`).

```typescript
import {
  createSession,
  Agent,
  System,
  User,
  Assistant,
  Sequence,
} from '@prompttrail/core';
import type { Vars, Attrs } from '@prompttrail/core';

interface MyVarsSession extends Vars {
  userId: string;
  language: string;
  tone: string;
  topics: string[];
}
interface MyAttrsSession extends Attrs {
  timestamp?: number;
}

// Create a session with initial context
const initialSession = createSession<MyVarsSession, MyAttrsSession>({
  context: {
    userId: 'user-123',
    language: 'TypeScript',
    tone: 'professional',
    topics: ['generics', 'type inference', 'utility types'],
  },
  print: true,
});

// Templates use ${variable} syntax for context interpolation
const template = new Agent<MyVarsSession, MyAttrsSession>() // Specify types for Agent
  .system(`I'll use \${tone} language to explain \${topics[0]}`)
  .assistant(`Let me explain \${topics[0]} in \${language}`)
  .user(`Can you also cover \${topics[1]}?`);

// Execute the template with the initial session
const sessionAfterTemplate = await template.execute(initialSession);

// Sessions are immutable - operations return new instances
const sessionWithMessage = sessionAfterTemplate.addMessage({
  type: 'user',
  content: 'Hello!',
  metadata: { timestamp: Date.now() }, // Add metadata
});

// Query session state
const lastMessage = sessionWithMessage.getLastMessage();
const userMessages = sessionWithMessage.getMessagesByType('user');
console.log(
  `Last message type: ${lastMessage?.type}, content: ${lastMessage?.content}`,
);

// Update context (returns a new session instance)
const sessionWithNewTone = sessionWithMessage.withVars({
  tone: 'casual', // Update existing key
  lastInteraction: Date.now(), // Add new key
});

console.log('Original tone:', sessionWithMessage.getVar('tone')); // professional
console.log('New tone:', sessionWithNewTone.getVar('tone')); // casual

// Serialize/deserialize (useful for saving/loading state)
const json = sessionWithNewTone.toJSON();
console.log('Session JSON:', JSON.stringify(json, null, 2));
// const loadedSession = Session.fromJSON<MyVarsSession, MyAttrsSession>(json); // Deserialize
```

### 🌊 Streaming Responses

Process model responses chunk by chunk using `generateTextStream`:

```typescript
import { createSession, generateTextStream } from '@prompttrail/core';
// Assuming openAIgenerateOptions is defined

// Define session locally for this example
const session = createSession().addMessage({
  type: 'user',
  content: 'Explain streaming in 2 sentences.',
});

// Stream responses chunk by chunk
console.log('\nStreaming response:');
try {
  for await (const chunk of generateTextStream(
    session,
    openAIgenerateOptions,
  )) {
    // chunk is a Message object, typically with type 'assistant' and partial content
    if (chunk.content) {
      process.stdout.write(chunk.content);
    }
    // Handle tool calls if needed: if (chunk.toolCalls) { ... }
  }
} catch (error) {
  console.error('\nStream failed:', error);
}
console.log('\n--- End of Stream ---');
```

### 📊 Vars Transformation

Modify session vars during template execution using the `Transform` template:

```typescript
import { Agent, Transform, createSession } from '@prompttrail/core';
import type { Vars } from '@prompttrail/core';

interface ServerInfoVars extends Vars {
  ipAddress?: string;
  uptime?: number;
  status?: string;
}

// Example: Extract data using regex and update context
const dataExtractionAgent = new Agent<ServerInfoVars>()
  .user('Server status: IP 192.168.1.100, Uptime 99.99%, Status: Running')
  // Transform step
  .transform((session) => {
    const lastMessageContent = session.getLastMessage()?.content || '';
    const updatedVars: Partial<ServerInfoVars> = {}; // Store updates

    // Extract IP Address
    const ipMatch = lastMessageContent.match(/IP ([\d\.]+)/);
    if (ipMatch) {
      updatedVars.ipAddress = ipMatch[1];
    }

    // Extract and transform Uptime
    const uptimeMatch = lastMessageContent.match(/Uptime ([\d\.]+)%/);
    if (uptimeMatch) {
      updatedVars.uptime = parseFloat(uptimeMatch[1]) / 100;
    }

    // Extract Status
    const statusMatch = lastMessageContent.match(/Status: (\w+)/);
    if (statusMatch) {
      updatedVars.status = statusMatch[1];
    }

    // Return a new session with the updated vars values
    return session.withVars(updatedVars);
  });

// Execute the agent
const dataSession =
  await dataExtractionAgent.execute(createSession<ServerInfoVars>());

// Access the extracted data from the final session context
console.log('IP:', dataSession.getVar('ipAddress')); // "192.168.1.100"
console.log('Uptime:', dataSession.getVar('uptime')); // 0.9999
console.log('Status:', dataSession.getVar('status')); // "Running"
```

### 🛡️ Validation

Ensure the quality of LLM responses or user input using validators. Validators can be attached to `Assistant` templates or used within `Source` options.

```typescript
import {
  Agent,
  Assistant,
  User,
  System,
  RegexMatchValidator,
  LengthValidator,
  KeywordValidator,
  AllValidator,
  CustomValidator,
  createSession,
  createGenerateOptions,
  ValidationOptions,
} from '@prompttrail/core';
// Assuming openAIgenerateOptions is defined

// --- Built-in Validators ---

// Regex validator: Must be a single word
const singleWordValidator = new RegexMatchValidator({
  regex: /^[A-Za-z]+$/,
  description: 'Response must be a single word with only letters',
});

// Length validator: 3-10 characters
const lengthValidator = new LengthValidator({
  min: 3,
  max: 10,
  description: 'Response must be between 3 and 10 characters',
});

// Keyword validator: Exclude certain words
const appropriateValidator = new KeywordValidator({
  keywords: ['inappropriate', 'offensive'],
  mode: 'exclude', // 'include' is also an option
  description: 'Response must not contain inappropriate words',
  caseSensitive: false, // Default
});

// Combine validators: All must pass
const combinedValidator = new AllValidator(
  [singleWordValidator, lengthValidator, appropriateValidator],
  { description: 'Combined validation for pet names' },
);

// --- Using Validators with Assistant ---

// Define validation options for the Assistant
const validationOptions: ValidationOptions = {
  validator: combinedValidator,
  maxAttempts: 3, // Retry up to 3 times if validation fails
  raiseError: true, // Throw an error if validation fails after max attempts
};

// Create an Agent that asks for a pet name and validates the response
const petNameAgent = Agent.create()
  .system('You are a helpful assistant that suggests pet names.')
  .user('Suggest a single, short, appropriate name for a pet cat.')
  // Assistant with validation options
  .assistant(openAIgenerateOptions, validationOptions);

// Execute (will retry/error if LLM response fails validation)
try {
  const petNameSession = await petNameAgent.execute(createSession());
  console.log('Validated pet name:', petNameSession.getLastMessage()?.content);
} catch (error) {
  console.error('Pet name validation failed:', error);
}

// --- Custom Validator ---

const customValidator = new CustomValidator(
  (content, session) => {
    // Validation logic can access session context
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const maxWords = session?.getVar('maxWords', 5); // Example: Get limit from context
    return wordCount <= maxWords
      ? { isValid: true } // Success
      : {
          // Failure
          isValid: false,
          instruction: `Answer must be ${maxWords} words or less (current: ${wordCount} words)`,
        };
  },
  { description: 'Ensure answer is short' }, // Description for the validator
);

// Use custom validator with Assistant
const shortAnswerAgent = Agent.create()
  .system('Answer concisely.')
  .user('Explain quantum physics briefly.')
  .assistant(openAIgenerateOptions, {
    validator: customValidator,
    maxAttempts: 2,
  });

// Execute
try {
  const shortAnswerSession = await shortAnswerAgent.execute(
    createSession({ context: { maxWords: 10 } }),
  ); // Set maxWords in context
  console.log('Short answer:', shortAnswerSession.getLastMessage()?.content);
} catch (error) {
  console.error('Short answer validation failed:', error);
}

// Note: Validators can also be applied to all Source factory methods
// Example: Source.cli("Enter name:", undefined, { validator: lengthValidator })
```

### 🧪 Structured Output

Force LLMs to produce structured outputs matching a Zod schema using the `Structured` template. This is useful for reliable data extraction.

```typescript
import { z } from 'zod';
import {
  Agent,
  Structured,
  createSession,
  createGenerateOptions,
} from '@prompttrail/core';
// Assuming openAIgenerateOptions is defined

// Define a Zod schema for the desired output structure
const productSchema = z.object({
  name: z.string().describe('The name of the product'),
  price: z.number().describe('The price of the product in USD'),
  inStock: z.boolean().describe('Whether the product is in stock'),
  features: z.array(z.string()).describe('List of key features'),
});

// Create the Structured template
const structuredProductTemplate = new Structured({
  generateOptions: openAIgenerateOptions, // LLM configuration
  schema: productSchema, // The Zod schema to enforce
  maxAttempts: 3, // Retry attempts if output doesn't match schema
  // functionName: 'extractProductInfo' // Optional: Name for the underlying tool call
});

// Use the Structured template within an Agent
const productExtractorAgent = Agent.create()
  .system(
    'Extract product information from the user query into the provided schema.',
  )
  .user(
    'Tell me about the Pixel 8. It costs $699, is in stock, and has a great camera and AI features.',
  )
  // The Structured template - it will generate an assistant message
  // containing the structured data if successful.
  .add(structuredProductTemplate);

// Execute the agent
try {
  const session = await productExtractorAgent.execute(createSession());

  // The structured data is attached to the last assistant message
  const lastMessage = session.getLastMessage();
  if (lastMessage?.type === 'assistant' && lastMessage.structuredContent) {
    // Access the validated, typed structured output
    const productData = lastMessage.structuredContent as z.infer<
      typeof productSchema
    >;
    console.log('Structured Product Data:', productData);
    console.log(`Product: ${productData.name} - $${productData.price}`);
    console.log(`In Stock: ${productData.inStock}`);
    console.log(`Features: ${productData.features.join(', ')}`);
  } else {
    console.log('Structured output not found in the last message.');
  }
} catch (error) {
  console.error('Structured output generation failed:', error);
}
```

### 🛠️ Tool Integration

Leverage the `ai-sdk`'s tool integration by adding tools to `GenerateOptions`. PromptTrail handles the underlying message formatting.

```typescript
import { z } from 'zod';
import { tool } from 'ai'; // Import from ai-sdk
import { Agent, createSession, createGenerateOptions } from '@prompttrail/core';
// Assuming openAIgenerateOptions is defined

// Define a weather forecast tool using ai-sdk's `tool` helper
const weatherTool = tool({
  description: 'Get weather information for a specific location',
  parameters: z.object({
    location: z
      .string()
      .describe('The city and state, e.g., San Francisco, CA'),
  }),
  execute: async ({ location }: { location: string }) => {
    // In a real scenario, call a weather API here
    console.log(`Tool execution: Getting weather for ${location}`);
    const forecast = ['Today: Sunny', 'Tomorrow: Cloudy', 'Day after: Rainy'];
    return {
      // Return data matching the tool's expected output
      location,
      temperature: Math.floor(Math.random() * 30 + 50), // Random temp for example
      condition: forecast[0].split(': ')[1],
      forecast,
    };
  },
});

// Add the tool to GenerateOptions
const toolEnhancedOptions = openAIgenerateOptions
  .clone() // Clone to avoid modifying the original options
  .addTool('getWeather', weatherTool) // Add the tool with a name
  .setToolChoice('auto'); // Let the model decide when to use the tool

// Create an Agent that might use the tool
const weatherAgent = Agent.create()
  .system("I'm a weather assistant. Use the available tools.")
  .user("What's the weather like in New York?")
  // The assistant might respond directly or make a tool call
  .assistant(toolEnhancedOptions);

// Execute the agent
const session = await weatherAgent.execute(createSession());

// Check the last message for potential tool calls
const lastMessage = session.getLastMessage();
if (lastMessage?.type === 'assistant' && lastMessage.toolCalls) {
  console.log('Assistant requested tool call(s):', lastMessage.toolCalls);
  // In a real application, you would execute the tool here based on toolCalls
  // and add a 'tool_result' message back to the session before continuing.
  // PromptTrail currently expects manual handling of tool execution results.
} else {
  console.log('Assistant response (no tool call):', lastMessage?.content);
}
```

### 🔌 MCP Support

Integrate with Anthropic's Model Context Protocol (MCP) servers by configuring them in `GenerateOptions`.

```typescript
import {
  Agent,
  createSession,
  createGenerateOptions,
  generateText,
} from '@prompttrail/core';
import type { MCPServerConfig } from '@prompttrail/core';
// Assuming anthropicGenerateOptions is defined

// Define MCP server configuration
const mcpServerConfig: MCPServerConfig = {
  type: 'mcp', // Required
  url: 'http://localhost:8080', // URL of your running MCP server
  serverName: 'research-mcp-server', // Unique identifier for this server
  toolName: 'searchPapers', // The specific tool provided by the MCP server
  // Optional fields:
  // name: 'My Research Server',
  // version: '1.0.1',
  // headers: { 'Authorization': 'Bearer ...' }
};

// Create options with MCP server configuration
const optionsWithMCP = createGenerateOptions({
  provider: {
    type: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    modelName: 'claude-3-5-haiku-latest',
  },
  temperature: 0.7,
}).addMCPServer(mcpServerConfig); // Add the MCP server config

// Create an Agent that might leverage the MCP tool
const mcpAgent = Agent.create()
  .system('You are a helpful assistant with access to research tools via MCP.')
  .user('Can you search for the latest papers on LLM reasoning?')
  .assistant(optionsWithMCP); // Use the options with MCP configured

// Execute the agent
try {
  // Note: This requires an MCP server running at the specified URL (localhost:8080)
  // providing the 'searchPapers' tool.
  const session = await mcpAgent.execute(createSession());
  console.log('MCP Agent Response:', session.getLastMessage()?.content);
} catch (error) {
  console.error(
    'MCP Example Failed (This is expected if no compatible MCP server is running at localhost:8080):',
    error.message,
  );
}
```

## 🌐 Browser Support

PromptTrail is designed to work in browser environments. Set the `dangerouslyAllowBrowser` flag in your provider configuration.

```typescript
import { Agent, createSession, createGenerateOptions } from '@prompttrail/core';

// Browser-compatible configuration for OpenAI
const browserOptions = createGenerateOptions({
  provider: {
    type: 'openai',
    apiKey: 'YOUR_API_KEY', // IMPORTANT: In production, never expose keys directly. Fetch from your secure backend.
    modelName: 'gpt-4o-mini',
    dangerouslyAllowBrowser: true, // Required flag for browser usage
  },
  temperature: 0.7,
});

// Use with templates as normal in your frontend code
const browserAgent = Agent.create()
  .system('You are a helpful assistant running in the browser.')
  .user('Hello from the browser!')
  .assistant(browserOptions);

// Example execution (within an async function in your frontend code)
async function runBrowserAgent() {
  try {
    const session = await browserAgent.execute(createSession());
    console.log('Browser Agent Response:', session.getLastMessage()?.content);
    // Update your UI with the response
  } catch (error) {
    console.error('Browser agent failed:', error);
    // Handle errors appropriately in the UI
  }
}

// runBrowserAgent(); // Call this function in your frontend logic
```

## 👥 Contributing

Contributions are welcome! Here's how you can help:

- 🐛 Report bugs by opening issues
- 💡 Suggest features and improvements
- 🧪 Run tests with `cd packages/core && pnpm test` (uses Vitest)
- 💅 Check formatting with `pnpm format:check` and fix with `pnpm format`
- 👕 Check linting with `pnpm lint:check` and fix with `pnpm lint`
- ✅ Check types with `pnpm -C packages/core typecheck`
- 🏗️ Build all packages with `pnpm -r build`
- 🔀 Submit pull requests

## 📄 License

MIT - See [LICENSE](LICENSE) for details.
