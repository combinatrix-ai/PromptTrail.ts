import { ValidationError } from './errors';
import type { Message } from './message';
import { Attrs, Vars } from './tagged_record';
/**
 * Internal session implementation
 */
export class Session<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs> {
  constructor(
    public readonly messages: readonly Message<TAttrs>[] = [],
    public readonly vars: TVars,
    public readonly print: boolean = false,
  ) {}
  /**
   * Create a new session with additional message
   */
  addMessage(message: Message<TAttrs>): Session<TVars, TAttrs> {
    if (this.print) {
      switch (message.type) {
        case 'system':
          console.log('\nSystem:', message.content);
          break;
        case 'user':
          console.log('\nUser:', message.content);
          break;
        case 'assistant':
          // Only print content if it's not just whitespace
          if (message.content && message.content.trim()) {
            console.log('Assistant:', message.content);
          }
          // Print tool calls if present
          if (message.toolCalls && message.toolCalls.length > 0) {
            console.log('\nAssistant:');
            message.toolCalls.forEach((tc) => {
              console.log(`[${tc.name}(${JSON.stringify(tc.arguments)})]`);
            });
          }
          break;
        case 'tool_result':
          console.log('Tool Result:', message.content);
          break;
      }
    }
    return new Session<TVars, TAttrs>(
      [...this.messages, message],
      { ...this.vars }, // Create a shallow copy of the context
      this.print,
    );
  }

  /**
   * Get a value from the context
   */
  getVar<K extends keyof TVars>(key: K): TVars[K];
  getVar<K extends keyof TVars>(key: K, defaultValue: TVars[K]): TVars[K];
  getVar<K extends keyof TVars>(key: K, defaultValue?: TVars[K]): TVars[K] {
    return this.vars[key] !== undefined ? this.vars[key] : defaultValue!;
  }

  /**
   * Set a value in the context
   */
  withVar<K extends PropertyKey, V>(
    key: K,
    value: V,
  ): Session<TVars & { [P in K]: V }, TAttrs> {
    const newContext = {
      ...this.vars,
      [key]: value,
    } as TVars & { [P in K]: V };

    return new Session([...this.messages], newContext, this.print);
  }

  withVars<U extends Record<string, unknown>>(
    vars: U,
  ): Session<TVars & U, TAttrs> {
    const newContext = { ...this.vars, ...vars } as TVars & U;
    return new Session([...this.messages], newContext, this.print);
  }

  /**
   * Get the size of the context
   */
  get varsSize(): number {
    return Object.keys(this.vars).length;
  }

  /**
   * Get a copy of the context as a plain object
   */
  getVarsObject(): TVars {
    return { ...this.vars };
  }

  /**
   * Get the last message in the session
   */
  getLastMessage(): Message<TAttrs> | undefined {
    return this.messages[this.messages.length - 1];
  }

  /**
   * Get all messages of a specific type
   */
  getMessagesByType<U extends Message<TAttrs>['type']>(
    type: U,
  ): Extract<Message<TAttrs>, { type: U }>[] {
    return this.messages.filter((msg) => msg.type === type) as Extract<
      Message<TAttrs>,
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
      context: this.vars,
      print: this.print,
    };
  }

  /**
   * Create a string representation of the session
   */
  toString(): string {
    return JSON.stringify(this.toJSON(), null, 2);
  }

}

/**
 * Create a new session with type inference
 */
export function createSession<
  C extends Record<string, unknown> | Vars<Record<string, unknown>> = Vars,
  M extends Record<string, unknown> | Attrs<Record<string, unknown>> = Attrs,
>(options?: {
  context?: C;
  messages?: Message<Attrs<M>>[];
  print?: boolean;
}): Session<Vars<C>, Attrs<M>> {
  options = options ?? {};
  const raw = options.context as any;
  const ctx: Vars<C> = Vars.is(raw) ? raw : Vars.create(raw ?? {});
  return new Session<Vars<C>, Attrs<M>>(
    options.messages ?? [],
    ctx,
    options.print ?? false,
  );
}

/**
 * Session namespace providing factory methods for creating sessions
 * Provides a consistent API with other PromptTrail components
 */
