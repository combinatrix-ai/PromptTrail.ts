import type { Message } from './message';
import type { Context } from './context';
import { createContext } from './context';
import type { ISession } from './types';
import { ValidationError } from './types';

/**
 * Immutable session implementation
 */
/**
 * Internal session implementation
 */
class _SessionImpl<T extends Record<string, unknown> = Record<string, unknown>>
  implements ISession<T>
{
  constructor(
    public readonly messages: readonly Message[] = [],
    public readonly context: Context<T> = createContext<T>(),
    public readonly print: boolean = false,
  ) {}

  /**
   * Create a new session with additional message
   */
  addMessage(message: Message): ISession<T> {
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
  updateContext<U extends Record<string, unknown>>(
    context: U,
  ): ISession<T & U> {
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
  ): ISession<U> {
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
): ISession<T> {
  return new _SessionImpl<T>(
    options.messages,
    options.context
      ? createContext<T>({ initial: options.context })
      : undefined,
    options.print ?? false,
  );
}
