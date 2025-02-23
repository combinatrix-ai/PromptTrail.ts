import type { Session } from './session';
import { createMetadata } from './metadata';
import { Message, Session } from './types';
import { DefaultInputSource, InputSource } from './input_source';

/**
 * Base class for all templates
 */
export abstract class Template {
  protected llm?: {
    generate: (prompt: string) => Promise<string>;
  };

  constructor(options?: {
    llm?: {
      generate: (prompt: string) => Promise<string>;
    };
  }) {
    this.llm = options?.llm;
  }

  abstract execute(session: Session): Promise<Session>;
}

/**
 * Template for system messages
 */
export class SystemTemplate extends Template {
  constructor(private options: { content: string }) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    return session.addMessage({
      type: 'system',
      content: this.options.content,
      metadata: createMetadata(),
    });
  }
}

/**
 * Template for user messages
 */
export class UserTemplate extends Template {
  private options: {
    description: string;
    default?: string;
    inputSource?: InputSource;
    onInput?: (input: string) => Promise<void>;
    validate?: (input: string) => Promise<boolean>;
  };

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
  ) {
    super();

    if (typeof optionsOrDescription === 'string') {
      // Simple string constructor case
      this.options = {
        description: optionsOrDescription,
        inputSource: new DefaultInputSource(),
      };
    } else {
      // Full options object case
      this.options = {
        ...optionsOrDescription,
        inputSource:
          optionsOrDescription.inputSource ?? new DefaultInputSource(),
      };
    }
  }

  async execute(session: Session): Promise<Session> {
    let input: string;
    do {
      input = await this.options.inputSource!.getInput({
        description: this.options.description,
        defaultValue: this.options.default,
        metadata: session.metadata.toJSON(),
      });
    } while (this.options.validate && !(await this.options.validate(input)));

    if (this.options.onInput) {
      await this.options.onInput(input);
    }

    return session.addMessage({
      type: 'user',
      content: input,
      metadata: createMetadata(),
    });
  }
}

/**
 * Template for assistant messages
 */
export class AssistantTemplate extends Template {
  constructor(
    private options?: {
      content?: string;
      llm?: {
        generate: (prompt: string) => Promise<string>;
      };
    },
  ) {
    super(options);
  }

  async execute(session: Session): Promise<Session> {
    if (this.options?.content) {
      // For fixed content responses, don't add control messages
      return session.addMessage({
        type: 'assistant',
        content: this.options.content,
        metadata: createMetadata(),
      });
    }

    if (!this.llm) {
      throw new Error('No LLM provided for AssistantTemplate');
    }

    const response = await this.llm.generate(
      session.getLastMessage()?.content ?? '',
    );

    return session.addMessage({
      type: 'assistant',
      content: response,
      metadata: createMetadata(),
    });
  }
}

/**
 * Template for linear sequence of templates
 */
export class LinearTemplate extends Template {
  private templates: Template[] = [];

  constructor(templates?: Template[]) {
    super();
    if (templates) {
      this.templates = templates;
    }
  }

  addSystem(content: string): this {
    this.templates.push(new SystemTemplate({ content }));
    return this;
  }

  addUser(description: string, defaultValue: string): this {
    this.templates.push(
      new UserTemplate({ description, default: defaultValue }),
    );
    return this;
  }

  addAssistant(
    options:
      | string
      | {
          llm?: {
            generate: (prompt: string) => Promise<string>;
          };
        },
  ): this {
    if (typeof options === 'string') {
      this.templates.push(new AssistantTemplate({ content: options }));
    } else {
      this.templates.push(new AssistantTemplate(options));
    }
    return this;
  }

  addLoop(loop: LoopTemplate): this {
    this.templates.push(loop);
    return this;
  }

  async execute(session: Session): Promise<Session> {
    let currentSession = session;
    for (const template of this.templates) {
      currentSession = await template.execute(currentSession);
    }
    return currentSession;
  }
}

/**
 * Template for looping sequence of templates
 */
export class LoopTemplate extends Template {
  private templates: Template[] = [];
  private exitCondition?: (session: Session) => boolean;

  constructor(options?: {
    templates: Template[];
    exitCondition: (session: Session) => boolean;
  }) {
    super();
    if (options) {
      this.templates = options.templates;
      this.exitCondition = options.exitCondition;
    }
  }

  addUser(description: string, defaultValue: string): this {
    this.templates.push(
      new UserTemplate({ description, default: defaultValue }),
    );
    return this;
  }

  addAssistant(
    options:
      | string
      | {
          llm?: {
            generate: (prompt: string) => Promise<string>;
          };
        },
  ): this {
    if (typeof options === 'string') {
      this.templates.push(new AssistantTemplate({ content: options }));
    } else {
      this.templates.push(new AssistantTemplate(options));
    }
    return this;
  }

  setExitCondition(condition: (session: Session) => boolean): this {
    this.exitCondition = condition;
    return this;
  }

  async execute(session: Session): Promise<Session> {
    if (!this.exitCondition) {
      throw new Error('Exit condition not set for LoopTemplate');
    }

    let currentSession = session;

    do {
      for (const template of this.templates) {
        currentSession = await template.execute(currentSession);
      }
    } while (!this.exitCondition(currentSession));

    return currentSession;
  }
}