export namespace Session {
  /**
   * Create a new empty session
   * @param options Optional configuration
   * @returns A new session instance
   * @example
   * ```typescript
   * const session = Session.create();
   * const sessionWithVars = Session.create({ vars: { name: 'test' } });
   * ```
   */
  export function create<
    TVars extends Record<string, unknown> = {},
    TAttrs extends Record<string, unknown> = {},
  >(options?: {
    vars?: TVars;
    messages?: Message<Attrs<TAttrs>>[];
    print?: boolean;
  }): Session<Vars<TVars>, Attrs<TAttrs>> {
    return createSession<TVars, TAttrs>({
      context: options?.vars,
      messages: options?.messages,
      print: options?.print,
    });
  }

  /**
   * Create a new session from a JSON representation
   * @param json JSON object containing session data
   * @returns A new session instance
   * @example
   * ```typescript
   * const session = Session.fromJSON({
   *   messages: [{ type: 'user', content: 'Hello' }],
   *   context: { name: 'test' },
   *   print: false
   * });
   * ```
   */
  export function fromJSON<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(json: Record<string, unknown>): Session<TVars, TAttrs> {
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

    return createSession<TVars, TAttrs>({
      messages: json.messages as Message<TAttrs>[],
      context: json.context as TVars,
      print: json.print ? (json.print as boolean) : false,
    });
  }

  /**
   * Create a new empty session
   * @returns A new session instance with no messages or vars
   * @example
   * ```typescript
   * const session = Session.empty();
   * ```
   */
  export function empty<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(): Session<TVars, TAttrs> {
    return createSession<TVars, TAttrs>({});
  }

  /**
   * Create a new session with initial vars
   * @param vars Initial session vars
   * @param options Optional configuration
   * @returns A new session instance
   * @example
   * ```typescript
   * const session = Session.withVars({ userId: '123', name: 'John' });
   * ```
   */
  export function withVars<TVars extends Record<string, unknown>>(
    vars: TVars,
    options?: {
      messages?: Message<Attrs>[];
      print?: boolean;
    },
  ): Session<Vars<TVars>, Attrs> {
    return createSession<TVars, {}>({
      context: vars,
      messages: options?.messages,
      print: options?.print,
    });
  }

  /**
   * Create a new session with initial messages
   * @param messages Initial messages
   * @param options Optional configuration
   * @returns A new session instance
   * @example
   * ```typescript
   * const session = Session.withMessages([
   *   { type: 'system', content: 'You are a helpful assistant' }
   * ]);
   * ```
   */
  export function withMessages<TAttrs extends Record<string, unknown> = {}>(
    messages: Message<Attrs<TAttrs>>[],
    options?: {
      vars?: Record<string, unknown>;
      print?: boolean;
    },
  ): Session<Vars, Attrs<TAttrs>> {
    return createSession<{}, TAttrs>({
      context: options?.vars,
      messages: messages,
      print: options?.print,
    });
  }

  /**
   * Create a new session with both vars and messages
   * @param vars Initial session vars
   * @param messages Initial messages
   * @param options Optional configuration
   * @returns A new session instance
   * @example
   * ```typescript
   * const session = Session.withVarsAndMessages(
   *   { userId: '123' },
   *   [{ type: 'user', content: 'Hello' }]
   * );
   * ```
   */
  export function withVarsAndMessages<
    TVars extends Record<string, unknown>,
    TAttrs extends Record<string, unknown> = {},
  >(
    vars: TVars,
    messages: Message<Attrs<TAttrs>>[],
    options?: {
      print?: boolean;
    },
  ): Session<Vars<TVars>, Attrs<TAttrs>> {
    return createSession<TVars, TAttrs>({
      context: vars,
      messages: messages,
      print: options?.print,
    });
  }

  /**
   * Create a new session with print enabled for debugging
   * @param options Optional configuration
   * @returns A new session instance with print enabled
   * @example
   * ```typescript
   * const session = Session.debug({ vars: { debug: true } });
   * ```
   */
  export function debug<
    TVars extends Record<string, unknown> = {},
    TAttrs extends Record<string, unknown> = {},
  >(options?: {
    vars?: TVars;
    messages?: Message<Attrs<TAttrs>>[];
  }): Session<Vars<TVars>, Attrs<TAttrs>> {
    return createSession<TVars, TAttrs>({
      context: options?.vars,
      messages: options?.messages,
      print: true,
    });
  }
}
