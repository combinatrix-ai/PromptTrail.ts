import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import type { Session } from '../session';
import type { Message } from '../message';
import type {
  DebugEvent,
  DebugSessionMetadata,
  VariableInfo,
  DebugUIState,
  DebugEventType,
} from './debug-types';
import { debugEvents } from './debug-events';

/**
 * Input resolver for handling async input requests
 */
interface InputResolver {
  id: string;
  prompt: string;
  defaultValue?: string;
  resolve: (value: string) => void;
}

interface EnhancedDebugProps<
  TContext extends Record<string, any> = Record<string, any>,
  TMetadata extends Record<string, any> = Record<string, any>
> {
  session: Session<TContext, TMetadata>;
  events: DebugEvent[];
  metadata: DebugSessionMetadata;
  currentInput?: InputResolver;
  onUserInput: (inputId: string, value: string) => void;
}

/**
 * Enhanced Debug Interface with multi-panel layout
 */
const EnhancedDebugInterface = <
  TContext extends Record<string, any> = Record<string, any>,
  TMetadata extends Record<string, any> = Record<string, any>
>({
  session,
  events,
  metadata,
  currentInput,
  onUserInput,
}: EnhancedDebugProps<TContext, TMetadata>) => {
  const [uiState, setUIState] = useState<DebugUIState>({
    activePanel: 'conversation',
    eventFilter: 'all',
    showMetadata: false,
    autoScroll: true,
    expandedVariables: new Set(),
    selectedMessageIndex: undefined,
  });

  // Handle keyboard navigation
  useInput((input: string, key: any) => {
    if (key.tab) {
      setUIState((prev) => ({
        ...prev,
        activePanel: getNextPanel(prev.activePanel),
      }));
    } else if (input === 'v') {
      setUIState((prev) => ({
        ...prev,
        activePanel: 'variables',
      }));
    } else if (input === 'e') {
      setUIState((prev) => ({
        ...prev,
        activePanel: 'events',
      }));
    } else if (input === 'm') {
      setUIState((prev) => ({
        ...prev,
        showMetadata: !prev.showMetadata,
      }));
    }
  });

  const getNextPanel = (current: string): DebugUIState['activePanel'] => {
    const panels: DebugUIState['activePanel'][] = [
      'conversation',
      'variables',
      'events',
      'templates',
    ];
    const currentIndex = panels.indexOf(current as any);
    return panels[(currentIndex + 1) % panels.length];
  };

  return (
    <Box flexDirection="column" height="100%">
      {/* Enhanced Header */}
      <EnhancedHeader metadata={metadata} />

      {/* Main Content Area */}
      <Box flexGrow={1} flexDirection="row">
        {/* Left Panel - Conversation */}
        <Box flexGrow={2} flexDirection="column" marginRight={1}>
          <Box
            borderStyle={
              uiState.activePanel === 'conversation' ? 'double' : 'single'
            }
            borderColor={
              uiState.activePanel === 'conversation' ? 'cyan' : 'gray'
            }
            padding={1}
            flexGrow={1}
          >
            <ConversationPanel
              session={session}
              showMetadata={uiState.showMetadata}
              selectedIndex={uiState.selectedMessageIndex}
            />
          </Box>
        </Box>

        {/* Right Panel - Inspector */}
        <Box flexGrow={1} flexDirection="column">
          {/* Variables Panel */}
          <Box
            borderStyle={
              uiState.activePanel === 'variables' ? 'double' : 'single'
            }
            borderColor={uiState.activePanel === 'variables' ? 'cyan' : 'gray'}
            padding={1}
            height="50%"
            marginBottom={1}
          >
            <VariablesInspector
              session={session}
              expandedVars={uiState.expandedVariables}
              onToggleExpand={(varName: string) => {
                setUIState((prev: DebugUIState) => {
                  const newExpanded = new Set(prev.expandedVariables);
                  if (newExpanded.has(varName)) {
                    newExpanded.delete(varName);
                  } else {
                    newExpanded.add(varName);
                  }
                  return { ...prev, expandedVariables: newExpanded };
                });
              }}
            />
          </Box>

          {/* Events Panel */}
          <Box
            borderStyle={uiState.activePanel === 'events' ? 'double' : 'single'}
            borderColor={uiState.activePanel === 'events' ? 'cyan' : 'gray'}
            padding={1}
            flexGrow={1}
          >
            <EventsStream
              events={events}
              filter={uiState.eventFilter}
              onFilterChange={(filter: DebugEventType | 'all') => {
                setUIState((prev) => ({ ...prev, eventFilter: filter }));
              }}
            />
          </Box>
        </Box>
      </Box>

      {/* Bottom Panels */}
      <Box flexDirection="column">
        {/* Input Area */}
        {currentInput && (
          <Box
            borderStyle="round"
            borderColor="green"
            padding={1}
            marginBottom={1}
          >
            <InputArea inputResolver={currentInput} onSubmit={onUserInput} />
          </Box>
        )}

        {/* Controls Footer */}
        <ControlsFooter activePanel={uiState.activePanel} />
      </Box>
    </Box>
  );
};

