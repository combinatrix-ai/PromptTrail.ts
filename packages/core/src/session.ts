import { ValidationError } from './errors';
import type { Message } from './message';

export type Vars<T extends Record<string, unknown> = {}> = Readonly<T>;
export type Attrs<T extends Record<string, unknown> = {}> = Readonly<T>;
export class Session<
  TVars extends Vars = Record<string, any>,
  TAttrs extends Attrs = Record<string, any>,
> {
  constructor(
    public readonly messages: readonly Message<TAttrs>[] = [],
    public readonly vars: TVars,
    public readonly print: boolean = false,
  ) {}
  addMessage(message: Message<TAttrs>): Session<TVars, TAttrs> {
    const newSession = new Session<TVars, TAttrs>(
      [...this.messages, message],
      { ...this.vars },
      this.print,
    );

    if (this.print) {
      this.updateDebugOutput(newSession, message);
    }

    return newSession;
  }

  private updateDebugOutput(
    newSession: Session<TVars, TAttrs>,
    message: Message<TAttrs>,
  ): void {
    this.logMessageToConsole(message);
    this.tryUpdateInkInterface(newSession).catch(() => {});
  }

  private async tryUpdateInkInterface(
    newSession: Session<TVars, TAttrs>,
  ): Promise<void> {
    try {
      const { InkDebugContext } = await import('./cli/ink-debug-context');
      if (InkDebugContext.isActive()) {
        InkDebugContext.updateSession(newSession);
      }
    } catch (error) {}
  }

  private logMessageToConsole(message: Message<TAttrs>): void {
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

  getVar<K extends keyof TVars>(key: K): TVars[K];
  getVar<K extends keyof TVars>(key: K, defaultValue: TVars[K]): TVars[K];
  getVar(key: string): any;
  getVar(key: string, defaultValue: any): any;
  getVar<K extends keyof TVars>(
    key: K | string,
    defaultValue?: TVars[K] | any,
  ): TVars[K] | any {
    return (this.vars as any)[key] ?? defaultValue!;
  }

  withVar<K extends PropertyKey, V>(
    key: K,
    value: V,
  ): Session<Vars<TVars & { [P in K]: V }>, TAttrs> {
    return new Session(
      [...this.messages],
      { ...this.vars, [key]: value } as TVars & { [P in K]: V },
      this.print,
    );
  }

  withVars<U extends Record<string, unknown>>(
    vars: U,
  ): Session<Vars<TVars & U>, TAttrs> {
    return new Session(
      [...this.messages],
      { ...this.vars, ...vars } as TVars & U,
      this.print,
    );
  }

  withAttrsType<U extends Record<string, unknown>>(): Session<TVars, Attrs<U>> {
    return new Session<TVars, Attrs<U>>(
      [...this.messages] as Message<Attrs<U>>[],
      { ...this.vars },
      this.print,
    );
  }

  get varsSize(): number {
    return Object.keys(this.vars).length;
  }

  getVarsObject(): TVars {
    return { ...this.vars };
  }

  getLastMessage(): Message<TAttrs> | undefined {
    return this.messages[this.messages.length - 1];
  }

  getMessagesByType<U extends Message<TAttrs>['type']>(
    type: U,
  ): Extract<Message<TAttrs>, { type: U }>[] {
    return this.messages.filter((msg) => msg.type === type) as Extract<
      Message<TAttrs>,
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
      print: this.print,
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
  messages?: Message<Attrs<M>>[];
  print?: boolean;
}): Session<Vars<C>, Attrs<M>> {
  const ctx = (options?.context ?? {}) as C;
  return new Session<Vars<C>, Attrs<M>>(
    options?.messages ?? [],
    ctx,
    options?.print ?? false,
  );
}

export class SessionBuilder<
  TVars extends Record<string, unknown> = {},
  TAttrs extends Record<string, unknown> = {},
> {
  withVarsType<TNewVars extends Record<string, unknown>>(): SessionBuilder<
    TNewVars,
    TAttrs
  > {
    return new SessionBuilder<TNewVars, TAttrs>();
  }

  withAttrsType<TNewAttrs extends Record<string, unknown>>(): SessionBuilder<
    TVars,
    TNewAttrs
  > {
    return new SessionBuilder<TVars, TNewAttrs>();
  }

  create(options?: {
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

  empty(): Session<Vars<TVars>, Attrs<TAttrs>> {
    return createSession<TVars, TAttrs>({});
  }

  debug(options?: {
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

export namespace Session {
  export function create<
    TVars extends Record<string, unknown> = Record<string, any>,
    TAttrs extends Record<string, unknown> = Record<string, any>,
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

  export function fromJSON<
    TVars extends Record<string, unknown> = {},
    TAttrs extends Record<string, unknown> = {},
  >(json: Record<string, unknown>): Session<Vars<TVars>, Attrs<TAttrs>> {
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
      messages: json.messages as Message<Attrs<TAttrs>>[],
      context: json.context as TVars,
      print: json.print ? (json.print as boolean) : false,
    });
  }

  export function empty<
    TVars extends Record<string, unknown> = {},
    TAttrs extends Record<string, unknown> = {},
  >(): Session<Vars<TVars>, Attrs<TAttrs>> {
    return createSession<TVars, TAttrs>({});
  }

  export function withVars<TVars extends Record<string, unknown>>(
    vars: TVars,
    options?: {
      messages?: Message<Attrs<{}>>[];
      print?: boolean;
    },
  ): Session<Vars<TVars>, Attrs<{}>> {
    return createSession<TVars, {}>({
      context: vars,
      messages: options?.messages,
      print: options?.print,
    });
  }

  export function withMessages<TAttrs extends Record<string, unknown> = {}>(
    messages: Message<Attrs<TAttrs>>[],
    options?: {
      vars?: Record<string, unknown>;
      print?: boolean;
    },
  ): Session<Vars<{}>, Attrs<TAttrs>> {
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
   * @param options Optional configuration including UI mode
   * @returns A new session instance with print enabled
   * @example
   * ```typescript
   * const session = Session.debug({ vars: { debug: true } });
   * const inkSession = Session.debug({ ui: 'ink' });
   * ```
   */
  export function debug<
    TVars extends Record<string, unknown> = {},
    TAttrs extends Record<string, unknown> = {},
  >(options?: {
    vars?: TVars;
    messages?: Message<Attrs<TAttrs>>[];
    ui?: 'ink' | 'console' | 'auto';
  }): Session<Vars<TVars>, Attrs<TAttrs>> {
    const session = createSession<TVars, TAttrs>({
      context: options?.vars,
      messages: options?.messages,
      print: true,
    });

    // Initialize Ink interface if requested and available
    const uiMode = options?.ui ?? 'auto';
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
   * Create a session builder with specified vars type (type-only, no runtime values)
   * @returns A chainable session builder
   * @example
   * ```typescript
   * type UserContext = { userId: string; role: string };
   * const session = Session.withVarsType<UserContext>().create();
   * ```
   */
  export function withVarsType<
    TVars extends Record<string, unknown>,
  >(): SessionBuilder<TVars, {}> {
    return new SessionBuilder<TVars, {}>();
  }

  /**
   * Create a session builder with specified attrs type (type-only, no runtime values)
   * @returns A chainable session builder
   * @example
   * ```typescript
   * type MessageMeta = { role: string; hidden: boolean };
   * const session = Session.withAttrsType<MessageMeta>().create();
   * ```
   */
  export function withAttrsType<
    TAttrs extends Record<string, unknown>,
  >(): SessionBuilder<{}, TAttrs> {
    return new SessionBuilder<{}, TAttrs>();
  }
}
