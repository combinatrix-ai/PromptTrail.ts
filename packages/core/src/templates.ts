import { createMetadata } from './metadata';
import type { InputSource } from './input_source';
import { DefaultInputSource, CallbackInputSource } from './input_source';
import type { Model } from './model/base';
import type { Session } from './session';
import { interpolateTemplate } from './utils/template_interpolation';
import type { SessionTransformer } from './utils/session_transformer';
import { createTransformerTemplate } from './templates/transformer_template';

/**
 * Base class for all templates
 */
export abstract class Template<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> {
  protected model?: Model;

  constructor(options?: { model?: Model }) {
    this.model = options?.model;
  }

  /**
   * Helper method to interpolate content with session metadata
   */
  protected interpolateContent(
    content: string,
    session: Session<TInput>,
  ): string {
    return interpolateTemplate(content, session.metadata);
  }

  abstract execute(session: Session<TInput>): Promise<Session<TOutput>>;
}

/**
 * Template for system messages
 */
export class SystemTemplate extends Template {
  constructor(private options: { content: string }) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    const interpolatedContent = this.interpolateContent(
      this.options.content,
      session,
    );
    return session.addMessage({
      type: 'system',
      content: interpolatedContent,
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
      const interpolatedDescription = this.interpolateContent(
        this.options.description,
        session,
      );
      const interpolatedDefault = this.options.default
        ? this.interpolateContent(this.options.default, session)
        : undefined;

      input = await this.options.inputSource!.getInput({
        description: interpolatedDescription,
        defaultValue: interpolatedDefault,
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
      model?: Model;
    },
  ) {
    super(options);
  }

  async execute(session: Session): Promise<Session> {
    if (this.options?.content) {
      // For fixed content responses, don't add control messages
      const interpolatedContent = this.interpolateContent(
        this.options.content,
        session,
      );
      return session.addMessage({
        type: 'assistant',
        content: interpolatedContent,
        metadata: createMetadata(),
      });
    }

    if (!this.model) {
      throw new Error('No Model provided for AssistantTemplate');
    }

    const response = await this.model.send(session);
    return session.addMessage(response);
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
      new UserTemplate({
        description,
        default: defaultValue,
        inputSource: new CallbackInputSource(
          async ({ defaultValue }) => defaultValue || '',
        ),
      }),
    );
    return this;
  }

  addAssistant(
    options:
      | string
      | {
          model?: Model;
          content?: string;
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

  /**
   * Add a conditional template to the sequence
   *
   * @param options The if template options
   * @returns The template instance for chaining
   */
  addIf(options: {
    condition: (session: Session) => boolean;
    thenTemplate: Template;
    elseTemplate?: Template;
  }): this {
    this.templates.push(new IfTemplate(options));
    return this;
  }

  /**
   * Add a transformer to the template sequence
   *
   * Transformers can extract structured data from messages and store it in the session metadata.
   *
   * @example
   * ```typescript
   * // Extract markdown sections and code blocks
   * template.addTransformer(extractMarkdown({
   *   headingMap: { 'Summary': 'summary' },
   *   codeBlockMap: { 'typescript': 'code' }
   * }));
   *
   * // Extract data using regex patterns
   * template.addTransformer(extractPattern({
   *   pattern: /API Endpoint: (.+)/,
   *   key: 'apiEndpoint'
   * }));
   * ```
   *
   * @param transformer The transformer to add
   * @returns The template instance for chaining
   */
  addTransformer(transformer: SessionTransformer<any, any>): this {
    this.templates.push(createTransformerTemplate(transformer) as Template);
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
      new UserTemplate({
        description,
        default: defaultValue,
        inputSource: new CallbackInputSource(
          async ({ defaultValue }) => defaultValue || '',
        ),
      }),
    );
    return this;
  }

  addAssistant(
    options:
      | string
      | {
          model?: Model;
          content?: string;
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

/**
 * Template for nested conversations with separate session context
 */
export class SubroutineTemplate extends Template {
  constructor(
    private options: {
      template: Template;
      initWith: (parentSession: Session) => Session;
      squashWith?: (parentSession: Session, childSession: Session) => Session;
    },
  ) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    // Create child session using initWith function
    const childSession = this.options.initWith(session);

    // Execute the template with child session
    const resultSession = await this.options.template.execute(childSession);

    // If squashWith is provided, merge results back to parent session
    if (this.options.squashWith) {
      return this.options.squashWith(session, resultSession);
    }

    // Otherwise just return parent session unchanged
    return session;
  }
}

/**
 * Template for conditional execution based on a condition
 */
export class IfTemplate extends Template {
  constructor(
    private options: {
      condition: (session: Session) => boolean;
      thenTemplate: Template;
      elseTemplate?: Template;
    },
  ) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    if (this.options.condition(session)) {
      return this.options.thenTemplate.execute(session);
    } else if (this.options.elseTemplate) {
      return this.options.elseTemplate.execute(session);
    }
    return session; // If no else template and condition is false, return session unchanged
  }
}