/**
 * Enhanced header with session metadata
 */
const EnhancedHeader: React.FC<{ metadata: DebugSessionMetadata }> = ({
  metadata,
}: { metadata: DebugSessionMetadata }) => {
  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  };

  const statusColor =
    metadata.status === 'active'
      ? 'green'
      : metadata.status === 'error'
        ? 'red'
        : 'yellow';

  return (
    <Box borderStyle="round" borderColor="blue" padding={1} marginBottom={1}>
      <Box flexDirection="column">
        <Box>
          <Text color="cyan" bold>
            🚀 PromptTrail Debug Session
          </Text>
          <Text color="gray"> • Session: {metadata.sessionId}</Text>
        </Box>
        <Box>
          <Text color="white">
            ⏱️ Started: {new Date(metadata.startTime).toLocaleTimeString()}
          </Text>
          <Text color="white">
            {' '}
            • Duration: {formatDuration(metadata.duration)}
          </Text>
          <Text color={statusColor}> • Status: {metadata.status}</Text>
        </Box>
        <Box>
          <Text color="blue">📊 Messages: {metadata.messageCount}</Text>
          <Text color="magenta"> • Variables: {metadata.varsCount}</Text>
          <Text color="yellow"> • Events: {metadata.eventCount}</Text>
          <Text color="cyan"> • Tools: {metadata.toolCallCount}</Text>
        </Box>
      </Box>
    </Box>
  );
};

/**
 * Enhanced conversation panel with metadata
 */
const ConversationPanel = <
  TContext extends Record<string, any> = Record<string, any>,
  TMetadata extends Record<string, any> = Record<string, any>
>({
  session,
  showMetadata,
  selectedIndex,
}: {
  session: Session<TContext, TMetadata>;
  showMetadata: boolean;
  selectedIndex?: number;
}) => {
  const maxMessages = 8;
  const messages = session.messages.slice(-maxMessages);

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        💬 Conversation History
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {messages.length > 0 ? (
          messages.map((message: Message<TMetadata>, index: number) => (
            <EnhancedMessageBubble
              key={`${session.messages.length - maxMessages + index}`}
              message={message}
              index={session.messages.length - maxMessages + index}
              showMetadata={showMetadata}
              isSelected={selectedIndex === index}
            />
          ))
        ) : (
          <Text color="gray" italic>
            No messages yet...
          </Text>
        )}
      </Box>
    </Box>
  );
};

/**
 * Enhanced message bubble with metadata
 */
const EnhancedMessageBubble = <
  TMetadata extends Record<string, any> = Record<string, any>
