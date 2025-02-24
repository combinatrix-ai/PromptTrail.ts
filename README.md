# 🚀 PromptTrail

Welcome to PromptTrail! We're here to make your LLM conversations more structured, type-safe, and fun. Whether you're building a chatbot, coding assistant, or any AI-powered application, PromptTrail helps you create robust conversations with popular LLM providers like OpenAI and Anthropic.

## ✨ What's Cool About PromptTrail?

- 📝 **Smart Templates**: Build conversations like Lego - piece by piece!
- 🔄 **Interactive Loops**: Create dynamic, branching conversations
- 🛠️ **Tool Power**: Let your LLMs use real functions
- 🔌 **Multi-Provider**: Works with OpenAI, Anthropic, and more
- 📝 **Type-Safe**: Full TypeScript support - catch errors before they happen
- 🌊 **Streaming**: Get responses in real-time
- 🧩 **Composable**: Mix and match templates for complex flows
- 🌐 **Browser Ready**: Works seamlessly in both Node.js and browser environments

## 🚀 Getting Started

First, let's get PromptTrail installed:

```bash
pnpm add @prompttrail/core
```

Here's a quick CLI chat example:

```typescript
import { LinearTemplate, OpenAIModel, createSession } from '@prompttrail/core';

// Set up your model
const model = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4o-mini',
});

// Create an interactive chat
const chat = new LinearTemplate()
  .addSystem("Hi! I'm a friendly assistant.")
  .addLoop(
    new LoopTemplate()
      .addUser("What's on your mind? (type 'exit' to end)")
      .addAssistant({ model })
      .setExitCondition(
        (session) => session.getLastMessage()?.content.toLowerCase() === 'exit',
      ),
  );

// Start chatting with print mode enabled
const session = await chat.execute(
  createSession({ print: true }), // Prints conversation flow
);
```

## 🎨 Building Conversations

### 🏗️ Templates: Your Building Blocks

Templates are like conversation blueprints, with support for metadata interpolation:

```typescript
// Create a personalized chat with metadata interpolation
interface UserPreferences {
  name: string;
  language: string;
  expertise: {
    level: 'beginner' | 'intermediate' | 'expert';
    topics: string[];
  };
}

const personalizedChat = new LinearTemplate()
  .addSystem("I'll adapt to your preferences.")
  .addAssistant('Hello ${name}! How can I help with ${expertise.topics[0]}?') // Context with interpolation
  .addUser({ inputSource: new CLIInputSource() }) // Get real user input
  .addAssistant('Should I explain in ${language}?') // Predefined response with interpolation
  .addUser('Yes, please explain in ${language}') // Impersonate user
  .addAssistant({ model }); // Let model generate response

// Use with session metadata
const session = await personalizedChat.execute(
  createSession<UserPreferences>({
    metadata: {
      name: 'Alice',
      language: 'TypeScript',
      expertise: {
        level: 'intermediate',
        topics: ['generics', 'type inference'],
      },
    },
    print: true, // See the conversation flow
  }),
);
```

### 🤖 Choosing Your AI Friend

Pick your favorite AI and customize how it thinks:

```typescript
// Chat with OpenAI
const gpt4 = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4o-mini',
  temperature: 0.7, // Make it more creative!
});

// Chat with Claude
const claude = new AnthropicModel({
  apiKey: process.env.ANTHROPIC_API_KEY,
  modelName: 'claude-3-5-haiku-latest',
});
```

### 🔄 Making Interactive Chats

Create conversations that adapt and respond:

```typescript
const quiz = new LinearTemplate()
  .addSystem("I'm your friendly TypeScript quiz master!")
  .addLoop(
    new LoopTemplate()
      .addUser('Ready for a TypeScript question?')
      .addAssistant({ model })
      .addUser('Here is my answer:', 'interfaces are awesome!')
      .addAssistant({ model })
      .addUser('Another question? (yes/no)', 'yes')
      .setExitCondition(
        (session) => session.getLastMessage()?.content.toLowerCase() === 'no',
      ),
  );
```

### 💾 Managing Chat History

Keep track of your conversations with type-safe sessions:

```typescript
// Start a fresh chat
const session = createSession();

// Enable printing for CLI apps
const cliSession = createSession({
  print: true, // Prints conversation flow
});

// Add some personality
interface ChatStyle {
  tone: 'casual' | 'professional';
  emoji: boolean;
}

const funChat = createSession<ChatStyle>({
  metadata: {
    tone: 'casual',
    emoji: true,
  },
  print: true, // See the conversation unfold
});

// Add messages, get history, validate state
session.addMessage({
  type: 'user',
  content: 'Hello!',
}); // Returns new session (immutable!)

session.getLastMessage(); // Latest message
session.getMessagesByType('user'); // All user messages

// Update preferences
const proMode = session.updateMetadata({
  tone: 'professional',
});

// Save for later
const json = session.toJSON();
const restored = Session.fromJSON(json);
```

### 🌊 Streaming Responses

Watch the AI think in real-time:

```typescript
const model = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4o-mini',
});

// See responses as they come
for await (const chunk of model.sendAsync(session)) {
  process.stdout.write(chunk.content);
}
```

### 🛠️ Adding Special Powers

Give your AI helper some real-world capabilities:

```typescript
// Create a friendly calculator
const calculator = new Tool({
  name: 'calculator',
  description: 'Add numbers together',
  schema: {
    type: 'object',
    properties: {
      a: { type: 'number', description: 'First number' },
      b: { type: 'number', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
  execute: async (input) => ({ result: input.a + input.b }),
});

// Use tools in chat
const smartModel = new OpenAIModel({
  apiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4o-mini',
  tools: [calculator],
});

const mathChat = new LinearTemplate()
  .addSystem("I'm great at math!")
  .addUser("What's 123 + 456?")
  .addAssistant({ model: smartModel });
```

### 🌐 Browser Support

PromptTrail works seamlessly in browser environments! Check out our [React Chat Example](examples/react-chat) to see a complete implementation. Here's how to use PromptTrail in a React application:

```typescript
import { useState } from 'react';
import { LinearTemplate, OpenAIModel, createSession } from '@prompttrail/core';

function ChatComponent() {
  const [messages, setMessages] = useState([]);
  const [session, setSession] = useState(() => createSession());

  const sendMessage = async (userInput) => {
    // Create model with browser support enabled
    const model = new OpenAIModel({
      apiKey: 'YOUR_API_KEY', // In production, fetch this securely from your backend
      modelName: 'gpt-4o-mini',
      temperature: 0.7,
      dangerouslyAllowBrowser: true, // Required for browser use
    });

    // Create chat template
    const template = new LinearTemplate()
      .addSystem('You are a helpful AI assistant.')
      .addUser('User message:', userInput)
      .addAssistant({ model });

    // Execute template and update session
    const newSession = await template.execute(session);
    setSession(newSession);

    // Get assistant's response
    const response = newSession.getMessagesByType('assistant').slice(-1)[0];
    if (response) {
      setMessages(prev => [...prev, { content: response.content, isUser: false }]);
    }
  };

  return (
    <div>
      {/* Your chat UI components */}
    </div>
  );
}
```

For a complete example with UI components and error handling, check out the [React Chat Example](examples/react-chat).

## 📚 API Explorer

Your IDE is your best friend! We've packed PromptTrail with TypeScript goodies:

- 💡 Hover over anything for instant docs
- ⚡ Autocomplete everywhere
- 🔍 Jump-to-definition (F12) for deep dives

Here are the main pieces you'll play with:

```typescript
import {
  // Chat building
  LinearTemplate, // Your basic chat flow
  LoopTemplate, // For interactive chats

  // AI friends
  OpenAIModel, // Chat with GPT
  AnthropicModel, // Chat with Claude

  // Utilities
  createSession, // Start chatting
  Tool, // Add special powers
} from '@prompttrail/core';
```

## 🤝 Join the Fun!

Love PromptTrail? Found a bug? Have an idea? We'd love to hear from you! Feel free to:

- 🐛 Report issues
- 💡 Suggest features
- 🎨 Submit pull requests

## 📜 License

MIT - Go build something awesome! 🚀
