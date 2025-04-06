import { createMetadata } from './metadata';
import type { InputSource } from './input_source';
import { StaticInputSource } from './input_source';
import { interpolateTemplate } from './utils/template_interpolation';
import type { SessionTransformer } from './utils/session_transformer';
import { z } from 'zod';
import { generateText } from './generate';
import { type GenerateOptions } from './generate_options';
import type { ISession, ISchemaType } from './types';
import { type IValidator } from './validators/base';
import { CustomValidator } from './validators/custom';
import { createSession } from './session';

/**
 * Base class for all templates
 */
export abstract class Template<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> {
  public inputSource?: InputSource;
  public generateOptionsOrContent?: GenerateOptions | string;
  abstract execute(
    session?: ISession<TInput>,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession<TOutput>>;

  /**
   * Indicates whether the template instance was constructed with its own InputSource.
   * Container templates use this to decide whether to propagate their InputSource.
   */
  hasOwnInputSource(): boolean {
    return !!this.inputSource;
  }

  /**
   * Indicates whether the template instance was constructed with its own GenerateOptions.
   * Container templates use this to decide whether to propagate their GenerateOptions.
   */
  hasOwnGenerateOptionsOrContent(): boolean {
    return !!this.generateOptionsOrContent;
  }
}

/**
 * Helper function to make sure session is not undefined
 */

function ensureSession<TInput extends Record<string, unknown>>(
  session: ISession<TInput> | undefined,
): ISession<TInput> {
  if (!session) {
    console.warn(
      'Session is undefined. Creating a new session. Please provide a session if you want to use an existing one.',
    );
    return createSession<TInput>();
  }
  return session;
}

/**
 * Helper function to make sure inputSource is not undefined
 */
function ensureInputSource(
  template: Template,
  execute_options?: {
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  },
): InputSource {
  // InputSource is prioritized as follows:
  // 1. execute_options.inputSource (passed in the execute method)
  // 2. template.inputSource (passed in the constructor)
  // 3. raise an error if none is provided
  const inputSource =
    execute_options?.inputSource ?? template.inputSource ?? undefined;
  if (!inputSource) {
    throw new Error('InputSource is required for this template');
  }
  return inputSource;
}

/**
 * Helper function to make sure generateOptions is not undefined
 */
function ensureGenerateOptionsOrContent<T extends Template<any, any>>(
  template: T,
  options?: {
    inputSource?: InputSource;
    generateOptions?: GenerateOptions | string;
  },
): GenerateOptions | string {
  // GenerateOptions is prioritized as follows:
  // 1. options.generateOptions (passed in the execute method)
  // 2. template.options.generateOptions (passed in the constructor)
  // 3. raise an error if none is provided
  const generateOptions =
    options?.generateOptions ?? template.generateOptionsOrContent ?? undefined;
  if (!generateOptions) {
    throw new Error('GenerateOptions is required for this template');
  }
  return generateOptions;
}

/**
 * Template for system messages
 */
export class SystemTemplate extends Template {
  constructor(private content: string) {
    super();
  }

