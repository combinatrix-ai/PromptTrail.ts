import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import type { Session } from '../session';
import type { Message } from '../message';

/**
 * Input resolver for handling async input requests
 */
interface InputResolver {
  id: string;
  prompt: string;
  defaultValue?: string;
  resolve: (value: string) => void;
}

/**
 * Main debug interface component
 */
const DebugInterface: React.FC<{
  session: Session<any, any>;
  currentInput?: InputResolver;
  onUserInput: (inputId: string, value: string) => void;
}> = ({ session, currentInput, onUserInput }) => {
  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="round" borderColor="blue" padding={1} marginBottom={1}>
        <Text color="cyan">🚀 PromptTrail Debug Session</Text>
        <Text color="gray">
          {' '}
          • Messages: {session.messages.length} • Variables: {session.varsSize}
        </Text>
      </Box>

      {/* Conversation Area */}
      <Box flexGrow={1} flexDirection="column" marginBottom={1}>
        <ConversationHistory session={session} />
      </Box>

      {/* Variables Panel */}
      {session.varsSize > 0 && (
        <Box
          borderStyle="single"
          borderColor="gray"
          padding={1}
          marginBottom={1}
        >
          <VariablesPanel vars={session.vars} />
        </Box>
      )}

      {/* Input Area */}
      {currentInput && (
        <Box borderStyle="round" borderColor="green" padding={1}>
          <InputArea inputResolver={currentInput} onSubmit={onUserInput} />
        </Box>
      )}
    </Box>
  );
};

/**
 * Conversation history display
 */
const ConversationHistory: React.FC<{ session: Session<any, any> }> = ({
  session,
}) => {
  const maxMessages = 10; // Limit display to prevent overflow
  const messages = session.messages.slice(-maxMessages);

  return (
    <Box flexDirection="column">
      {messages.length > 0 ? (
        messages.map((message, index) => (
          <MessageBubble
            key={`${session.messages.length - maxMessages + index}`}
            message={message}
          />
        ))
      ) : (
        <Text color="gray" italic>
          No messages yet...
        </Text>
      )}
    </Box>
  );
};

/**
 * Individual message display
 */
const MessageBubble: React.FC<{ message: Message<any> }> = ({ message }) => {
  const getMessageStyle = (type: string) => {
    switch (type) {
      case 'system':
        return { color: 'yellow', icon: '🤖', label: 'System' };
      case 'user':
        return { color: 'blue', icon: '👤', label: 'User' };
      case 'assistant':
        return { color: 'green', icon: '🤖', label: 'Assistant' };
      case 'tool_result':
        return { color: 'magenta', icon: '🔧', label: 'Tool' };
      default:
        return { color: 'white', icon: '📝', label: 'Unknown' };
    }
  };

  const style = getMessageStyle(message.type);
  const truncatedContent =
    message.content.length > 200
      ? message.content.substring(0, 200) + '...'
      : message.content;

  return (
    <Box marginY={1}>
      <Box>
        <Text color={style.color} bold>
          {style.icon} {style.label}:
        </Text>
        <Text> {truncatedContent}</Text>
      </Box>

      {message.toolCalls && message.toolCalls.length > 0 && (
        <Box marginLeft={3} marginTop={1}>
          <ToolCallsDisplay calls={message.toolCalls} />
        </Box>
      )}
    </Box>
  );
};

/**
 * Tool calls display
 */
const ToolCallsDisplay: React.FC<{ calls: any[] }> = ({ calls }) => (
  <Box flexDirection="column">
    {calls.map((call, index) => (
      <Box key={index}>
        <Text color="cyan">🔧 {call.name}(</Text>
        <Text color="gray">{JSON.stringify(call.arguments)}</Text>
        <Text color="cyan">)</Text>
      </Box>
    ))}
  </Box>
);

/**
 * Variables panel display
 */
