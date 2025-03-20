import { createMetadata } from './metadata';
import type { InputSource } from './input_source';
import { DefaultInputSource, CallbackInputSource } from './input_source';
import type { Session } from './session';
import { interpolateTemplate } from './utils/template_interpolation';
import type { SessionTransformer } from './utils/session_transformer';
import { createTransformerTemplate } from './templates/transformer_template';
import type { SchemaType } from './tool';
import { z } from 'zod';
import { generateText, type GenerateOptions } from './generate';

/**
 * Base class for all templates
 */
export abstract class Template<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> {
  protected generateOptions?: GenerateOptions;

  constructor(options?: { generateOptions?: GenerateOptions }) {
    this.generateOptions = options?.generateOptions;
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
      generateOptions?: GenerateOptions;
    },
  ) {
    super({ generateOptions: options?.generateOptions });
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

    if (!this.generateOptions) {
      throw new Error('No generateOptions provided for AssistantTemplate');
    }

    const response = await generateText(session as any, this.generateOptions);
    return session.addMessage(response);
  }
}

/**
 * Template for linear sequence of templates
 */
export class LinearTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> extends Template<TInput, TOutput> {
  private templates: Template<Record<string, unknown>, Record<string, unknown>>[] = [];

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

  addUser(content: string, defaultValue?: string): this {
    this.templates.push(
      new UserTemplate({
        description: content,
        default: defaultValue,
        inputSource: new CallbackInputSource(
          async ({ description }) => description,
        ),
      }),
    );
    return this;
  }

  addAssistant(
    options:
      | string
      | {
          generateOptions?: GenerateOptions;
          content?: string;
        },
  ): this {
    if (typeof options === 'string') {
      this.templates.push(new AssistantTemplate({ content: options }));
    } else {
      // Set the generateOptions on the LinearTemplate if provided
      if (options.generateOptions) {
        this.generateOptions = options.generateOptions;
      }

      // Create AssistantTemplate with the generateOptions from options or from LinearTemplate
      const assistantOptions = {
        ...options,
        generateOptions: options.generateOptions || this.generateOptions,
      };

      this.templates.push(new AssistantTemplate(assistantOptions));
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
  addTransformer<TNewOutput extends Record<string, unknown>>(
    transformer: SessionTransformer<TOutput, TNewOutput>,
  ): LinearTemplate<TInput, TNewOutput> {
    this.templates.push(createTransformerTemplate(transformer) as Template);
    return this as unknown as LinearTemplate<TInput, TNewOutput>;
  }

  /**
   * Add a schema validation template to enforce structured output
   *
   * This method adds a template that enforces the LLM output to match a specified schema.
   * The structured output will be available in the session metadata under the key 'structured_output'.
   *
   * @example
   * ```typescript
   * // Example 1: Using PromptTrail's native schema
   * const productSchema = defineSchema({
   *   properties: {
   *     name: createStringProperty('The name of the product'),
   *     price: createNumberProperty('The price of the product in USD'),
   *     inStock: createBooleanProperty('Whether the product is in stock'),
   *   },
   *   required: ['name', 'price', 'inStock'],
   * });
   *
   * // Example 2: Using Zod schema
   * const userSchema = z.object({
   *   name: z.string().describe('User name'),
   *   age: z.number().describe('User age'),
   *   email: z.string().email().describe('User email')
   * });
   *
   * // Create a template with schema validation
   * const template = new LinearTemplate()
   *   .addSystem('Extract information from the text.')
   *   .addUser('The new iPhone 15 Pro costs $999 and comes with a titanium frame.')
   *   .addSchema(productSchema); // or userSchema
   *
   * // Execute the template
   * const session = await template.execute(createSession());
   *
   * // Access the structured output
   * const data = session.metadata.get('structured_output');
   * ```
   *
   * @param schema The schema to validate against (either a SchemaType or a Zod schema)
   * @param options Additional options for schema validation
   * @returns The template instance for chaining
   */
  async addSchema<TSchema extends SchemaType | z.ZodType>(
    schema: TSchema,
    options?: {
      generateOptions?: GenerateOptions;
      maxAttempts?: number;
      functionName?: string;
    },
  ): Promise<this> {
    const generateOptions = options?.generateOptions || this.generateOptions;

    if (!generateOptions) {
      throw new Error(
        'generateOptions must be provided to use addSchema. Either set it on the LinearTemplate or pass it to addSchema',
      );
    }

    // Import SchemaTemplate dynamically to avoid circular dependency
    // Use dynamic import for ESM compatibility
    const SchemaTemplateModule = await import('./templates/schema_template');
    const { SchemaTemplate } = SchemaTemplateModule;

    this.templates.push(
      new SchemaTemplate({
        generateOptions,
        schema,
        maxAttempts: options?.maxAttempts,
        functionName: options?.functionName,
      }),
    );

    return this;
  }

  async execute(session: Session<TInput>): Promise<Session<TOutput>> {
    let currentSession: Session<Record<string, unknown>> = session as unknown as Session<Record<string, unknown>>;
    for (const template of this.templates) {
      currentSession = await template.execute(currentSession);
    }
    return currentSession as Session<TOutput>;
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

  addUser(content: string, defaultValue?: string): this {
    this.templates.push(
      new UserTemplate({
        description: content,
        default: defaultValue,
        inputSource: new CallbackInputSource(
          async ({ description }) => description,
        ),
      }),
    );
    return this;
  }

  addAssistant(
    options:
      | string
      | {
          generateOptions?: GenerateOptions;
          content?: string;
        },
  ): this {
    if (typeof options === 'string') {
      this.templates.push(new AssistantTemplate({ content: options }));
    } else {
      // Set the generateOptions on the LoopTemplate if provided
      if (options.generateOptions) {
        this.generateOptions = options.generateOptions;
      }

      // Create AssistantTemplate with the generateOptions from options or from LoopTemplate
      const assistantOptions = {
        ...options,
        generateOptions: options.generateOptions || this.generateOptions,
      };

      this.templates.push(new AssistantTemplate(assistantOptions));
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
