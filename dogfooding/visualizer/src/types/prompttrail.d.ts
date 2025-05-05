declare module '@prompttrail/core' {
  export class Template {
    execute(session: Session): Promise<Session>;
  }

  export class SystemTemplate extends Template {
    constructor(options: { content: string });
  }

  export class UserTemplate extends Template {
    constructor(
      optionsOrDescription:
        | string
        | {
            description: string;
            default?: string;
            inputSource?: InputSource;
            onInput?: (input: string) => Promise<void>;
            validate?: (input: string) => Promise<boolean>;
          },
      defaultValue?: string,
    );

    // Add method for chaining
    addUser(
      optionsOrDescription:
        | string
        | {
            description: string;
            default?: string;
            inputSource?: InputSource;
            onInput?: (input: string) => Promise<void>;
            validate?: (input: string) => Promise<boolean>;
          },
      defaultValue?: string,
    ): this;
  }

  export class AssistantTemplate extends Template {
    constructor(options?: { content?: string; model?: Model | string });
  }

  export class LinearTemplate extends Template {
    constructor(templates?: Template[]);
    addSystem(content: string): this;
    addUser(
      optionsOrDescription:
        | string
        | {
            description: string;
            default?: string;
            inputSource?: InputSource;
            onInput?: (input: string) => Promise<void>;
            validate?: (input: string) => Promise<boolean>;
          },
      defaultValue?: string,
    ): this;
    addAssistant(
      options:
        | string
        | {
            model?: Model | string;
            content?: string;
          },
    ): this;
    addLoop(loop: LoopTemplate): this;
  }

  export class LoopTemplate extends Template {
    constructor(options?: {
      templates: Template[];
      loopIf: (session: Session) => boolean;
    });
    addUser(
      optionsOrDescription:
        | string
        | {
            description: string;
            default?: string;
            inputSource?: InputSource;
            onInput?: (input: string) => Promise<void>;
            validate?: (input: string) => Promise<boolean>;
          },
      defaultValue?: string,
    ): this;
    addAssistant(
      options:
        | string
        | {
            model?: Model | string;
            content?: string;
          },
    ): this;
    setLoopCondition(condition: (session: Session) => boolean): this;
  }

  export class SubroutineTemplate extends Template {
    constructor(options: {
      template: Template;
      initWith: (parentSession: Session) => Session;
      squashWith?: (parentSession: Session, childSession: Session) => Session;
    });
  }

  export interface Session {
    messages: readonly Message[];
    metadata: Metadata;
    addMessage(message: Message): Session;
    getMessagesByType<T extends Message['type']>(type: T): Message[];
  }

  export interface Message {
    type: 'system' | 'user' | 'assistant' | 'tool_result';
    content: string;
    metadata?: Metadata;
  }

  export interface Metadata {
    get(key: string): unknown;
    toJSON(): Record<string, unknown>;
  }

  export interface Model {
    send(session: Session): Promise<Message>;
  }

  export class OpenAIModel implements Model {
    constructor(config: {
      apiKey: string;
      modelName: string;
      temperature?: number;
      maxTokens?: number;
      dangerouslyAllowBrowser?: boolean;
    });
    send(session: Session): Promise<Message>;
  }

  export class AnthropicModel implements Model {
    constructor(config: {
      apiKey: string;
      modelName: string;
      temperature?: number;
      maxTokens?: number;
      dangerouslyAllowBrowser?: boolean;
    });
    send(session: Session): Promise<Message>;
  }

  export interface InputSource {
    getInput(options: {
      description: string;
      defaultValue?: string;
      metadata: Record<string, unknown>;
    }): Promise<string>;
  }

  export class DefaultInputSource implements InputSource {
    getInput(options: {
      description: string;
      defaultValue?: string;
      metadata: Record<string, unknown>;
    }): Promise<string>;
  }

  export class CallbackInputSource implements InputSource {
    constructor(
      callback: (options: {
        description: string;
        defaultValue?: string;
        metadata: Record<string, unknown>;
      }) => Promise<string>,
    );
    getInput(options: {
      description: string;
      defaultValue?: string;
      metadata: Record<string, unknown>;
    }): Promise<string>;
  }

  export class CLIInputSource implements InputSource {
    getInput(options: {
      description: string;
      defaultValue?: string;
      metadata: Record<string, unknown>;
    }): Promise<string>;
    close(): void;
  }

  export function createSession<
    T extends Record<string, unknown> = Record<string, unknown>,
  >(options?: { messages?: Message[]; metadata?: T; print?: boolean }): Session;

  export function createMetadata<
    T extends Record<string, unknown> = Record<string, unknown>,
  >(options?: { initial?: T }): Metadata;

  export function createTemperature(value: number): number;
}
