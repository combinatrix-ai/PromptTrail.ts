# 🚀 PromptTrail

A type-safe, composable framework for building structured LLM conversations with various LLMs and tools.

PromptTrail helps TypeScript developers build robust, maintainable LLM applications with incremental strong typing, composable templates, and powerful validation tools. Built on Vercel's widely-adopted [ai-sdk](https://github.com/vercel/ai), PromptTrail leverages its ecosystem for LLM and tool interactions, enabling seamless integration with a broad range of language models and function calling capabilities.

You can write agents with multigranular level templates, from simple chatbots to complex workflows, using a fluent API. 
PromptTrail is designed to be extensible and adaptable, allowing you to create custom templates and integrate with various LLMs and tools.

You can write turn-by-turn conversation management ():
```typescript
import { Agent } from '@prompttrail/core';
const agent = Agent.create()
  .system('You are a helpful assistant.')
  .loop()
  .user(Source.cli()) // Use CLI for user input
  .assistant(Source.llm()) // Use LLM for assistant responses
  .loopif(true)
  .execute()
```

Or, you can automate the conversation with defining the steps:
```typescript
import { Agent } from '@prompttrail/core';
const agent = Scenario.create()
  .system(
    "You are a research assistant. Help the user with their research.",
  )
  .step('Ask the user for their question.', {allow_interaction: true})
  .step('Do search for the answer until you get satisfied information.')
      .tool(Tools.search())
  .step('Summarize the information and return to the user')
  .step('Get comments from the user. Follow up on their feedback. If satisfied, exit conversation.', {
    allow_interaction: true,
  })
      .tool(Tools.exit())
  .execute()
```
This will be compiled to the folliowing:
```typescript
const agent = Agent.create()
  .system(
    "You are a research assistant. Help the user with their research.",
    {parent: "system_1"} // L1 layer
  )
  .subroutine(
    initWith: Subroutine.initWithParent(), // Use the parent session as the initial context
    squashWith: Subroutine.squashWithParent(), // Merge the subroutine result with the parent session
    new Agent()
    .loop()
    .system(
      "You are a research assistant. Help the user with their research." // Original system prompt
      + "Ask the user for their question." // Goal as additional context
    )
    .assistant() // Loop only by assistant
    .tool(Tools.ask_user()) // allow_interaction: true
    .loopif(
      Validation.isNotGoalSatisfied() // Loop if the goal is not satisfied, this will be determined by LLM
    ),
    {parent: "step_1"} // L1 layer
  )
  .subroutine(
    initWith: Subroutine.initWithParent(), // Use the parent session as the initial context
    squashWith: Subroutine.squashWithParent(), // Merge the subroutine result with the parent session
    new Agent()
    .loop()
    .system(
      "You are a research assistant. Help the user with their research." // Original system prompt
      + "Do search for the answer until you get satisfied information." // Goal as additional context
    )
    .assistant() // Loop only by assistant
    .tool(Tools.search())
    // allow_interaction: false 
    .loopif(
      Validation.isNotGoalSatisfied() // Loop if the goal is not satisfied, this will be determined by LLM
    )
  )
  .subroutine(
    initWith: Subroutine.initWithParent(), // Use the parent session as the initial context
    squashWith: Subroutine.squashWithParent(), // Merge the subroutine result with the parent session
    new Agent()
    .loop()
    .system(
      "You are a research assistant. Help the user with their research." // Original system prompt
      + "Summarize the information and return to the user" // Goal as additional context
    )
    .assistant() // Loop only by assistant
    .loopif(
      Validation.isNotGoalSatisfied() // Loop if the goal is not satisfied, this will be determined by LLM
    )
  .subroutine(
    initWith: Subroutine.initWithParent(), // Use the parent session as the initial context
    squashWith: Subroutine.squashWithParent(), // Merge the subroutine result with the parent session
    new Agent()
    .loop()
    .system(
      "You are a research assistant. Help the user with their research." // Original system prompt
      + "Get comments from the user. Follow up on their feedback. If satisfied, exit conversation." // Goal as additional context
    )
    .assistant() // Loop only by assistant
    .tool(Tools.ask_user()) // allow_interaction: true
    .tool(Tools.exit()) // allow_interaction: true    
  )
``` 








