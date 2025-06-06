/**
 * Debug Event System Types
 *
 * This module defines the types for the enhanced debugging interface
 * including events, session metadata, and debug UI state.
 */

export type DebugEventType =
  | 'MESSAGE_ADDED'
  | 'VARIABLE_UPDATED'
  | 'TOOL_EXECUTED'
  | 'TEMPLATE_EXECUTION'
  | 'USER_INPUT'
  | 'SESSION_CREATED'
  | 'SESSION_UPDATED'
  | 'ERROR_OCCURRED'
  | 'PERFORMANCE_METRIC';

export interface BaseDebugEvent {
  id: string;
  type: DebugEventType;
  timestamp: string;
  sessionId?: string;
}

export interface MessageAddedEvent extends BaseDebugEvent {
  type: 'MESSAGE_ADDED';
  messageType: 'system' | 'user' | 'assistant' | 'tool_result';
  messageIndex: number;
  content: string;
  metadata?: {
    source?: string;
    tokens?: { input?: number; output?: number; total?: number };
    duration?: number;
    temperature?: number;
  };
}

export interface VariableUpdatedEvent extends BaseDebugEvent {
  type: 'VARIABLE_UPDATED';
  variableName: string;
  oldValue: any;
  newValue: any;
  changeType: 'added' | 'updated' | 'removed';
}

export interface ToolExecutedEvent extends BaseDebugEvent {
  type: 'TOOL_EXECUTED';
  toolName: string;
  input: any;
  output: any;
  duration: number;
  success: boolean;
  error?: string;
}

export interface TemplateExecutionEvent extends BaseDebugEvent {
  type: 'TEMPLATE_EXECUTION';
  templateType: string;
  templateName?: string;
  status: 'started' | 'completed' | 'failed';
  duration?: number;
  metadata?: any;
}

export interface UserInputEvent extends BaseDebugEvent {
  type: 'USER_INPUT';
  prompt: string;
  input: string;
  source: 'cli' | 'callback' | 'literal';
}

export interface SessionCreatedEvent extends BaseDebugEvent {
  type: 'SESSION_CREATED';
  initialVars: any;
  initialMessages: number;
}

export interface SessionUpdatedEvent extends BaseDebugEvent {
  type: 'SESSION_UPDATED';
  messageCount: number;
  varsCount: number;
  changesSince?: string; // timestamp
}

export interface ErrorOccurredEvent extends BaseDebugEvent {
  type: 'ERROR_OCCURRED';
  error: string;
  stack?: string;
  context?: any;
}

export interface PerformanceMetricEvent extends BaseDebugEvent {
  type: 'PERFORMANCE_METRIC';
  metric: 'memory_usage' | 'execution_time' | 'token_usage' | 'api_call';
  value: number;
  unit: string;
  context?: any;
}

export type DebugEvent =
  | MessageAddedEvent
  | VariableUpdatedEvent
  | ToolExecutedEvent
  | TemplateExecutionEvent
  | UserInputEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | ErrorOccurredEvent
  | PerformanceMetricEvent;

export interface DebugSessionMetadata {
  sessionId: string;
  startTime: string;
  duration: number; // milliseconds
  messageCount: number;
  varsCount: number;
  eventCount: number;
  toolCallCount: number;
  status: 'active' | 'paused' | 'completed' | 'error';
  performance: {
    memoryUsage?: number;
    totalTokens?: number;
    apiCalls?: number;
    averageResponseTime?: number;
  };
}

export interface VariableInfo {
  name: string;
  value: any;
  type: string;
  lastChanged?: string;
  changeCount: number;
  category: 'core' | 'counter' | 'tool_result' | 'user' | 'system';
}

export interface DebugUIState {
  activePanel: 'conversation' | 'variables' | 'events' | 'templates';
  eventFilter: DebugEventType | 'all';
  showMetadata: boolean;
  autoScroll: boolean;
  expandedVariables: Set<string>;
  selectedMessageIndex?: number;
}

export interface TemplateExecutionInfo {
  id: string;
  type: string;
  name?: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  startTime?: string;
  duration?: number;
  parent?: string;
  children?: string[];
}

export interface DebugSession {
  metadata: DebugSessionMetadata;
  events: DebugEvent[];
  variables: Map<string, VariableInfo>;
  templateStack: TemplateExecutionInfo[];
  uiState: DebugUIState;
}