  async execute(
    session?: ISession,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    session = ensureSession(session);
    const interpolatedContent = interpolateTemplate(
      this.content,
      session?.metadata || createMetadata(),
    );
    return session!.addMessage({
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
  private options?: {
    description?: string;
    validate?: (input: string) => Promise<boolean>;
    onInput?: (input: string) => void;
    default?: string;
    validator?: IValidator;
  };
  constructor(
    inputOrConfig:
      | string
      | InputSource
      | {
          inputSource?: InputSource;
          description?: string;
          validate?: (input: string) => Promise<boolean>;
          onInput?: (input: string) => void;
          default?: string;
          validator?: IValidator;
        } = {},
  ) {
    super();
    // If string is just passed, convert it to StaticInputSource
    if (typeof inputOrConfig === 'string') {
      this.inputSource = new StaticInputSource(inputOrConfig);
    }
    // If InputSource is passed, use it directly - この部分を修正
    else if (
      inputOrConfig !== undefined &&
      typeof inputOrConfig === 'object' &&
      'getInput' in inputOrConfig
    ) {
      this.inputSource = inputOrConfig as InputSource;
    }
    // Set other properties if provided
    else if (typeof inputOrConfig === 'object') {
      this.inputSource = inputOrConfig.inputSource;
      this.options = {
        description: inputOrConfig.description,
        validate: inputOrConfig.validate,
        onInput: inputOrConfig.onInput,
        default: inputOrConfig.default,
        validator: inputOrConfig.validator,
      };
    }
  }

  async execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    session = ensureSession(session);
    const inputSource = ensureInputSource(this, options);
    let input: string;
    let updatedSession = session;

    input = interpolateTemplate(
      await inputSource.getInput({
        metadata: session.metadata,
      }),
      session.metadata,
    );

    if (this.options?.onInput) {
      this.options.onInput(input);
    }

    if (this.options?.validate && !this.options.validator) {
      const validateFn = this.options.validate;
      this.options.validator = new CustomValidator(
        async (content: string) => {
          const isValid = await validateFn(content);
          return isValid
            ? { isValid: true }
            : { isValid: false, instruction: 'Validation failed' };
        },
        { description: 'Input validation' },
      );
    }

    updatedSession = updatedSession.addMessage({
      type: 'user',
      content: input,
      metadata: createMetadata(),
    });

    if (this.options?.validator) {
      let attempts = 0;
      let result = await this.options.validator.validate(input, updatedSession);

      while (!result.isValid) {
        attempts++;

        updatedSession = updatedSession.addMessage({
          type: 'system',
          content: `Validation failed: ${result.isValid ? '' : result.instruction}. Please try again.`,
          metadata: createMetadata(),
        });

        if (!this.inputSource) {
          throw new Error(
            'InputSource is required for UserTemplate validation',
          );
        }
        input = await this.inputSource.getInput({
          metadata: updatedSession.metadata,
        });

        if (this.options.onInput) {
          this.options.onInput(input);
        }

        updatedSession = updatedSession.addMessage({
          type: 'user',
          content: input,
          metadata: createMetadata(),
        });

        result = await this.options.validator.validate(input, updatedSession);

        const validator = this.options.validator as {
          maxAttempts?: number;
          raiseErrorAfterMaxAttempts?: boolean;
        };
        if (validator.maxAttempts && attempts >= validator.maxAttempts) {
          if (validator.raiseErrorAfterMaxAttempts) {
            throw new Error(
              `Input validation failed after ${attempts} attempts: ${result.isValid ? '' : result.instruction}`,
            );
          }
          break;
        }
      }
    }

    return updatedSession;
  }
}

/**
 * Template for assistant messages
 */
export class AssistantTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> extends Template<TInput, TOutput> {
  private options: {
    validator?: IValidator;
    maxAttempts?: number;
    raiseError?: boolean;
  };

  constructor(
    contentOrGenerateOptions?: string | GenerateOptions, // Make optional
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    super();
    if (typeof contentOrGenerateOptions === 'string') {
      if (
        validatorOrOptions &&
        typeof validatorOrOptions === 'object' &&
        !('validate' in validatorOrOptions)
      ) {
        this.generateOptionsOrContent = contentOrGenerateOptions;
        this.options = {
          validator: validatorOrOptions.validator,
          maxAttempts: validatorOrOptions.maxAttempts,
          raiseError: validatorOrOptions.raiseError,
        };
      } else {
        this.generateOptionsOrContent = contentOrGenerateOptions;
        this.options = {
          validator: validatorOrOptions as IValidator | undefined,
          maxAttempts: 1,
          raiseError: true,
        };
      }
    } else {
      if (
        validatorOrOptions &&
        typeof validatorOrOptions === 'object' &&
        !('validate' in validatorOrOptions)
      ) {
        this.generateOptionsOrContent =
          contentOrGenerateOptions as GenerateOptions;
        this.options = {
          validator: validatorOrOptions.validator,
          maxAttempts: validatorOrOptions.maxAttempts,
          raiseError: validatorOrOptions.raiseError,
        };
      } else {
        this.generateOptionsOrContent =
          contentOrGenerateOptions as GenerateOptions;
        this.options = {
          validator: validatorOrOptions as IValidator | undefined,
          maxAttempts: 1,
          raiseError: true,
        };
      }
    }

    if (this.options.maxAttempts === undefined) {
      this.options.maxAttempts = 1;
    }
    if (this.options.raiseError === undefined) {
      this.options.raiseError = true;
    }
  }

  async execute(
    session?: ISession<TInput>,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession<TOutput>> {
    session = ensureSession(session);
    const generateOptionsOrContent = ensureGenerateOptionsOrContent(
      this,
      options,
    );
    if (!generateOptionsOrContent) {
      throw new Error('generateOptions is required for AssistantTemplate');
    }

    if (typeof generateOptionsOrContent === 'string') {
      // For fixed content responses
      const interpolatedContent = interpolateTemplate(
        generateOptionsOrContent,
        session.metadata,
      );

      if (this.options.validator) {
        const result = await this.options.validator.validate(
          interpolatedContent,
          session as ISession,
        );
        if (!result.isValid) {
          if (this.options.raiseError) {
            throw new Error(
              `Assistant content validation failed: ${result.instruction || 'Invalid content'}`,
            );
          }
        }
      }

      return session.addMessage({
        type: 'assistant',
        content: interpolatedContent,
        metadata: createMetadata(),
      }) as unknown as ISession<TOutput>;
    }

    let attempts = 0;
    let lastValidationError: string | undefined;

    while (attempts < (this.options.maxAttempts || 1)) {
      attempts++;

      // Cast session to any to avoid type issues with the generateText function
      const response = await generateText(
        session as ISession,
        generateOptionsOrContent,
      );

      if (
        !this.options.validator ||
        response.type !== 'assistant' ||
        !response.content
      ) {
        // Add the assistant message to the session
        return session.addMessage(response) as unknown as ISession<TOutput>;
      }

      const result = await this.options.validator.validate(
        response.content,
        session as ISession,
      );
      if (result.isValid) {
        return session.addMessage(response) as unknown as ISession<TOutput>;
      }

      lastValidationError = result.instruction || 'Invalid content';

      if (
        attempts >= (this.options.maxAttempts || 1) &&
        this.options.raiseError
      ) {
        throw new Error(
          `Assistant response validation failed after ${attempts} attempts: ${lastValidationError}`,
        );
      }
    }

    const finalResponse = await generateText(
      session as ISession,
      generateOptionsOrContent,
    );

    // Add the assistant message to the session
    let updatedSession = session.addMessage(
      finalResponse,
    ) as unknown as ISession<TOutput>;

    const toolCalls =
      finalResponse.type === 'assistant' ? finalResponse.toolCalls : undefined;

    if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
      // Execute each tool call and add the result as a tool_result message
      for (const toolCall of toolCalls) {
        const toolName = toolCall.name;
        const toolArgs = toolCall.arguments;
        const toolCallId = toolCall.id;

        // Get the tool from the generateOptions
        const tools = generateOptionsOrContent.tools || {};
        const tool = tools[toolName] as {
          execute: (
            args: Record<string, unknown>,
            context: { toolCallId: string },
          ) => Promise<unknown>;
        }; // Cast to specific type

        if (tool && typeof tool.execute === 'function') {
          try {
            // Execute the tool
            const result = await tool.execute(toolArgs, { toolCallId });

            // Add the tool result to the session
            const resultStr =
              typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2);

            // Create a tool result template and execute it
            const toolResultTemplate = new ToolResultTemplate({
              toolCallId,
              content: resultStr,
            });

            // Cast to any to avoid type issues
            updatedSession = (await toolResultTemplate.execute(
              updatedSession as ISession<Record<string, unknown>>,
            )) as ISession<TOutput>;
          } catch (error) {
            // If the tool execution fails, add an error message as the tool result
            const errorMessage =
              error instanceof Error
                ? error.message
                : 'Unknown error occurred during tool execution';

            const toolResultTemplate = new ToolResultTemplate({
              toolCallId,
              content: `Error: ${errorMessage}`,
            });

            // Cast to any to avoid type issues
            updatedSession = (await toolResultTemplate.execute(
              updatedSession as ISession<Record<string, unknown>>,
            )) as ISession<TOutput>;
          }
        }
      }
    }

    return updatedSession;
  }
}

/**
 * Template for tool results
 */
export class ToolResultTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> extends Template<TInput, TOutput> {
  constructor(
    private options: {
      toolCallId: string;
      content: string;
    },
  ) {
    super();
  }