You can interact with the user in a more structured way, by defining the data structure of the conversation:
```typescript
import { Agent } from '@prompttrail/core';
const agent = Agent.create()
  .system('You are a customer success agent on a website.')
  .step(
    'Welcome the user and ask what\'s their goal today.',
  )
  .withdata( // Add auto getter / setter for the data
    'user_goal',
    {
      goal: z.string(),
    },
  )
  .step(
    'Ask the user for their name and age and save it to the ',
  )
  .withdata( // Add auto getter / setter for the data
    'user',
    {
      name: z.string(),
      age: z.number().min(0),
    },
  )
  .validate(
    session => {
      const { name, age } = session.getVars();
      return session.setVars({user_info: db.set(name, age)})
    },
    on_failure: "retry",
  )
  ...
```





```

```
import { Agent } from '@prompttrail/core';

const workflow = new Agent()
  .setup(
    z.object({
      name: z.string(),
      age: z.number().min(0),
    }),
  )
  .step(
    "Interact with the user and ask for their name and age",
  ).validate(
    session => {
      const { name, age } = session.getVars();
      return session.setVars({user_info: db.searchUser(name, age)})
    },
    on_failure: "retry",
  )
  
  )


```




## ✨ Features

- 🔒 [**TypeScript-First**](#-typescript-first-design) - Full TypeScript support with inference and generics
- 📝 [**Template-Based**](#%EF%B8%8F-building-templates) - Composable conversation building blocks
- 🧩 [**Composable Patterns**](#-complex-control-flow) - Mix and match templates for complex flows using the `Agent` builder
- 🔌 [**Multi-Provider**](#-model-configuration) - Works with OpenAI, Anthropic, and extensible for more
- 🔄 [**Stateless Architecture**](#-session-management) - Immutable sessions for predictable state management
- 🌊 [**Streaming Support**](#-streaming-responses) - Real-time response streaming
- 📊 [**Context Transformation**](#-context-transformation) - Modify session context during execution using `Transform`
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
import { Agent, createSession, createGenerateOptions } from '@prompttrail/core';

// Define generateOptions for OpenAI
let openAIgenerateOptions = createGenerateOptions({
  provider: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    modelName: 'gpt-4o-mini',
  },
  temperature: 0.7,
});

// Create a simple conversation template using the Agent builder
const chat = new Agent()
  .addSystem("I'm a helpful assistant.")
  .addUser("What's TypeScript?")
  .addAssistant(openAIgenerateOptions);

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

- PromptTrailでは、会話の状態はすべて`Session`オブジェクトに保存されます。
  - `Session`は、`vars`（変数）と`messages`（メッセージ）を持つ不変のオブジェクトです。
    - `vars`は、会話の状態を保持するための構造化されたオブジェクトです。
      - LLMの応答を整形して保存したり、外部から取得した情報を保存して、会話で利用したりすることができます。
        - 例えば、 session.vars == { userName: 'Alice' } のときに、`Hi ${userName}`と書くと、`Hi Alice`に変換されます。
        - varsに情報を保存する方法は、後ほど説明します。
    - `messages`は、会話の履歴を保持する不変の配列です。
      - 例えば、`[{role: 'user', content: 'Hello!'}, {role: 'assistant', content: 'Hi!'}...]`のような形です。
      - `messages`には、`attrs`というメタデータを付与することができます。
        - 例えば、`{role: 'user', content: 'Hello!', attrs: { timestamp: Date.now() }}`のように、メッセージにタイムスタンプを付与することができます。
        - attrsに情報を保存する方法は、後ほど説明します。
- Sessionは、この`vars`と`attrs`を型として持つことができるため、TypeScriptの型推論を利用して、会話の状態を型安全に扱うことができます。

### API Convention

- PromptTrailでは、操作したいオブジェクト名を入力すれば、補完が効くように設計されています。
  - すべてのオブジェクトの生成は、[作りたいもの].create()という形で、`create`メソッドを持っています。
    - 例えば、Session.create() / Vars.create() / Attrs.create() / Agent.create()
  - 会話状態を管理する、Session / Vars / Attrsに関連したデータの更新は、set / extendを使います
    - setは、値を上書きします。extendは、値を追加するので、型が変わる可能性があります
      - Vars.create({userName: `Alice`}).set({userName: `Bob`}) // userNameは`Bob`に上書きされ、返り値はVars<{userName: string}>になります
      - Vars.create({userName: `Alice`}).set({age: `20`}) // これはTypeErrorになります
      - Vars.create({userName: `Alice`}).extend({userName: `Bob`}) // userNameは`Bob`に上書きされ、返り値はVars<{userName: string}>になります
      - Vars.create({userName: `Alice`}).extend({age: `20`}) // これは通りますが、返り値はVars<{userName: string, age: string}>になります
    - 例えば、session.setVars({ userName: 'Alice' }) / session.extendVars({ userName: 'Alice' })
      - extendを使うことで、既存の値に追加することができます。
  - テンプレートの構築は、Agent.create()を使います
    - Fluent APIを使用して、テンプレートを構築することができます。
      - Agent.create().addSystem(...).loopIf(...)
    - Agent(new Loop([System(...), User(...), Assistant(...)]))のような書き方もできます
  - テキスト生成関数も同様です
    - Source.create().useLLM().useOpenAI().setTemperature(...)
    - または、
      - LLMSource.create().openAI().setTemperature(...) // Source.create().useLLM()はLLMSource.create()のエイリアスです
      - CLISource.create().setPrompt(...) // Source.create().useCLI()はCLISource.create()のエイリアスです

- **Session**: Represents a conversation with `context` and `messages`. Immutable.
  ```typescript
  import { createSession } from '@prompttrail/core';
  const session = createSession(); // Creates an empty session
  const sessionWithContext = createSession({ context: { userName: 'Alice' } });
  ```
  - **Context**: A read-only structured object (`Context<T>`) holding conversation state (e.g., user info, settings). Used for interpolation (`Hi ${userName}`) or storing information (`context.loopCounter`).
    ```typescript
    import { createContext, Assistant } from '@prompttrail/core';
    // Context objects have a hidden _type: 'context' property
    const userContext = createContext({ userName: 'Alice', userId: 'u-123' });
    // Usage in interpolation:
    const greeting = new Assistant('Hi ${userName}!'); // Resolves to "Hi Alice!" if context has userName: 'Alice'
    // Accessing values: session.geTVarsValue('userId')
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
    - **Metadata**: Optional read-only data (`Metadata<T>`) attached to messages. Used for storing additional information (e.g., non-default roles, timestamps).
      ```typescript
      import { createMetadata } from '@prompttrail/core';
      const messageWithMeta = {
        type: 'user',
        content: 'User input',
        metadata: createMetadata({
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
- **Agent**: A fluent builder (`new Agent()`) for composing templates sequentially.
  ```typescript
  import { Agent } from '@prompttrail/core';
  const myAgent = new Agent().addSystem('System prompt').addUser('User query');
  // .addAssistant(...) etc.
  ```
- **Source**: Defines where content comes from (`StaticSource`, `LlmSource`, `SchemaSource`, `CLISource`, `CallbackSource`, `RandomSource`, `ListSource`). Passed to templates like `User` or `Assistant`.
  ```typescript
  import { StaticSource, User } from '@prompttrail/core';
  const staticUserMessage = new User(
    new StaticSource('This is a fixed user message.'),
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
  StaticSource,
} from '@prompttrail/core';

