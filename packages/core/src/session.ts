import type { Message } from './message';
// Removed duplicate imports
import { createContext, type Context } from './context'; // Import type alongside value
import { ValidationError } from './errors';

// Helper to check if an object looks like a Context instance
function isContext<T extends Record<string, unknown>>(
  obj: any,
): obj is Context<T> {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    typeof obj.get === 'function' &&
    typeof obj.set === 'function' &&
    typeof obj.clone === 'function' // Add other checks if needed
  );
}

/**
 * Internal session implementation
 */
class _SessionImpl<T extends Record<string, unknown> = Record<string, unknown>>
  implements Session<T>
{
  constructor(
    public readonly messages: readonly Message[] = [],
    public readonly context: Context<T>, // Removed default value here, set in createSession
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
      this.context.clone(),
      this.print,
    );
  }

  /**
   * Create a new session with updated metadata
   */
  updateContext<U extends Record<string, unknown>>(context: U): Session<T & U> {
    return new _SessionImpl<T & U>(
      this.messages,
      this.context.merge(context),
      this.print,
    );
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
    return this.messages.filter(
      (msg): msg is Extract<Message, { type: U }> => msg.type === type,
    );
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
      context: this.context.toJSON(),
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
    context?: T | Context<T>; // Allow T or Context<T>
    print?: boolean;
  } = {},
): Session<T> {
  let sessionContext: Context<T>;

  if (options.context) {
    if (isContext<T>(options.context)) {
      // If it's already a Context object, clone it
      sessionContext = options.context.clone();
    } else {
      // If it's a plain object T, create a new Context from it
      sessionContext = createContext<T>({ initial: options.context });
    }
  } else {
    // If no context is provided, create an empty one
    sessionContext = createContext<T>();
  }

  return new _SessionImpl<T>(
    options.messages ?? [], // Ensure messages is always an array
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
  getLastMessage(): Message | undefined;
  getMessagesByType<U extends Message['type']>(
    type: U,
  ): Extract<Message, { type: U }>[];
  validate(): void;
  toJSON(): Record<string, unknown>;
  toString(): string;
}
