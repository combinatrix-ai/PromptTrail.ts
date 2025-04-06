// templates.ts (Executorクラスなしの実装)
import { createMetadata } from './metadata';
import type { InputSource } from './input_source';
import { StaticInputSource } from './input_source';
import { interpolateTemplate } from './utils/template_interpolation';
import type { SessionTransformer } from './utils/session_transformer';
import { generateText } from './generate';
import { type GenerateOptions } from './generate_options';
import type { ISession } from './types';
import { type IValidator } from './validators/base';
import { CustomValidator } from './validators/custom';
import { createSession } from './session';

/**
 * Collection of shared utilities for templates
 */
export class TemplateUtils {
  /**
   * Helper function to make sure session is not undefined
   */
  static ensureSession<TInput extends Record<string, unknown>>(
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
   * Validate and prepare template execution options
   */
  static prepareExecutionOptions(
    template: Template,
    session: ISession | undefined,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions | string;
    },
  ): {
    session: ISession;
    inputSource?: InputSource;
    generateOptions?: GenerateOptions | string;
  } {
    session = TemplateUtils.ensureSession(session);

    // InputSource is prioritized as follows:
    // 1. options.inputSource (passed in the execute method)
    // 2. template.inputSource (passed in the constructor)
    const inputSource = options?.inputSource ?? template.getInputSource();

    // GenerateOptions is prioritized as follows:
    // 1. options.generateOptions (passed in the execute method)
    // 2. template.generateOptionsOrContent (passed in the constructor)
    const generateOptions =
      options?.generateOptions ?? template.getGenerateOptionsOrContent();

    return { session, inputSource, generateOptions };
  }

  /**
   * Interpolate content with session metadata
   */
  static interpolateContent(content: string, session: ISession): string {
    return interpolateTemplate(content, session.metadata || createMetadata());
  }
}

/**
 * Base class for all templates
 */
export abstract class Template<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> {
  protected inputSource?: InputSource;
  protected generateOptionsOrContent?: GenerateOptions | string;

  abstract execute(
    session?: ISession<TInput>,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions | string;
    },
  ): Promise<ISession<TOutput>>;

  getInputSource(): InputSource | undefined {
    return this.inputSource;
  }

  getGenerateOptionsOrContent(): GenerateOptions | string | undefined {
    return this.generateOptionsOrContent;
  }

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
 * Class for templating system messages
 */
export class SystemTemplate extends Template {
  constructor(private content: string) {
    super();
  }

  async execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    const { session: validSession } = TemplateUtils.prepareExecutionOptions(
      this,
      session,
      options,
    );

    const interpolatedContent = TemplateUtils.interpolateContent(
      this.content,
      validSession,
    );
    return validSession.addMessage({
      type: 'system',
      content: interpolatedContent,
      metadata: createMetadata(),
    });
  }
}

/**
 * Class for templating user messages
 */