  async execute(session?: ISession<TInput>): Promise<ISession<TOutput>> {
    session = ensureSession(session);
    const metadata = createMetadata<{ toolCallId: string }>();
    metadata.set('toolCallId', this.options.toolCallId);

    return session.addMessage({
      type: 'tool_result',
      content: this.options.content,
      metadata,
      result: this.options.content, // Add the result property
    }) as unknown as ISession<TOutput>;
  }
}

/**
 * Template for conditional execution based on a condition
 */
export class IfTemplate extends Template {
  constructor(
    private options: {
      condition: (session: ISession) => boolean;
      thenTemplate: Template;
      elseTemplate?: Template;
    },
  ) {
    super();
  }

  async execute(session?: ISession): Promise<ISession> {
    session = ensureSession(session);
    if (this.options.condition(session)) {
      return this.options.thenTemplate.execute(session);
    } else if (this.options.elseTemplate) {
      return this.options.elseTemplate.execute(session);
    }
    return session; // If no else template and condition is false, return session unchanged
  }
}

/**
 * Shared constructor type for mixins
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T = Record<string, unknown>> = new (...args: any[]) => T;

/**
 * Mixin functions for adding functionality to Templates have child classes
 */
function WithAssistant<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addAssistant(contentOrGenerateOptions?: string | GenerateOptions): this {
      this.templates.push(new AssistantTemplate(contentOrGenerateOptions));
      return this;
    }
  };
}

