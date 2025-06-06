/**
 * Debug Event Emitter
 *
 * Simple event emitter for debug events that can be used by Session
 * and other components to emit debug information.
 */

import type { DebugEvent, DebugEventType } from './debug-types';

export interface DebugEventListener {
  (event: DebugEvent): void;
}

/**
 * Global debug event emitter for PromptTrail sessions
 */
class DebugEventEmitter {
  private static instance: DebugEventEmitter | null = null;
  private listeners: Map<DebugEventType | 'all', Set<DebugEventListener>> =
    new Map();
  private eventHistory: DebugEvent[] = [];
  private isEnabled = false;

  private constructor() {}

  static getInstance(): DebugEventEmitter {
    if (!this.instance) {
      this.instance = new DebugEventEmitter();
    }
    return this.instance;
  }

  /**
   * Enable or disable debug event collection
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    if (!enabled) {
      this.eventHistory = [];
    }
  }

  /**
   * Check if debug events are enabled
   */
  isDebugEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Emit a debug event
   */
  emit(event: DebugEvent): void {
    if (!this.isEnabled) return;

    // Store in history
    this.eventHistory.push(event);

    // Keep only last 1000 events to prevent memory issues
    if (this.eventHistory.length > 1000) {
      this.eventHistory = this.eventHistory.slice(-1000);
    }

    // Notify specific listeners
    const specificListeners = this.listeners.get(event.type);
    if (specificListeners) {
      specificListeners.forEach((listener) => {
        try {
          listener(event);
        } catch (error) {
          console.warn('Debug event listener error:', error);
        }
      });
    }

    // Notify 'all' listeners
    const allListeners = this.listeners.get('all');
    if (allListeners) {
      allListeners.forEach((listener) => {
        try {
          listener(event);
        } catch (error) {
          console.warn('Debug event listener error:', error);
        }
      });
    }
  }

  /**
   * Add a listener for specific event types
   */
  on(eventType: DebugEventType | 'all', listener: DebugEventListener): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);
  }

  /**
   * Remove a listener
   */
  off(eventType: DebugEventType | 'all', listener: DebugEventListener): void {
    const listeners = this.listeners.get(eventType);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(eventType);
      }
    }
  }

  /**
   * Get all events in history
   */
  getEventHistory(): DebugEvent[] {
    return [...this.eventHistory];
  }

  /**
   * Get events filtered by type
   */
  getEventsByType(eventType: DebugEventType): DebugEvent[] {
    return this.eventHistory.filter((event) => event.type === eventType);
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.eventHistory = [];
  }

  /**
   * Get recent events (last N events)
   */
  getRecentEvents(count = 50): DebugEvent[] {
    return this.eventHistory.slice(-count);
  }

  /**
   * Reset the emitter (useful for testing)
   */
  reset(): void {
    this.listeners.clear();
    this.eventHistory = [];
    this.isEnabled = false;
  }
}

/**
 * Global debug event emitter instance
 */
export const debugEvents = DebugEventEmitter.getInstance();

/**
 * Utility function to create a debug event with common fields
 */
export function createDebugEvent(
  type: DebugEventType,
  data: Record<string, any>,
): DebugEvent {
  return {
    id: `event-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    type,
    timestamp: new Date().toISOString(),
    ...data,
  } as DebugEvent;
}

/**
 * Helper functions for common debug events
 */
export const debugEventHelpers = {
  messageAdded: (
    messageType: string,
    content: string,
    messageIndex: number,
    metadata?: any,
  ) => {
    return createDebugEvent('MESSAGE_ADDED', {
      messageType: messageType as any,
      content,
      messageIndex,
      metadata,
    });
  },

  variableUpdated: (variableName: string, oldValue: any, newValue: any) => {
    return createDebugEvent('VARIABLE_UPDATED', {
      variableName,
      oldValue,
      newValue,
      changeType:
        oldValue === undefined ? ('added' as const) : ('updated' as const),
    });
  },

  toolExecuted: (
    toolName: string,
    input: any,
    output: any,
    duration: number,
    success = true,
    error?: string,
  ) => {
    return createDebugEvent('TOOL_EXECUTED', {
      toolName,
      input,
      output,
      duration,
      success,
      error,
    });
  },

  userInput: (
    prompt: string,
    input: string,
    source: 'cli' | 'callback' | 'literal' = 'cli',
  ) => {
    return createDebugEvent('USER_INPUT', {
      prompt,
      input,
      source,
    });
  },

  sessionCreated: (initialVars: any, initialMessages = 0) => {
    return createDebugEvent('SESSION_CREATED', {
      initialVars,
      initialMessages,
    });
  },

  errorOccurred: (error: string, stack?: string, context?: any) => {
    return createDebugEvent('ERROR_OCCURRED', {
      error,
      stack,
      context,
    });
  },
};