export class UserTemplate extends Template {
  private options: {
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

    this.options = {};

    // Process the input options
    if (typeof inputOrConfig === 'string') {
      this.inputSource = new StaticInputSource(inputOrConfig);
    } else if (
      inputOrConfig !== undefined &&
      typeof inputOrConfig === 'object' &&
      'getInput' in inputOrConfig
    ) {
      this.inputSource = inputOrConfig as InputSource;
    } else if (typeof inputOrConfig === 'object') {
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
    const { session: validSession, inputSource } =
      TemplateUtils.prepareExecutionOptions(this, session, options);

    // Use the input source passed to the template or fallback to the one provided at execution time
    const effectiveInputSource = this.inputSource ?? inputSource;

    if (!effectiveInputSource) {
      throw new Error('InputSource is required for UserTemplate');
    }

    let input: string;
    let updatedSession = validSession;

    input = TemplateUtils.interpolateContent(
      await effectiveInputSource.getInput({
        metadata: validSession.metadata,
      }),
      validSession,
    );

    if (this.options?.onInput) {
      this.options.onInput(input);
    }

    if (this.options?.validate && !this.options?.validator) {
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
      updatedSession = await this.validateInput(
        updatedSession,
        input,
        effectiveInputSource,
      );
    }

    return updatedSession;
  }

  private async validateInput(
    session: ISession,
    input: string,
    inputSource: InputSource,
  ): Promise<ISession> {
    if (!this.options?.validator) {
      return session;
    }

    let updatedSession = session;
    let attempts = 0;
    let result = await this.options.validator.validate(input, updatedSession);

    while (!result.isValid) {
      attempts++;

      updatedSession = updatedSession.addMessage({
        type: 'system',
        content: `Validation failed: ${result.instruction || ''}. Please try again.`,
        metadata: createMetadata(),
      });

      const newInput = await inputSource.getInput({
        metadata: updatedSession.metadata,
      });

      if (this.options.onInput) {
        this.options.onInput(newInput);
      }

      updatedSession = updatedSession.addMessage({
        type: 'user',
        content: newInput,
        metadata: createMetadata(),
      });

      result = await this.options.validator.validate(newInput, updatedSession);

      const validator = this.options.validator as {
        maxAttempts?: number;
        raiseErrorAfterMaxAttempts?: boolean;
      };

      if (validator.maxAttempts && attempts >= validator.maxAttempts) {
        if (validator.raiseErrorAfterMaxAttempts) {
          throw new Error(
            `Input validation failed after ${attempts} attempts: ${!result.isValid && 'instruction' in result ? result.instruction : ''}`,
          );
        }
        break;
      }
    }

    return updatedSession;
  }
}

/**
 * Class for templating assistant messages
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
    contentOrGenerateOptions?: string | GenerateOptions,
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    super();

    // Initialize options with defaults
    this.options = {
      maxAttempts: 1,
      raiseError: true,
    };

    // Process validator options
    if (validatorOrOptions) {
      if ('validate' in validatorOrOptions) {
        this.options.validator = validatorOrOptions as IValidator;
      } else {
        this.options = {
          ...this.options,
          ...(validatorOrOptions as {
            validator?: IValidator;
            maxAttempts?: number;
            raiseError?: boolean;
          }),
        };
      }
    }

    this.generateOptionsOrContent = contentOrGenerateOptions;
  }

  async execute(
    session?: ISession<TInput>,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession<TOutput>> {
    const { session: validSession, generateOptions } =
      TemplateUtils.prepareExecutionOptions(
        this as unknown as Template<
          Record<string, unknown>,
          Record<string, unknown>
        >,
        session as ISession<Record<string, unknown>> | undefined,
        options,
      );

    // Use the generate options passed to the template or fallback to the one provided at execution time
    const effectiveGenerateOptions =
      this.generateOptionsOrContent ?? generateOptions;

    if (!effectiveGenerateOptions) {
      throw new Error('GenerateOptions is required for AssistantTemplate');
    }

    if (typeof effectiveGenerateOptions === 'string') {
      return this.handleStaticContent(
        validSession,
        effectiveGenerateOptions,
      ) as Promise<ISession<TOutput>>;
    }

    return this.handleGeneratedContent(
      validSession,
      effectiveGenerateOptions,
    ) as Promise<ISession<TOutput>>;
  }

  private async handleStaticContent(
    session: ISession,
    content: string,
  ): Promise<ISession> {
    const interpolatedContent = TemplateUtils.interpolateContent(
      content,
      session,
    );

    if (this.options.validator) {
      const result = await this.options.validator.validate(
        interpolatedContent,
        session,
      );

      if (!result.isValid && this.options.raiseError) {
        throw new Error(
          `Assistant content validation failed: ${result.instruction || 'Invalid content'}`,
        );
      }
    }

    return session.addMessage({
      type: 'assistant',
      content: interpolatedContent,
      metadata: createMetadata(),
    });
  }

  private async handleGeneratedContent(
    session: ISession,
    generateOptions: GenerateOptions,
  ): Promise<ISession> {
    let attempts = 0;
    let lastValidationError: string | undefined;

    while (attempts < (this.options.maxAttempts || 1)) {
      attempts++;

      const response = await generateText(session, generateOptions);

      if (
        !this.options.validator ||
        response.type !== 'assistant' ||
        !response.content
      ) {
        // Add the assistant message to the session
        return session.addMessage(response);
      }

      const result = await this.options.validator.validate(
        response.content,
        session,
      );

      if (result.isValid) {
        return session.addMessage(response);
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

    const finalResponse = await generateText(session, generateOptions);
    let updatedSession = session.addMessage(finalResponse);

    const toolCalls =
      finalResponse.type === 'assistant' ? finalResponse.toolCalls : undefined;

    if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
      updatedSession = await this.handleToolCalls(
        updatedSession,
        toolCalls,
        generateOptions,
      );
    }

    return updatedSession;
  }

  private async handleToolCalls(
    session: ISession,
    toolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }>,
    generateOptions: GenerateOptions,
  ): Promise<ISession> {
    let updatedSession = session;

    // Execute each tool call and add the result as a tool_result message
    for (const toolCall of toolCalls) {
      const toolName = toolCall.name;
      const toolArgs = toolCall.arguments;
      const toolCallId = toolCall.id;

      // Get the tool from the generateOptions
      const tools = generateOptions.tools || {};
      const tool = tools[toolName] as {
        execute: (
          args: Record<string, unknown>,
          context: { toolCallId: string },
        ) => Promise<unknown>;
      };

      if (tool && typeof tool.execute === 'function') {
        try {
          // Execute the tool
          const result = await tool.execute(toolArgs, { toolCallId });

          // Format the result
          const resultStr =
            typeof result === 'string'
              ? result
              : JSON.stringify(result, null, 2);

          // Add tool result to session
          const toolResultTemplate = new ToolResultTemplate({
            toolCallId,
            content: resultStr,
          });
          updatedSession = await toolResultTemplate.execute(updatedSession);
        } catch (error) {
          // If the tool execution fails, add an error message as the tool result
          const errorMessage =
            error instanceof Error
              ? error.message
              : 'Unknown error occurred during tool execution';

          // Add error as tool result
          const toolResultTemplate = new ToolResultTemplate({
            toolCallId,
            content: `Error: ${errorMessage}`,
          });
          updatedSession = await toolResultTemplate.execute(updatedSession);
        }
      }
    }

    return updatedSession;
  }
}

/**
 * Class for tool results
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

  async execute(
    session?: ISession<TInput>,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions | string;
    },
  ): Promise<ISession<TOutput>> {
    const { session: validSession } = TemplateUtils.prepareExecutionOptions(
      this as unknown as Template<
        Record<string, unknown>,
        Record<string, unknown>
      >,
      session as ISession<Record<string, unknown>> | undefined,
      options,
    );

    const metadata = createMetadata<{ toolCallId: string }>();
    metadata.set('toolCallId', this.options.toolCallId);

    return validSession.addMessage({
      type: 'tool_result',
      content: this.options.content,
      metadata,
      result: this.options.content, // Add the result property
    }) as ISession<TOutput>;
  }
}

/**
 * Class for conditional execution
 */
/**
 * Class for conditional execution
 */
export class IfTemplate extends Template {
  private condition: (session: ISession) => boolean;
  private thenTemplate: Template;
  private elseTemplate?: Template;

