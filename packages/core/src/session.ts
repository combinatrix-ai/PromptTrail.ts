import type { Message } from './message';
import { createContext } from './tagged_record';
import { type Context } from './tagged_record';
import { ValidationError } from './errors';
import { Metadata } from './tagged_record';
/**
 * Internal session implementation
 */
export class Session<
  TContext extends Context = Context,
  TMetadata extends Metadata = Metadata,
> {
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
    return new Session<TContext, TMetadata>(
      [...this.messages, message],
      { ...this.context }, // Create a shallow copy of the context
      this.print,
    );
  }

  /**
   * Get a value from the context
   */
  getContextValue<K extends keyof TContext>(key: K): TContext[K] | undefined;
  getContextValue<K extends keyof TContext>(
    key: K,
    defaultValue: TContext[K],
  ): TContext[K];
  getContextValue<K extends keyof TContext>(
    key: K,
    defaultValue?: TContext[K],
  ): TContext[K] | undefined {
    return this.context[key] !== undefined ? this.context[key] : defaultValue;
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
    return new Session<TContext, TMetadata>(
      this.messages,
      newContext,
      this.print,
    );
  }

  setContextValues(context: Partial<TContext>): Session<TContext, TMetadata> {
    const newContext = { ...this.context, ...context };
    return new Session<TContext, TMetadata>(
      this.messages,
      newContext,
      this.print,
    );
  }

  /**
   * Get the size of the context
   */
  get contextSize(): number {
    return Object.keys(this.context).length - 1; // Exclude _type
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
  getLastMessage(): Message<TMetadata> | undefined {
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
  static fromJSON<TContext extends Context, TMetadata extends Metadata>(
    json: Record<string, unknown>,
  ): Session<TContext, TMetadata> {
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

    return createSession<TContext, TMetadata>({
      messages: json.messages as Message<TMetadata>[],
      context: json.context as TContext,
      print: json.print ? (json.print as boolean) : false,
    });
  }
}

/**
 * Create a new session with type inference
 */

export function createSession<
  C extends Record<string, unknown> = Record<string, unknown>,
  M extends Record<string, unknown> = Record<string, unknown>,
>(options?: {
  context?: C;
  messages?: Message<Metadata<M>>[];
  print?: boolean;
}): Session<Context<C>, Metadata<M>>;
export function createSession<
  TContext extends Context = Context,
  M extends Record<string, unknown> = Record<string, unknown>,
>(options?: {
  context?: TContext;
  messages?: Message<Metadata<M>>[];
  print?: boolean;
}): Session<TContext, Metadata<M>>;

export function createSession<
  C extends
    | Record<string, unknown>
    | Context<Record<string, unknown>> = Context,
  M extends Metadata = Metadata,
>(options?: {
  context?: C;
  messages?: Message<M>[];
  print?: boolean;
}): Session<Context<C>, M> {
  options = options ?? {};
  const raw = options.context as any;
  const ctx: Context<C> =
    raw && (raw as any)._type === 'context'
      ? (raw as Context<C>)
      : createContext<C>(raw as C | undefined);

  return new Session<Context<C>, M>(
    options.messages ?? [],
    ctx,
    options.print ?? false,
  );
}