function WithUser<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addUser(
      contentOrInputSource?:
        | string
        | InputSource
        | {
            inputSource?: InputSource;
            description?: string;
            validate?: (input: string) => Promise<boolean>;
            onInput?: (input: string) => void;
            default?: string;
            validator?: IValidator;
          },
    ): this {
      this.templates.push(new UserTemplate(contentOrInputSource));
      return this;
    }
  };
}

function WithSystem<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addSystem(content: string): this {
      this.templates.push(new SystemTemplate(content));
      return this;
    }
  };
}

function WithLoop<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addLoop(loop: Template): this {
      this.templates.push(loop);
      return this;
    }
  };
}

function WithIf<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addIf(options: {
      condition: (session: ISession) => boolean;
      thenTemplate: Template;
      elseTemplate?: Template;
    }): this {
      this.templates.push(new IfTemplate(options));
      return this;
    }
  };
}

function WithTransformer<
  TBase extends Constructor<{ templates: Template[] }>,
  _TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
>(Base: TBase) {
  return class extends Base {
    addTransformer<TNewOutput extends Record<string, unknown>>(
      transformer: SessionTransformer<TOutput, TNewOutput>,
    ): LinearTemplate {
      // Cast the transformer to the expected type to avoid TypeScript errors
      const castTransformer = transformer as unknown as SessionTransformer<
        Record<string, unknown>,
        Record<string, unknown>
      >;
      this.templates.push(new TransformerTemplate(castTransformer));
      return this as unknown as LinearTemplate;
    }
  };
}

function WithSchema<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    async addSchema<TSchema extends ISchemaType | z.ZodType>(
      schema: TSchema,
      options: {
        generateOptions: GenerateOptions;
        maxAttempts?: number;
        functionName?: string;
      },
    ): Promise<this> {
      // Import SchemaTemplate dynamically to avoid circular dependency
      // Use dynamic import for ESM compatibility
      const SchemaTemplateModule = await import('./schema_template');
      const { SchemaTemplate } = SchemaTemplateModule;

      this.templates.push(
        new SchemaTemplate({
          generateOptions: options.generateOptions,
          schema: schema as z.ZodType,
          maxAttempts: options?.maxAttempts,
          functionName: options?.functionName,
        }),
      );

      return this;
    }
  };
}

function WithSubroutine<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addSubroutine(options: {
      template: Template;
      initWith: (parentSession: ISession) => ISession;
      squashWith?: (
        parentSession: ISession,
        childSession: ISession,
      ) => ISession;
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    }): this {
      // Create a template instance directly instead of using SubroutineTemplate constructor
      const template = new SubroutineTemplate(options);
      this.templates.push(template);
      return this;
    }
  };
}

/**
 * Base class for LinearTemplate
 */
class LinearTemplateBase extends Template {
  templates: Template[] = [];
  private options?: {
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  };

  constructor(options?: {
    templates?: Template[];
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }) {
    super();
    this.templates = options?.templates || [];
    this.options = options;
  }