  constructor(options: {
    condition: (session: ISession) => boolean;
    thenTemplate: Template;
    elseTemplate?: Template;
  }) {
    super();
    this.condition = options.condition;
    this.thenTemplate = options.thenTemplate;
    this.elseTemplate = options.elseTemplate;
  }

  async execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    const {
      session: validSession,
      inputSource,
      generateOptions,
    } = TemplateUtils.prepareExecutionOptions(this, session, options);

    if (this.condition(validSession)) {
      return this.thenTemplate.execute(validSession, {
        inputSource,
        generateOptions,
      });
    } else if (this.elseTemplate) {
      return this.elseTemplate.execute(validSession, {
        inputSource,
        generateOptions,
      });
    }
    return validSession; // If no else template and condition is false, return session unchanged
  }
}

/**
 * Class for transforming sessions
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
    const { session: validSession } = TemplateUtils.prepareExecutionOptions(
      this,
      session,
      {},
    );

    return this.transformer.transform(validSession);
  }
}

/**
 * テンプレート操作を提供する中間基底クラス
 * 共通のテンプレート追加メソッドを実装
 */
export abstract class ComposedTemplate extends Template {
  protected templates: Template[] = [];

  /**
   * システムメッセージテンプレートを追加
   */
  addSystem(content: string): this {
    this.templates.push(new SystemTemplate(content));
    return this;
  }