// Example of a simple template execution using Agent
const simpleTemplate = new Agent()
  .addSystem('Welcome to the conversation!')
  .addUser('Tell me about TypeScript.')
  .addAssistant(
    new StaticSource('TypeScript is a typed superset of JavaScript.'),
  ); // Use StaticSource for fixed response

const session = await simpleTemplate.execute(
  createSession({
    context: {
      // Context is type-safe if generics are provided
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
import { createSession, Context, Metadata } from '@prompttrail/core';

// Define types for context and metadata
interface MyContext extends Context {
  name: string;
  preferences: {
    theme: 'light' | 'dark';
    language: string;
  };
}
interface MyMetadata extends Metadata {
  timestamp: number;
}

// Type-safe session creation
const session = createSession<MyContext, MyMetadata>({
  context: {
    name: 'Alice',
    preferences: {
      theme: 'dark',
      language: 'TypeScript',
    },
  },
});

// Type-safe context access
const userName = session.geTVarsValue('name'); // Type: string | undefined
const theme = session.geTVarsValue('preferences')?.theme; // Type: 'light' | 'dark' | undefined

// Immutable operations maintain type safety
const updatedSession = session.addMessage({
  type: 'user',
  content: 'Hi',
  metadata: { timestamp: Date.now() }, // Metadata matches MyMetadata
});
const newSession = updatedSession.seTVarsValues({ name: 'Bob' }); // Updates context immutably
```

PromptTrail's immutable architecture ensures predictable state management:

- Session operations (`addMessage`, `seTVarsValue`, `seTVarsValues`) return new `Session` instances.
- Templates operate on sessions without side effects.
- Consistent use of `Context<T>` and `Metadata<T>` ensures type safety.

### 🏗️ Building Templates

Use the `Agent` builder for fluent template composition:

```typescript
import {
  Agent,
  createSession,
  createGenerateOptions,
  User,
  Assistant,
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

// Define context type
interface UserInfo extends Context {
  name: string;
  language: string;
}

// Create a personalized chat using Agent
const techSupportFlow = new Agent<UserInfo>()
  .addSystem("You're a helpful programming assistant.")
  // Interpolate context: ${name}, ${language}
  .addAssistant(`Hello, \${name}! Ready to dive into \${language}?`)
  // Add a user message directly
  .addUser("What's tricky about type inference?")
  // Generate response using LLM
  .addAssistant(openAIgenerateOptions);

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
  ListSource,
  createSession,
  createGenerateOptions,
  Context,
  Metadata,
} from '@prompttrail/core';

// Define generateOptions (assuming openAIgenerateOptions is defined elsewhere)

interface QuizContext extends Context {
  quizComplete?: boolean;
  summary?: string;
}

const quiz = new Agent<QuizContext>() // Use Agent as the main builder
  .addSystem("You're a TypeScript quiz bot.")
  // Greet based on time using addConditional
  .addConditional(
    (session) => new Date().getHours() < 12,
    new Assistant('Good morning!'),
    new Assistant('Good afternoon!'),
  )
  // Quiz loop using addLoop
  .addLoop(
    // Body of the loop is another Agent
    new Agent()
      .addUser(
        new ListSource([
          // Use ListSource for predefined questions/statements
          "What's TypeScript?",
          'Explain type inference.',
          "I'm satisfied now.", // Loop exit trigger
        ]),
      )
      .addAssistant(openAIgenerateOptions), // LLM answers the question
    // Loop condition: Continue as long as the last user message doesn't indicate satisfaction
    (session) => {
      const lastUserMessage = session.getMessagesByType('user').pop();
      // Loop if no user message yet OR if the last user message doesn't contain 'satisfied'
      return !lastUserMessage?.content.toLowerCase().includes('satisfied');
    },
  )
  // Subroutine to summarize the quiz
  .addSubroutine(
    // Subroutine body (an Agent)
    new Agent()
      .addSystem(
        'You are an educational coach. Write a three-sentence summary of the conversation and suggest one topic for further study.',
      )
      .addAssistant(openAIgenerateOptions), // LLM generates the summary
    {
      // Subroutine options
      // initWith: (optional) Customize how the subroutine session starts. Default clones parent.
      // squashWith: Customize how the subroutine result merges back.
      squashWith: (parentSession, subroutineSession) => {
        const summaryMessage = subroutineSession.getLastMessage();
        if (summaryMessage?.type === 'assistant') {
          // Add the summary to the parent context instead of as a message
          return parentSession.seTVarsValues({
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
  .addAssistant(
    new Assistant(
      (session) =>
        `Quiz finished! 🚀\n**Summary:**\n${session.geTVarsValue('summary', 'No summary generated.')}`,
    ),
  );

// Execute the quiz
const session = await quiz.execute(createSession<QuizContext>({ print: true }));

console.log('Final Context:', session.geTVarsObject());
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
import type { Context, Metadata } from '@prompttrail/core';

interface MyContext extends Context {
  userId: string;
  language: string;
  tone: string;
  topics: string[];
}
interface MyMetadata extends Metadata {
  timestamp?: number;
}

// Create a session with initial context
const initialSession = createSession<MyContext, MyMetadata>({
  context: {
    userId: 'user-123',
    language: 'TypeScript',
    tone: 'professional',
    topics: ['generics', 'type inference', 'utility types'],
  },
  print: true,
});

// Templates use ${variable} syntax for context interpolation
const template = new Agent<MyContext, MyMetadata>() // Specify types for Agent
  .addSystem(`I'll use \${tone} language to explain \${topics[0]}`)
  .addAssistant(`Let me explain \${topics[0]} in \${language}`)
  .addUser(`Can you also cover \${topics[1]}?`);

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
const sessionWithNewTone = sessionWithMessage.seTVarsValues({
  tone: 'casual', // Update existing key
  lastInteraction: Date.now(), // Add new key
});

console.log('Original tone:', sessionWithMessage.geTVarsValue('tone')); // professional
console.log('New tone:', sessionWithNewTone.geTVarsValue('tone')); // casual

// Serialize/deserialize (useful for saving/loading state)
const json = sessionWithNewTone.toJSON();
console.log('Session JSON:', JSON.stringify(json, null, 2));
// const loadedSession = Session.fromJSON<MyContext, MyMetadata>(json); // Deserialize
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

### 📊 Context Transformation

Modify session context during template execution using the `Transform` template:

```typescript
import { Agent, Transform, createSession } from '@prompttrail/core';
import type { Context } from '@prompttrail/core';

interface ServerInfoContext extends Context {
  ipAddress?: string;
  uptime?: number;
  status?: string;
}

// Example: Extract data using regex and update context
const dataExtractionAgent = new Agent<ServerInfoContext>()
  .addUser('Server status: IP 192.168.1.100, Uptime 99.99%, Status: Running')
  // Add a transform step
  .addTransform((session) => {
    const lastMessageContent = session.getLastMessage()?.content || '';
    const updatedContext: Partial<ServerInfoContext> = {}; // Store updates

    // Extract IP Address
    const ipMatch = lastMessageContent.match(/IP ([\d\.]+)/);
    if (ipMatch) {
      updatedContext.ipAddress = ipMatch[1];
    }

    // Extract and transform Uptime
    const uptimeMatch = lastMessageContent.match(/Uptime ([\d\.]+)%/);
    if (uptimeMatch) {
      updatedContext.uptime = parseFloat(uptimeMatch[1]) / 100;
    }

    // Extract Status
    const statusMatch = lastMessageContent.match(/Status: (\w+)/);
    if (statusMatch) {
      updatedContext.status = statusMatch[1];
    }

    // Return a new session with the updated context values
    return session.seTVarsValues(updatedContext);
  });

// Execute the agent
const dataSession =
  await dataExtractionAgent.execute(createSession<ServerInfoContext>());

// Access the extracted data from the final session context
console.log('IP:', dataSession.geTVarsValue('ipAddress')); // "192.168.1.100"
console.log('Uptime:', dataSession.geTVarsValue('uptime')); // 0.9999
console.log('Status:', dataSession.geTVarsValue('status')); // "Running"
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
const petNameAgent = new Agent()
  .addSystem('You are a helpful assistant that suggests pet names.')
  .addUser('Suggest a single, short, appropriate name for a pet cat.')
  // Add assistant with validation options
  .addAssistant(openAIgenerateOptions, validationOptions);

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
    const maxWords = session?.geTVarsValue('maxWords', 5); // Example: Get limit from context
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
const shortAnswerAgent = new Agent()
  .addSystem('Answer concisely.')
  .addUser('Explain quantum physics briefly.')
  .addAssistant(openAIgenerateOptions, {
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

// Note: Validators can also be applied to Sources like CLISource, CallbackSource, etc.
// Example: new CLISource("Enter name:", { validator: lengthValidator })
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
const productExtractorAgent = new Agent()
  .addSystem(
    'Extract product information from the user query into the provided schema.',
  )
  .addUser(
    'Tell me about the Pixel 8. It costs $699, is in stock, and has a great camera and AI features.',
  )
  // Add the Structured template - it will generate an assistant message
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
const weatherAgent = new Agent()
  .addSystem("I'm a weather assistant. Use the available tools.")
  .addUser("What's the weather like in New York?")
  // The assistant might respond directly or make a tool call
  .addAssistant(toolEnhancedOptions);

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
const mcpAgent = new Agent()
  .addSystem(
    'You are a helpful assistant with access to research tools via MCP.',
  )
  .addUser('Can you search for the latest papers on LLM reasoning?')
  .addAssistant(optionsWithMCP); // Use the options with MCP configured

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
const browserAgent = new Agent()
  .addSystem('You are a helpful assistant running in the browser.')
  .addUser('Hello from the browser!')
  .addAssistant(browserOptions);

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
