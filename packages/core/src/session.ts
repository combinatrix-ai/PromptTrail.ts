import type { Message } from './message';
import { createContext, type Context } from './context';
import { ValidationError } from './errors';

/**
 * Internal session implementation
 */
class _SessionImpl<T extends Record<string, unknown> = Record<string, unknown>>
  implements Session<T>
{
  constructor(
    public readonly messages: readonly Message[] = [],
    public readonly context: Context<T>,
    public readonly print: boolean = false,
  ) {}

  /**
   * Create a new session with additional message
   */
  addMessage(message: Message): Session<T> {
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
    return new _SessionImpl<T>(
      [...this.messages, message],
      { ...this.context }, // Create a shallow copy of the context
      this.print,
    );
  }

  /**
   * Create a new session with updated metadata
   */
  updateContext<U extends Record<string, unknown>>(context: U): Session<T & U> {
    return new _SessionImpl<T & U>(
      this.messages,
      { ...this.context, ...context },
      this.print,
    );
  }

  /**
   * Get a value from the context
   */
  getContextValue<K extends keyof T>(key: K): T[K] | undefined {
    return this.context[key];
  }

  /**
   * Set a value in the context
   */
  setContextValue<K extends keyof T>(key: K, value: T[K]): Session<T> {
    const newContext = { ...this.context };
    newContext[key] = value;
    return new _SessionImpl<T>(this.messages, newContext, this.print);
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
  getContextObject(): T {
    return { ...this.context };
  }

  /**
   * Get the last message in the session
   */
  getLastMessage(): Message | undefined {
    return this.messages[this.messages.length - 1];
  }

  /**
   * Get all messages of a specific type
   */
  getMessagesByType<U extends Message['type']>(
    type: U,
  ): Extract<Message, { type: U }>[] {
    return this.messages.filter((msg) => msg.type === type) as Extract<
      Message,
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
  ): Session<U> {
    if (!json.messages || !Array.isArray(json.messages)) {
      throw new ValidationError(
        'Invalid session JSON: messages must be an array',
      );
    }

    return createSession<U>({
      messages: json.messages as Message[],
      context: json.context as U,
      print: json.print as boolean,
    });
  }
}

/**
 * Create a new session with type inference
 */
export function createSession<T extends Record<string, unknown>>(
  options: {
    messages?: Message[];
    context?: T;
    print?: boolean;
  } = {},
): Session<T> {
  const sessionContext: Context<T> = options.context
    ? { ...options.context }
    : ({} as Context<T>);

  return new _SessionImpl<T>(
    options.messages ?? [],
    sessionContext,
    options.print ?? false,
  );
}

/**
 * Session interface for maintaining conversation state
 */
export interface Session<
  T extends { [key: string]: unknown } = Record<string, unknown>,
> {
  readonly messages: readonly Message[];
  readonly context: Context<T>;
  readonly print: boolean;
  addMessage(message: Message): Session<T>;
  updateContext<U extends Record<string, unknown>>(context: U): Session<T & U>;
  getContextValue<K extends keyof T>(key: K): T[K] | undefined;
  setContextValue<K extends keyof T>(key: K, value: T[K]): Session<T>;
  readonly contextSize: number;
  getContextObject(): T;
  getLastMessage(): Message | undefined;
  getMessagesByType<U extends Message['type']>(
    type: U,
  ): Extract<Message, { type: U }>[];
  validate(): void;
  toJSON(): Record<string, unknown>;
  toString(): string;
}