  async execute(
    session?: ISession<Record<string, unknown>>,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession<Record<string, unknown>>> {
    session = ensureSession(session);
    let currentSession: ISession<Record<string, unknown>> = session;
    const inputSource = options?.inputSource ?? this.options?.inputSource;
    const generateOptions =
      options?.generateOptions ?? this.options?.generateOptions;

    for (const template of this.templates) {
      const childOptions: {
        inputSource?: InputSource;
        generateOptions?: GenerateOptions;
      } = {};

      if (inputSource && !template.hasOwnInputSource()) {
        childOptions.inputSource = inputSource;
      }

      if (generateOptions && !template.hasOwnGenerateOptionsOrContent()) {
        childOptions.generateOptions = generateOptions;
      }

      currentSession = await template.execute(currentSession, childOptions);
    }
    return currentSession;
  }
}

/**
 * Template for linear sequence of templates
 */
export class LinearTemplate extends WithSchema(
  WithAssistant(
    WithUser(
      WithSystem(
        WithTransformer(WithSubroutine(WithIf(WithLoop(LinearTemplateBase)))),
      ),
    ),
  ),
) {}

// Agent class is alias for LinearTemplate
export class Agent extends LinearTemplate {
  constructor(options?: {
    templates?: Template[];
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }) {
    super(options);
  }
}

/**
 * Base class for LoopTemplate
 */
class LoopTemplateBase extends Template {
  templates: Template[] = [];
  exitCondition?: (session: ISession) => boolean;
  private options?: {
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  };

  constructor(options?: {
    templates?: Template[];
    exitCondition?: (session: ISession) => boolean;
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }) {
    super();
    this.templates = options?.templates || [];
    this.exitCondition = options?.exitCondition;
    this.options = options;
  }

  setExitCondition(condition: (session: ISession) => boolean): this {
    this.exitCondition = condition;
    return this;
  }

  async execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    session = ensureSession(session);
    if (!this.exitCondition) {
      throw new Error('Exit condition not set for LoopTemplate');
    }

    let currentSession = session;
    const inputSource = options?.inputSource ?? this.options?.inputSource;
    const generateOptions =
      options?.generateOptions ?? this.options?.generateOptions;

    do {
      for (const template of this.templates) {
        const childOptions: {
          inputSource?: InputSource;
          generateOptions?: GenerateOptions;
        } = {};

        if (inputSource && !template.hasOwnInputSource()) {
          childOptions.inputSource = inputSource;
        }

        if (generateOptions && !template.hasOwnGenerateOptionsOrContent()) {
          childOptions.generateOptions = generateOptions;
        }

        currentSession = await template.execute(currentSession, childOptions);
      }
    } while (!this.exitCondition(currentSession));

    return currentSession;
  }
}

/**
 * Template for looping sequence of templates
 */
export class LoopTemplate extends WithSchema(
  WithAssistant(
    WithUser(
      WithSystem(
        WithTransformer(WithSubroutine(WithIf(WithLoop(LoopTemplateBase)))),
      ),
    ),
  ),
) {}

/**
 * Template for nested conversations with separate session context
 */
export class SubroutineTemplate extends Template {
  protected template: Template;
  protected initWith: (parentSession: ISession) => ISession;
  protected squashWith?: (
    parentSession: ISession,
    childSession: ISession,
  ) => ISession;
  protected options: {
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  };

  constructor(options: {
    template: Template;
    initWith: (parentSession: ISession) => ISession;
    squashWith?: (parentSession: ISession, childSession: ISession) => ISession;
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }) {
    super();
    this.template = options.template;
    this.initWith = options.initWith;
    this.squashWith = options.squashWith;
    this.options = options;
  }

  async execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    session = ensureSession(session);
    // Create child session using initWith function
    const childSession = this.initWith(session);

    const inputSource = options?.inputSource ?? this.options?.inputSource;
    const generateOptions =
      options?.generateOptions ?? this.options?.generateOptions;

    const childOptions: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    } = {};

    if (inputSource && !this.template.hasOwnInputSource()) {
      childOptions.inputSource = inputSource;
    }

    if (generateOptions && !this.template.hasOwnGenerateOptionsOrContent()) {
      childOptions.generateOptions = generateOptions;
    }

    // Execute the template with child session
    const resultSession = await this.template.execute(
      childSession,
      childOptions,
    );

    // If squashWith is provided, merge results back to parent session
    if (this.squashWith) {
      return this.squashWith(session, resultSession);
    }

    // Otherwise just return parent session unchanged
    return session;
  }
}

/**
 * Template that applies a transformer to a session
 */
export class TransformerTemplate extends Template {
  constructor(
    private transformer: SessionTransformer<
      Record<string, unknown>,
      Record<string, unknown>
    >,
  ) {
    super();
  }

  async execute(session?: ISession): Promise<ISession> {
    session = ensureSession(session);
    return this.transformer.transform(session);
  }
}
