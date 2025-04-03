# @prompttrail/react

React hooks for [PromptTrail.ts](https://github.com/combinatrix-ai/PromptTrail.ts) - a TypeScript library for LLM prompt engineering.

## Installation

PromptTrail is not currently available on npm. To use this package, you'll need to install it directly from GitHub:

```bash
# Using npm
npm install github:combinatrix-ai/PromptTrail.ts#main

# Using yarn
yarn add github:combinatrix-ai/PromptTrail.ts#main

# Using pnpm
pnpm add github:combinatrix-ai/PromptTrail.ts#main
```

For development or to use a specific branch:

```bash
# Clone the repository
git clone https://github.com/combinatrix-ai/PromptTrail.ts.git
cd PromptTrail.ts

# Install dependencies
pnpm install

# Build the packages
pnpm run build
```

## Usage

```tsx
import React from 'react';
import { LinearTemplate, createGenerateOptions } from '@prompttrail/core';
import { useSession, useMessages, useInputSource } from '@prompttrail/react';

function ChatComponent() {
  // Create an input source with React state
  const { value: input, setValue: setInput, inputSource } = useInputSource('');
  
  // Create and manage a session
  const { session, executeTemplate, isLoading } = useSession();
  
  // Get messages from the session
  const messages = useMessages(session);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;
    
    // Define generateOptions for your LLM provider
    const generateOptions = createGenerateOptions({
      model: 'gpt-3.5-turbo',
      apiKey: 'your-api-key',
    });

    // Create a template
    const template = new LinearTemplate()
      .addSystem('You are a helpful assistant.')
      .addUser(input)
      .addAssistant({ generateOptions });

    // Execute the template with the current session
    await executeTemplate(template);
    
    // Clear input after sending
    setInput('');
  };

  return (
    <div>
      <div className="messages">
        {messages.map((message, index) => (
          <div key={index} className={`message ${message.type}`}>
            {message.content}
          </div>
        ))}
      </div>
      
      <div className="input-area">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          disabled={isLoading}
        />
        <button onClick={sendMessage} disabled={isLoading}>
          {isLoading ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
```

## Available Hooks

### useInputSource

Creates an input source backed by React state.

```tsx
const { value, setValue, inputSource } = useInputSource(initialValue);
```

### useSession

Manages a PromptTrail session.

```tsx
const {
  session,
  executeTemplate,
  addMessage,
  updateMetadata,
  setSession,
  isLoading,
  error
} = useSession(initialSession);
```

### useMessages

Extracts messages from a session.

```tsx
const messages = useMessages(session);
```

### useMessagesByType

Extracts messages of a specific type from a session.

```tsx
const userMessages = useMessagesByType(session, 'user');
const assistantMessages = useMessagesByType(session, 'assistant');
```

## Development

This package is part of the PromptTrail.ts monorepo. To contribute:

1. Clone the repository
2. Install dependencies with `pnpm install`
3. Build the packages with `pnpm run build`
4. Run tests with `pnpm run test`

## License

MIT
