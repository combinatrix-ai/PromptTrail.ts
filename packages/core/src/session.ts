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
          console.log('Assistant:', message.content);
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

  /**
   * Create a new session from a JSON representation
   */
  static fromJSON<TVars extends Vars, TAttrs extends Attrs>(
    json: Record<string, unknown>,
  ): Session<TVars, TAttrs> {
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
