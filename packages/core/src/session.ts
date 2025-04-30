import type { Message } from './message';
import { createContext } from './taggedRecord';
import { type Context } from './taggedRecord';
import { ValidationError } from './errors';
import { Metadata } from './taggedRecord';
import { create } from 'domain';

/**
 * Internal session implementation
 */
class _SessionImpl<TContext extends Context, TMetadata extends Metadata>
  implements Session<TContext, TMetadata>
{
  constructor(
    public readonly messages: readonly Message<TMetadata>[] = [],
    public readonly context: TContext,
    public readonly print: boolean = false,
  ) {}

  /**
   * Create a new session with additional message
   */
  addMessage(message: Message<TMetadata>): Session<TContext, TMetadata> {
    if (this.print) {
      switch (message.type) {
        case 'system':
          console.log('\nSystem:', message.content);
          break;
        case 'user':
          console.log('\nUser:', message.content);
          break;
        case 'assistant':
          console.log('Assistant:', message.content);
          break;
      }
    }
    return new _SessionImpl<TContext, TMetadata>(
      [...this.messages, message],
      { ...this.context }, // Create a shallow copy of the context
      this.print,
    );
  }

  /**
   * Get a value from the context
   */
  getContextValue<K extends keyof TContext>(key: K): TContext[K] | undefined {
    return this.context[key];
  }

  /**
   * Set a value in the context
   */
  setContextValue<K extends keyof TContext>(
    key: K,
    value: TContext[K],
  ): Session<TContext, TMetadata> {
    const newContext = { ...this.context };
    newContext[key] = value;
    return new _SessionImpl<TContext, TMetadata>(
      this.messages,
      newContext,
      this.print,
    );
  }

  /**
   * Get the size of the context
   */
  get contextSize(): number {
    return Object.keys(this.context).length;
  }

  /**
   * Get a copy of the context as a plain object
   */
  getContextObject(): TContext {
    return { ...this.context };
  }

  /**
   * Get the last message in the session
   */
  getLastMessage(): Message<TContext> | undefined {
    return this.messages[this.messages.length - 1];
  }

  /**
   * Get all messages of a specific type
   */
  getMessagesByType<U extends Message<TMetadata>['type']>(
    type: U,
  ): Extract<Message<TMetadata>, { type: U }>[] {
    return this.messages.filter((msg) => msg.type === type) as Extract<
      Message<TMetadata>,
      { type: U }
    >[];
  }

  /**
   * Validate session state
   */
  validate(): void {
    // Check for empty session
    if (this.messages.length === 0) {
      throw new ValidationError('Session must have at least one message');
    }

    // Check for empty messages
    if (this.messages.some((msg) => !msg.content)) {
      throw new ValidationError('Empty messages are not allowed');
    }

    // Check system message position
    const systemMessages = this.getMessagesByType('system');
    if (systemMessages.length > 1) {
      throw new ValidationError('Only one system message is allowed');
    }
    if (systemMessages.length === 1 && this.messages[0].type !== 'system') {
      throw new ValidationError('System message must be at the beginning');
    }
  }

  /**
   * Create a JSON representation of the session
   */
  toJSON(): Record<string, unknown> {
    return {
      messages: this.messages,
      context: this.context,
      print: this.print,
    };
  }

  /**
   * Create a string representation of the session
   */
  toString(): string {
    return JSON.stringify(this.toJSON(), null, 2);
  }

  /**
   * Create a new session from a JSON representation
   */
  static fromJSON<U extends Record<string, unknown>>(
    json: Record<string, unknown>,
  ): Session<U, Metadata> {
    if (!json.messages || !Array.isArray(json.messages)) {
      throw new ValidationError(
        'Invalid session JSON: messages must be an array',
      );
    }

    if (json.context && typeof json.context !== 'object') {
      throw new ValidationError(
        'Invalid session JSON: context must be an object',
      );
    }

    return createSession<U>({
      messages: json.messages as Message<TMetadata>[],
      context: json.context as U,
      print: json.print ? (json.print as boolean) : false,
    });
  }
}

/**
 * Create a new session with type inference
 */
export function createSession<
  TContext extends Context,
  TMetadata extends Metadata,
>(
  options: {
    messages?: Message<TMetadata>[];
    context?: TContext | Record<string, unknown>;
    print?: boolean;
  } = {},
): Session<TContext, TMetadata> {
  return new _SessionImpl<TContext, TMetadata>(
    options.messages ?? [],
    options.context ?? createContext<TContext>({}),
    options.print ? (options.print as boolean) : false,
  );
}

/**
 * Session interface for maintaining conversation state
 */
export interface Session<TContext extends Context, TMetadata extends Metadata> {
  readonly messages: readonly Message<TMetadata>[];
  readonly context: TContext;
  readonly print: boolean;
  addMessage(message: Message<TMetadata>): Session<TContext, TMetadata>;
  getContextValue<K extends keyof TContext>(key: K): TContext[K] | undefined;
  setContextValue<K extends keyof TContext>(
    key: K,
    value: TContext[K],
  ): Session<TContext, TMetadata>;
  readonly contextSize: number;
  getContextObject(): TContext;
  getLastMessage(): Message<TMetadata> | undefined;
  getMessagesByType<U extends Message<TMetadata>['type']>(
    type: U,
  ): Extract<Message<TMetadata>, { type: U }>[];
  validate(): void;
  toJSON(): Record<string, unknown>;
  toString(): string;
}