>({
  message,
  index,
  showMetadata,
  isSelected,
}: {
  message: Message<TMetadata>;
  index: number;
  showMetadata: boolean;
  isSelected: boolean;
}) => {
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
    message.content.length > 150
      ? message.content.substring(0, 150) + '...'
      : message.content;

  return (
    <Box
      marginY={1}
      borderStyle={isSelected ? 'single' : undefined}
      borderColor={isSelected ? 'cyan' : undefined}
      padding={isSelected ? 1 : 0}
    >
      <Box flexDirection="column">
        <Box>
          <Text color={style.color} bold>
            {style.icon} {style.label} #{index}:
          </Text>
          <Text> {truncatedContent}</Text>
        </Box>

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <Box marginLeft={3} marginTop={1}>
            <EnhancedToolCallsDisplay calls={message.toolCalls} />
          </Box>
        )}

        {/* Metadata */}
        {showMetadata && (
          <Box marginLeft={3} marginTop={1}>
            <Text color="gray" dimColor>
              Timestamp: {new Date().toLocaleTimeString()} • Length:{' '}
              {message.content.length} chars
              {message.toolCalls && ` • Tools: ${message.toolCalls.length}`}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

/**
 * Enhanced tool calls display
 */
const EnhancedToolCallsDisplay: React.FC<{ calls: any[] }> = ({ calls }: { calls: any[] }) => (
  <Box flexDirection="column">
    {calls.map((call: any, index: number) => (
      <Box key={index} marginBottom={1}>
        <Box>
          <Text color="cyan" bold>
            🔧 {call.name}
          </Text>
        </Box>
        <Box marginLeft={2}>
          <Text color="gray">Input: {JSON.stringify(call.arguments)}</Text>
        </Box>
        {call.result && (
          <Box marginLeft={2}>
            <Text color="green">
              Output: {JSON.stringify(call.result).substring(0, 100)}...
            </Text>
          </Box>
        )}
      </Box>
    ))}
  </Box>
);

/**
 * Enhanced variables inspector
 */
const VariablesInspector = <
  TContext extends Record<string, any> = Record<string, any>,
  TMetadata extends Record<string, any> = Record<string, any>
>({
  session,
  expandedVars,
  onToggleExpand,
}: {
  session: Session<TContext, TMetadata>;
  expandedVars: Set<string>;
  onToggleExpand: (varName: string) => void;
}) => {
  const variables = useMemo(() => {
    const vars: VariableInfo[] = [];
    const sessionVars = session.vars || {};

    Object.entries(sessionVars).forEach(([name, value]) => {
      vars.push({
        name,
        value,
        type: typeof value,
        category: getCategoryForVariable(name),
        changeCount: 0, // TODO: Track changes
      });
    });

    return vars.sort((a, b) => a.category.localeCompare(b.category));
  }, [session.vars]);

  const getCategoryForVariable = (name: string): VariableInfo['category'] => {
    if (
      name.includes('count') ||
      name.includes('used') ||
      name.includes('iteration')
    ) {
      return 'counter';
    }
    if (name.includes('tool') || name.includes('result')) {
      return 'tool_result';
    }
    if (['userName', 'sessionId', 'startTime'].includes(name)) {
      return 'core';
    }
    return 'user';
  };

  const groupedVars = useMemo(() => {
    const groups: Record<string, VariableInfo[]> = {};
    variables.forEach((variable: VariableInfo) => {
      if (!groups[variable.category]) {
        groups[variable.category] = [];
      }
      groups[variable.category].push(variable);
    });
    return groups;
  }, [variables]);

  return (
    <Box flexDirection="column">
      <Text color="magenta" bold>
        📊 Variables Inspector ({variables.length})
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {Object.entries(groupedVars).map(([category, vars]) => (
          <VariableGroup
            key={category}
            category={category}
            variables={vars}
            expandedVars={expandedVars}
            onToggleExpand={onToggleExpand}
          />
        ))}
      </Box>
    </Box>
  );
};

/**
 * Variable group display
 */
const VariableGroup: React.FC<{
  category: string;
  variables: VariableInfo[];
  expandedVars: Set<string>;
  onToggleExpand: (varName: string) => void;
}> = ({ category, variables, expandedVars, onToggleExpand }: {
  category: string;
  variables: VariableInfo[];
  expandedVars: Set<string>;
  onToggleExpand: (varName: string) => void;
}) => {
  const categoryColors = {
    core: 'cyan',
    counter: 'yellow',
    tool_result: 'magenta',
    user: 'blue',
    system: 'gray',
  };

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text
        color={categoryColors[category as keyof typeof categoryColors]}
        bold
      >
        ┌─ {category.toUpperCase()} ({variables.length})
      </Text>
      {variables.map((variable: VariableInfo) => {
        const isExpanded = expandedVars.has(variable.name);
        const displayValue = isExpanded
          ? JSON.stringify(variable.value, null, 2)
          : JSON.stringify(variable.value).substring(0, 50);

        return (
          <Box key={variable.name} marginLeft={1}>
            <Text color="white">│ {variable.name}:</Text>
            <Text color="gray">
              {displayValue}
              {!isExpanded &&
                JSON.stringify(variable.value).length > 50 &&
                '...'}
            </Text>
          </Box>
        );
      })}
      <Text color={categoryColors[category as keyof typeof categoryColors]}>
        └─────────────────────────
      </Text>
    </Box>
  );
};

/**
 * Events stream panel
 */
const EventsStream: React.FC<{
  events: DebugEvent[];
  filter: DebugEventType | 'all';
  onFilterChange: (filter: DebugEventType | 'all') => void;
}> = ({ events, filter }: {
  events: DebugEvent[];
  filter: DebugEventType | 'all';
  onFilterChange: (filter: DebugEventType | 'all') => void;
}) => {
  const filteredEvents = useMemo(() => {
    return filter === 'all'
      ? events.slice(-10)
      : events.filter((event: DebugEvent) => event.type === filter).slice(-10);
  }, [events, filter]);

  return (
    <Box flexDirection="column">
      <Text color="yellow" bold>
        ⚡ Events Stream ({filteredEvents.length})
      </Text>
      <Box marginTop={1}>
        <Text color="gray">Filter: {filter} • Recent activity:</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {filteredEvents.map((event: DebugEvent, index: number) => (
          <EventItem key={`${event.id}-${index}`} event={event} />
        ))}
      </Box>
    </Box>
  );
};

/**
 * Individual event item
 */
const EventItem: React.FC<{ event: DebugEvent }> = ({ event }: { event: DebugEvent }) => {
  const getEventStyle = (type: DebugEventType) => {
    const styles = {
      MESSAGE_ADDED: { icon: '📝', color: 'blue' },
      VARIABLE_UPDATED: { icon: '🔄', color: 'yellow' },
      TOOL_EXECUTED: { icon: '⚡', color: 'magenta' },
      TEMPLATE_EXECUTION: { icon: '🎯', color: 'cyan' },
      USER_INPUT: { icon: '👤', color: 'blue' },
      SESSION_CREATED: { icon: '🆕', color: 'green' },
      SESSION_UPDATED: { icon: '🔄', color: 'gray' },
      ERROR_OCCURRED: { icon: '❌', color: 'red' },
      PERFORMANCE_METRIC: { icon: '📊', color: 'white' },
    };
    return styles[type] || { icon: '📋', color: 'white' };
  };

  const style = getEventStyle(event.type);
  const timestamp = new Date(event.timestamp).toLocaleTimeString();

  return (
    <Box marginBottom={1}>
      <Text color={style.color}>
        {style.icon} {timestamp} - {event.type}
      </Text>
      <Box marginLeft={3}>
        <EventDetails event={event} />
      </Box>
    </Box>
  );
};

/**
 * Event details based on type
 */
const EventDetails: React.FC<{ event: DebugEvent }> = ({ event }: { event: DebugEvent }) => {
  switch (event.type) {
    case 'MESSAGE_ADDED':
      return (
        <Text color="gray">
          └─ {event.messageType}: "{event.content.substring(0, 40)}..."
        </Text>
      );

    case 'VARIABLE_UPDATED':
      return (
        <Text color="gray">
          └─ {event.variableName}: {JSON.stringify(event.oldValue)} →{' '}
          {JSON.stringify(event.newValue)}
        </Text>
      );

    case 'TOOL_EXECUTED':
      return (
        <Text color="gray">
          └─ {event.toolName}: {event.success ? '✅' : '❌'} ({event.duration}
          ms)
        </Text>
      );

    case 'USER_INPUT':
      return <Text color="gray">└─ "{event.input}"</Text>;

    default:
      return (
        <Text color="gray">└─ {JSON.stringify(event).substring(0, 60)}...</Text>
      );
  }
};

/**
 * Enhanced input area
 */
const InputArea: React.FC<{
  inputResolver: InputResolver;
  onSubmit: (inputId: string, value: string) => void;
}> = ({ inputResolver, onSubmit }: {
  inputResolver: InputResolver;
  onSubmit: (inputId: string, value: string) => void;
}) => {
  const [input, setInput] = useState(inputResolver.defaultValue || '');
  const { exit } = useApp();

  useInput((inputChar: string, key: any) => {
    if (key.return) {
      onSubmit(inputResolver.id, input);
      setInput('');
    } else if (key.backspace || key.delete) {
      setInput((prev: string) => prev.slice(0, -1));
    } else if (key.ctrl && inputChar === 'c') {
      exit();
    } else if (!key.ctrl && !key.meta && inputChar) {
      setInput((prev: string) => prev + inputChar);
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
    </Box>
  );
};

/**
 * Controls footer
 */
const ControlsFooter: React.FC<{ activePanel: string }> = ({ activePanel }: { activePanel: string }) => (
  <Box borderStyle="single" borderColor="gray" padding={1}>
    <Text color="gray">
      Tab: Switch panels • V: Variables • E: Events • M: Toggle metadata •
      Active: <Text color="cyan">{activePanel}</Text> • Ctrl+C: Exit
    </Text>
  </Box>
);

/**
 * Enhanced Ink Debug Renderer
 */
export class EnhancedInkDebugRenderer<
  TContext extends Record<string, any> = Record<string, any>,
  TMetadata extends Record<string, any> = Record<string, any>
> {
  private session: Session<TContext, TMetadata>;
  private app: any;
  private inputResolvers: Map<string, InputResolver> = new Map();
  private currentInputResolver: InputResolver | undefined;
  private isShuttingDown = false;
  private events: DebugEvent[] = [];
  private metadata: DebugSessionMetadata;
  private startTime: number;

  constructor(session: Session<TContext, TMetadata>) {
    this.session = session;
    this.startTime = Date.now();
    this.metadata = this.createInitialMetadata();

    // Get events from global debug events
    this.events = debugEvents.getEventHistory();

    // Listen for new debug events
    debugEvents.on('all', this.handleDebugEvent);
  }

  private createInitialMetadata(): DebugSessionMetadata {
    return {
      sessionId: Math.random().toString(36).substring(7),
      startTime: new Date().toISOString(),
      duration: 0,
      messageCount: this.session.messages.length,
      varsCount: this.session.varsSize,
      eventCount: 0,
      toolCallCount: 0,
      status: 'active',
      performance: {
        memoryUsage: 0,
        totalTokens: 0,
        apiCalls: 0,
        averageResponseTime: 0,
      },
    };
  }

  private handleDebugEvent = (event: DebugEvent): void => {
    this.events = debugEvents.getEventHistory();
    this.updateMetadata();

    // Re-render to show new event
    if (this.isRunning()) {
      this.rerender();
    }
  };

  private updateMetadata(): void {
    this.metadata = {
      ...this.metadata,
      duration: Date.now() - this.startTime,
      messageCount: this.session.messages.length,
      varsCount: this.session.varsSize,
      eventCount: this.events.length,
      toolCallCount: this.session.messages.reduce(
        (count, msg) => count + (msg.toolCalls?.length || 0),
        0,
      ),
    };
  }

  async start(): Promise<void> {
    this.app = render(
      <EnhancedDebugInterface
        session={this.session}
        events={this.events}
        metadata={this.metadata}
        currentInput={this.currentInputResolver}
        onUserInput={this.handleUserInput}
      />,
    );
  }

  isRunning(): boolean {
    return !!this.app && !this.isShuttingDown;
  }

  async getUserInput(
    prompt: string,
    defaultValue?: string,
    session?: Session<any, any>,
  ): Promise<string> {
    if (this.isShuttingDown) {
      throw new Error('Ink interface is shutting down');
    }

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
      this.rerender();
    });
  }

  updateConversation(session: Session<any, any>): void {
    if (this.isShuttingDown) return;

    this.session = session;
    this.rerender();
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.metadata.status = 'completed';

    // Remove debug event listener
    debugEvents.off('all', this.handleDebugEvent);

    this.inputResolvers.forEach((resolver) => {
      resolver.resolve('');
    });
    this.inputResolvers.clear();

    if (this.app?.unmount) {
      this.app.unmount();
    }
    this.app = null;
  }

  private handleUserInput = (inputId: string, value: string): void => {
    const resolver = this.inputResolvers.get(inputId);
    if (resolver) {
      resolver.resolve(value);
      this.inputResolvers.delete(inputId);
      this.currentInputResolver = undefined;
      this.rerender();
    }
  };

  private rerender(): void {
    if (this.isShuttingDown || !this.app) return;

    this.updateMetadata();
    this.app.rerender(
      <EnhancedDebugInterface
        session={this.session}
        events={this.events}
        metadata={this.metadata}
        currentInput={this.currentInputResolver}
        onUserInput={this.handleUserInput}
      />,
    );
  }
}