const VariablesPanel: React.FC<{ vars: any }> = ({ vars }) => {
  const varsString = JSON.stringify(vars, null, 2);
  const truncatedVars =
    varsString.length > 300 ? varsString.substring(0, 300) + '...' : varsString;

  return (
    <Box>
      <Text color="magenta" bold>
        📊 Variables:
      </Text>
      <Text color="gray"> {truncatedVars}</Text>
    </Box>
  );
};

/**
 * Input area with real-time typing
 */
const InputArea: React.FC<{
  inputResolver: InputResolver;
  onSubmit: (inputId: string, value: string) => void;
}> = ({ inputResolver, onSubmit }) => {
  const [input, setInput] = useState(inputResolver.defaultValue || '');
  const { exit } = useApp();

  useInput((inputChar: string, key: any) => {
    if (key.return) {
      onSubmit(inputResolver.id, input);
      setInput('');
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (key.ctrl && inputChar === 'c') {
      exit();
    } else if (!key.ctrl && !key.meta && inputChar) {
      setInput((prev) => prev + inputChar);
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        {inputResolver.prompt}
      </Text>
      <Box>
        <Text color="yellow">➤ </Text>
        <Text>{input}</Text>
        <Text color="gray">_</Text>
      </Box>
      <Text color="gray" dimColor>
        Press Enter to submit • Ctrl+C to exit
      </Text>
    </Box>
  );
};

/**
 * Ink Debug Renderer - manages the React app lifecycle
 */
export class InkDebugRenderer {
  private session: Session<any, any>;
  private app: any;
  private inputResolvers: Map<string, InputResolver> = new Map();
  private currentInputResolver: InputResolver | undefined;
  private isShuttingDown = false;

  constructor(session: Session<any, any>) {
    this.session = session;
  }

  /**
   * Start the Ink interface
   */
  async start(): Promise<void> {
    this.app = render(
      <DebugInterface
        session={this.session}
        currentInput={this.currentInputResolver}
        onUserInput={this.handleUserInput}
      />,
    );
  }

  /**
   * Check if the renderer is running
   */
  isRunning(): boolean {
    return !!this.app && !this.isShuttingDown;
  }

  /**
   * Get user input through the interface
   */
  async getUserInput(
    prompt: string,
    defaultValue?: string,
    session?: Session<any, any>,
  ): Promise<string> {
    if (this.isShuttingDown) {
      throw new Error('Ink interface is shutting down');
    }

    // Update session if provided
    if (session) {
      this.updateConversation(session);
    }

    return new Promise((resolve) => {
      const inputId = `input-${Date.now()}-${Math.random()}`;
      const inputResolver: InputResolver = {
        id: inputId,
        prompt,
        defaultValue,
        resolve,
      };

      this.inputResolvers.set(inputId, inputResolver);
      this.currentInputResolver = inputResolver;

      // Re-render with new input prompt
      this.rerender();
    });
  }

  /**
   * Update the conversation display
   */
  updateConversation(session: Session<any, any>): void {
    if (this.isShuttingDown) return;

    this.session = session;
    this.rerender();
  }

  /**
   * Shutdown the interface
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Resolve any pending input with empty string
    this.inputResolvers.forEach((resolver) => {
      resolver.resolve('');
    });
    this.inputResolvers.clear();

    if (this.app?.unmount) {
      this.app.unmount();
    }
    this.app = null;
  }

  /**
   * Handle user input submission
   */
  private handleUserInput = (inputId: string, value: string): void => {
    const resolver = this.inputResolvers.get(inputId);
    if (resolver) {
      resolver.resolve(value);
      this.inputResolvers.delete(inputId);
      this.currentInputResolver = undefined;
      this.rerender();
    }
  };

  /**
   * Re-render the interface
   */
  private rerender(): void {
    if (this.isShuttingDown || !this.app) return;

    this.app.rerender(
      <DebugInterface
        session={this.session}
        currentInput={this.currentInputResolver}
        onUserInput={this.handleUserInput}
      />,
    );
  }
}
