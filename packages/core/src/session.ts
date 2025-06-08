import { debugEventHelpers, debugEvents } from './cli/debug-events';
import { ValidationError } from './errors';
import type { Message } from './message';

export type SessionContext<T extends Record<string, unknown> = {}> =
  Readonly<T>;
export type MessageMetadata<T extends Record<string, unknown> = {}> =
  Readonly<T>;
export class Session<
  TContext extends SessionContext = Record<string, any>,
  TMetadata extends MessageMetadata = Record<string, any>,
> {
  constructor(
    public readonly messages: readonly Message<TMetadata>[] = [],
    public readonly vars: TContext,
    public readonly debug: boolean = false,
    public readonly ui: 'console' | 'ink' | 'auto' = 'auto',
  ) {
    // Enable debug events if debug is enabled
    if (this.debug) {
      debugEvents.setEnabled(true);

      // Emit session created event for new sessions
      if (messages.length === 0) {
        debugEvents.emit(debugEventHelpers.sessionCreated(vars, 0));
      }
    }
  }
  addMessage(message: Message<TMetadata>): Session<TContext, TMetadata> {
    const newSession = new Session<TContext, TMetadata>(
      [...this.messages, message],
      { ...this.vars },
      this.debug,
      this.ui,
    );

    if (this.debug) {
      // Emit debug event for message added
      debugEvents.emit(
        debugEventHelpers.messageAdded(
          message.type,
          message.content,
          this.messages.length,
          {
            toolCalls: message.toolCalls?.length || 0,
            contentLength: message.content.length,
          },
        ),
      );

      this.updateDebugOutput(newSession, message);
    }

    return newSession;
  }

  private updateDebugOutput(
    newSession: Session<TContext, TMetadata>,
    message: Message<TMetadata>,
  ): void {
    // If UI mode is explicitly console, always log to console
    if (this.ui === 'console') {
      this.logMessageToConsole(message);
      return;
    }

    // If UI mode is ink or auto, try to use Ink interface
    this.tryUpdateInkInterface(newSession);
  }

  private async tryUpdateInkInterface(
    newSession: Session<TContext, TMetadata>,
  ): Promise<void> {
    try {
      const { InkDebugContext } = await import('./cli/ink-debug-context');
      InkDebugContext.updateSession(newSession);
    } catch (error) {
      // Silently ignore if Ink interface is not available
    }
  }

  private logMessageToConsole(message: Message<TMetadata>): void {
    switch (message.type) {
      case 'system':
        console.log('\nSystem:', message.content);
        break;
      case 'user':
        console.log('\nUser:', message.content);
        break;
      case 'assistant':
        if (message.content?.trim()) {
          console.log('Assistant:', message.content);
        }
        if (message.toolCalls?.length) {
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

  getVar<K extends keyof TContext>(key: K): TContext[K];
  getVar<K extends keyof TContext>(
    key: K,
    defaultValue: TContext[K],
  ): TContext[K];
  getVar(key: string): any;
  getVar(key: string, defaultValue: any): any;
  getVar<K extends keyof TContext>(
    key: K | string,
    defaultValue?: TContext[K] | any,
  ): TContext[K] | any {
    return (this.vars as any)[key] ?? defaultValue!;
  }

  withVar<K extends PropertyKey, V>(
    key: K,
    value: V,
  ): Session<SessionContext<TContext & { [P in K]: V }>, TMetadata> {
    const newSession = new Session(
      [...this.messages],
      { ...this.vars, [key]: value } as TContext & { [P in K]: V },
      this.debug,
      this.ui,
    );

    // Emit debug event for variable update
    if (this.debug) {
      const oldValue = (this.vars as any)[key];
      debugEvents.emit(
        debugEventHelpers.variableUpdated(String(key), oldValue, value),
      );
    }

    return newSession;
  }

  withContext<U extends Record<string, unknown>>(
    context: U,
  ): Session<SessionContext<TContext & U>, TMetadata> {
    const newSession = new Session(
      [...this.messages],
      { ...this.vars, ...context } as TContext & U,
      this.debug,
      this.ui,
    );

    // Emit debug events for each variable update
    if (this.debug) {
      Object.entries(context).forEach(([key, value]) => {
        const oldValue = (this.vars as any)[key];
        debugEvents.emit(
          debugEventHelpers.variableUpdated(key, oldValue, value),
        );
      });
    }

    return newSession;
  }

  withMetadataType<U extends Record<string, unknown>>(): Session<
    TContext,
    MessageMetadata<U>
  > {
    return new Session<TContext, MessageMetadata<U>>(
      [...this.messages] as Message<MessageMetadata<U>>[],
      { ...this.vars },
      this.debug,
      this.ui,
    );
  }

  get varsSize(): number {
    return Object.keys(this.vars).length;
  }

  geTContextObject(): TContext {
    return { ...this.vars };
  }

  getLastMessage(): Message<TMetadata> | undefined {
    return this.messages[this.messages.length - 1];
  }

  getMessagesByType<U extends Message<TMetadata>['type']>(
    type: U,
  ): Extract<Message<TMetadata>, { type: U }>[] {
    return this.messages.filter((msg) => msg.type === type) as Extract<
      Message<TMetadata>,
      { type: U }
    >[];
  }

  validate(): void {
    if (this.messages.length === 0) {
      throw new ValidationError('Session must have at least one message');
    }

    if (this.messages.some((msg) => !msg.content)) {
      throw new ValidationError('Empty messages are not allowed');
    }

    const systemMessages = this.getMessagesByType('system');
    if (systemMessages.length > 1) {
      throw new ValidationError('Only one system message is allowed');
    }
    if (systemMessages.length === 1 && this.messages[0].type !== 'system') {
      throw new ValidationError('System message must be at the beginning');
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      messages: this.messages,
      context: this.vars,
      debug: this.debug,
      // Keep 'print' for backwards compatibility
      print: this.debug,
    };
  }

  toString(): string {
    return JSON.stringify(this.toJSON(), null, 2);
  }
}

export function createSession<
  C extends Record<string, unknown> = Record<string, any>,
  M extends Record<string, unknown> = Record<string, any>,
>(options?: {
  context?: C;
  messages?: Message<MessageMetadata<M>>[];
  debug?: boolean;
  ui?: 'console' | 'ink' | 'auto';
  // @deprecated Use 'debug' instead
  print?: boolean;
}): Session<SessionContext<C>, MessageMetadata<M>> {
  const ctx = (options?.context ?? {}) as C;
  // Support backwards compatibility with 'print' parameter
  const debugEnabled = options?.debug ?? options?.print ?? false;
  return new Session<SessionContext<C>, MessageMetadata<M>>(
    options?.messages ?? [],
    ctx,
    debugEnabled,
    options?.ui ?? 'auto',
  );
}

export class TypedSessionBuilder<
  TContext extends SessionContext = Record<string, any>,
  TMetadata extends MessageMetadata = Record<string, any>,
> {
  create(options?: {
    context?: TContext;
    messages?: Message<TMetadata>[];
    debug?: boolean;
    ui?: 'console' | 'ink' | 'auto';
  }): Session<TContext, TMetadata> {
    return createSession<TContext, TMetadata>({
      context: options?.context,
      messages: options?.messages,
      debug: options?.debug,
      ui: options?.ui,
    });
  }

  debug(options?: {
    context?: TContext;
    messages?: Message<TMetadata>[];
    ui?: 'ink' | 'console' | 'auto';
  }): Session<TContext, TMetadata> {
    return createSession<TContext, TMetadata>({
      context: options?.context,
      messages: options?.messages,
      debug: true,
      ui: options?.ui ?? 'auto',
    });
  }

  empty(): Session<TContext, TMetadata> {
    return createSession<TContext, TMetadata>({});
  }
}

export namespace Session {
  export function create<
    TContext extends Record<string, unknown> = Record<string, any>,
    TMetadata extends Record<string, unknown> = Record<string, any>,
  >(options?: {
    context?: TContext;
    messages?: Message<MessageMetadata<TMetadata>>[];
    debug?: boolean;
    ui?: 'console' | 'ink' | 'auto';
    // @deprecated Use 'debug' instead
    print?: boolean;
  }): Session<SessionContext<TContext>, MessageMetadata<TMetadata>> {
    return createSession<TContext, TMetadata>({
      context: options?.context,
      messages: options?.messages,
      debug: options?.debug,
      ui: options?.ui,
      print: options?.print,
    });
  }

  export function fromJSON<
    TContext extends Record<string, unknown> = {},
    TMetadata extends Record<string, unknown> = {},
  >(
    json: Record<string, unknown>,
  ): Session<SessionContext<TContext>, MessageMetadata<TMetadata>> {
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
      messages: json.messages as Message<MessageMetadata<TMetadata>>[],
      context: json.context as TContext,
      print: json.print ? (json.print as boolean) : false,
    });
  }

  export function empty<
    TContext extends Record<string, unknown> = {},
    TMetadata extends Record<string, unknown> = {},
  >(): Session<SessionContext<TContext>, MessageMetadata<TMetadata>> {
    return createSession<TContext, TMetadata>({});
  }

  export function withContext<TContext extends Record<string, unknown>>(
    context: TContext,
    options?: {
      messages?: Message<MessageMetadata<{}>>[];
      debug?: boolean;
    },
  ): Session<SessionContext<TContext>, MessageMetadata<{}>> {
    return createSession<TContext, {}>({
      context: context,
      messages: options?.messages,
      debug: options?.debug,
    });
  }

  export function withMessages<TMetadata extends Record<string, unknown> = {}>(
    messages: Message<MessageMetadata<TMetadata>>[],
    options?: {
      context?: Record<string, unknown>;
      debug?: boolean;
    },
  ): Session<SessionContext<{}>, MessageMetadata<TMetadata>> {
    return createSession<{}, TMetadata>({
      context: options?.context,
      messages: messages,
      debug: options?.debug,
    });
  }

  /**
   * Create a new session with both context and messages
   * @param context Initial session context
   * @param messages Initial messages
   * @param options Optional configuration
   * @returns A new session instance
   * @example
   * ```typescript
   * const session = Session.withContextAndMessages(
   *   { userId: '123' },
   *   [{ type: 'user', content: 'Hello' }]
   * );
   * ```
   */
  export function withContextAndMessages<
    TContext extends Record<string, unknown>,
    TMetadata extends Record<string, unknown> = {},
  >(
    context: TContext,
    messages: Message<MessageMetadata<TMetadata>>[],
    options?: {
      debug?: boolean;
    },
  ): Session<SessionContext<TContext>, MessageMetadata<TMetadata>> {
    return createSession<TContext, TMetadata>({
      context: context,
      messages: messages,
      debug: options?.debug,
    });
  }

  /**
   * Create a new session with print enabled for debugging
   * @param options Optional configuration including UI mode
   * @returns A new session instance with print enabled
   * @example
   * ```typescript
   * const session = Session.debug({ context: { debug: true } });
   * const inkSession = Session.debug({ ui: 'ink' });
   * ```
   */
  export function debug<
    TContext extends Record<string, unknown> = {},
    TMetadata extends Record<string, unknown> = {},
  >(options?: {
    context?: TContext;
    messages?: Message<MessageMetadata<TMetadata>>[];
    ui?: 'ink' | 'console' | 'auto';
  }): Session<SessionContext<TContext>, MessageMetadata<TMetadata>> {
    const uiMode = options?.ui ?? 'auto';

    const session = createSession<TContext, TMetadata>({
      context: options?.context,
      messages: options?.messages,
      debug: true,
      ui: uiMode,
    });

    // Initialize Ink interface if requested and available
    if (uiMode === 'ink' || uiMode === 'auto') {
      // Start initialization but don't await it (to keep debug() synchronous)
      // The initialization will set proper flags so other code can wait for it
      initializeInkInterface(session, uiMode === 'ink').catch((error) => {
        // Silently ignore initialization errors
        if (uiMode === 'ink') {
          console.warn(
            'Ink interface initialization failed, falling back to console mode',
          );
        }
      });
    }

    return session;
  }

  /**
   * Initialize Ink debug interface if available
   */
  async function initializeInkInterface(
    session: Session<any, any>,
    forceInk: boolean = false,
  ): Promise<void> {
    try {
      const { InkDebugContext } = await import('./cli/ink-debug-context');

      // Check if terminal supports Ink or if forced
      if (forceInk || InkDebugContext.isTerminalCapable()) {
        await InkDebugContext.initialize(session);
      }
    } catch (error) {
      if (forceInk) {
        console.warn(
          'Ink interface requested but not available, falling back to console mode',
        );
      }
      // Silently fall back to console mode if Ink not available
    }
  }

  /**
   * Create a type-first session builder for clean type specification
   * @returns A chainable typed session builder
   * @example
   * ```typescript
   * type UserContext = { userId: string; role: string };
   * type MessageMeta = { timestamp: Date; source: string };
   * const session = Session.typed<UserContext, MessageMeta>()
   *   .create({ context: { userId: '123', role: 'admin' } });
   * ```
   */
  export function typed<
    TContext extends SessionContext = Record<string, any>,
    TMetadata extends MessageMetadata = Record<string, any>,
  >(): TypedSessionBuilder<TContext, TMetadata> {
    return new TypedSessionBuilder<TContext, TMetadata>();
  }
}