  /**
   * ユーザーメッセージテンプレートを追加
   */
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

  /**
   * アシスタントメッセージテンプレートを追加
   */
  addAssistant(contentOrGenerateOptions?: string | GenerateOptions): this {
    this.templates.push(new AssistantTemplate(contentOrGenerateOptions));
    return this;
  }

  /**
   * 条件付きテンプレートを追加
   */
  addIf(template: IfTemplate): this;
  addIf(options: {
    condition: (session: ISession) => boolean;
    thenTemplate: Template;
    elseTemplate?: Template;
  }): this;
  addIf(
    arg:
      | IfTemplate
      | {
          condition: (session: ISession) => boolean;
          thenTemplate: Template;
          elseTemplate?: Template;
        },
  ): this {
    const template = arg instanceof IfTemplate ? arg : new IfTemplate(arg);
    this.templates.push(template);
    return this;
  }

  /**
   * サブルーチンテンプレートを追加
   */
  addSubroutine(template: SubroutineTemplate): this;
  addSubroutine(options: {
    template: Template;
    initWith: (parentSession: ISession) => ISession;
    squashWith?: (parentSession: ISession, childSession: ISession) => ISession;
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }): this;
  addSubroutine(
    arg:
      | SubroutineTemplate
      | {
          template: Template;
          initWith: (parentSession: ISession) => ISession;
          squashWith?: (
            parentSession: ISession,
            childSession: ISession,
          ) => ISession;
          inputSource?: InputSource;
          generateOptions?: GenerateOptions;
        },
  ): this {
    const template =
      arg instanceof SubroutineTemplate ? arg : new SubroutineTemplate(arg);
    this.templates.push(template);
    return this;
  }

  /**
   * ループテンプレートを追加
   */
  addLoop(template: LoopTemplate): this;
  addLoop(options: {
    templates: Template[];
    exitCondition: (session: ISession) => boolean;
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }): this;
  addLoop(
    arg:
      | LoopTemplate
      | {
          templates: Template[];
          exitCondition: (session: ISession) => boolean;
          inputSource?: InputSource;
          generateOptions?: GenerateOptions;
        },
  ): this {
    const template = arg instanceof LoopTemplate ? arg : new LoopTemplate(arg);
    this.templates.push(template);
    return this;
  }

  /**
   * Linearテンプレートを追加
   */
  addLinear(template: LinearTemplate): this;
  addLinear(options: {
    templates: Template[];
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }): this;
  addLinear(
    arg:
      | LinearTemplate
      | {
          templates: Template[];
          inputSource?: InputSource;
          generateOptions?: GenerateOptions;
        },
  ): this {
    const template =
      arg instanceof LinearTemplate ? arg : new LinearTemplate(arg);
    this.templates.push(template);
    return this;
  }

  /**
   * トランスフォーマーテンプレートを追加
   */
  addTransformer<TOutput extends Record<string, unknown>>(
    transformer: SessionTransformer<Record<string, unknown>, TOutput>,
  ): this {
    this.templates.push(new TransformerTemplate(transformer));
    return this;
  }

  /**
   * 任意のテンプレートを追加
   */
  addTemplate(template: Template): this {
    this.templates.push(template);
    return this;
  }

  /**
   * テンプレートの取得
   */
  getTemplates(): Template[] {
    return this.templates;
  }

  /**
   * テンプレートの設定
   */
  setTemplates(templates: Template[]): this {
    this.templates = templates;
    return this;
  }

  /**
   * テンプレートの実行（サブクラスで実装）
   */
  abstract execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession>;
}

/**
 * Template for nested conversations with separate session context
 */
export class SubroutineTemplate extends ComposedTemplate {
  constructor(
    private options: {
      template: Template;
      initWith: (parentSession: ISession) => ISession;
      squashWith?: (
        parentSession: ISession,
        childSession: ISession,
      ) => ISession;
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ) {
    super();
    this.inputSource = options.inputSource;
    this.generateOptionsOrContent = options.generateOptions;
  }

  async execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    const {
      session: validSession,
      inputSource,
      generateOptions,
    } = TemplateUtils.prepareExecutionOptions(this, session, options);

    // Create child session using initWith function
    const childSession = this.options.initWith(validSession);

    const childOptions: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions | string;
    } = {};

    if (inputSource && !this.options.template.hasOwnInputSource()) {
      childOptions.inputSource = inputSource;
    }

    if (
      generateOptions &&
      !this.options.template.hasOwnGenerateOptionsOrContent()
    ) {
      childOptions.generateOptions = generateOptions;
    }

    // Execute the template with child session
    const resultSession = await this.options.template.execute(
      childSession,
      childOptions,
    );

    // If squashWith is provided, merge results back to parent session
    if (this.options.squashWith) {
      return this.options.squashWith(validSession, resultSession);
    }

    // Otherwise just return parent session unchanged
    return validSession;
  }
}

/**
 * Class for looping sequences of templates
 */
export class LoopTemplate extends ComposedTemplate {
  private exitCondition?: (session: ISession) => boolean;

  constructor(options?: {
    templates?: Template[];
    exitCondition?: (session: ISession) => boolean;
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }) {
    super();
    this.templates = options?.templates || [];
    this.exitCondition = options?.exitCondition;
    this.inputSource = options?.inputSource;
    this.generateOptionsOrContent = options?.generateOptions;
  }

  // Add method to set exit condition
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
    const {
      session: validSession,
      inputSource,
      generateOptions,
    } = TemplateUtils.prepareExecutionOptions(this, session, options);

    if (!this.exitCondition) {
      throw new Error('Exit condition not set for LoopTemplate');
    }

    let currentSession = validSession;

    do {
      for (const template of this.templates) {
        const childOptions: {
          inputSource?: InputSource;
          generateOptions?: GenerateOptions | string;
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
 * Linear template composition with fluent API for creating template chains
 */
export class LinearTemplate extends ComposedTemplate {
  constructor(options?: {
    templates?: Template[];
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }) {
    super();
    this.inputSource = options?.inputSource;
    this.generateOptionsOrContent = options?.generateOptions;

    // Add initial templates if provided
    if (options?.templates) {
      for (const template of options.templates) {
        this.addTemplate(template);
      }
    }
  }

  async execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    const {
      session: validSession,
      inputSource,
      generateOptions,
    } = TemplateUtils.prepareExecutionOptions(this, session, options);

    let currentSession = validSession;

    for (const template of this.templates) {
      const childOptions: {
        inputSource?: InputSource;
        generateOptions?: GenerateOptions;
      } = {};

      if (inputSource && !template.hasOwnInputSource()) {
        childOptions.inputSource = inputSource;
      }

      if (generateOptions && !template.hasOwnGenerateOptionsOrContent()) {
        childOptions.generateOptions = generateOptions as GenerateOptions;
      }

      currentSession = await template.execute(currentSession, childOptions);
    }

    return currentSession;
  }
}

// Alias for LinearTemplate
export class Agent extends LinearTemplate {
  constructor(options?: {
    templates?: Template[];
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }) {
    super(options);
  }
}
