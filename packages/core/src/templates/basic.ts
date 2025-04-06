// templates.ts (Executorクラスなしの実装)
import { createMetadata } from '../metadata';
import type { InputSource } from '../input_source';
import { StaticInputSource } from '../input_source';
import { interpolateTemplate } from '../utils/template_interpolation';
import type { SessionTransformer } from '../utils/session_transformer';
import { generateText } from '../generate';
import { type GenerateOptions } from '../generate_options';
import type { ISession } from '../types';
import { type IValidator } from '../validators';
import { CustomValidator } from '../validators';
import { createSession } from '../session';
import { 
  ContentSource, 
  StaticContentSource, 
  type ModelContentOutput, 
  BasicModelContentSource,
  StringContentSource
} from '../content_source';

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
    contentSource?: ContentSource<unknown>;
    inputSource?: InputSource;
    generateOptions?: GenerateOptions | string;
  } {
    session = TemplateUtils.ensureSession(session);

    // ContentSource is prioritized as follows:
    // 1. template.contentSource (passed in the constructor)
    const contentSource = template.getContentSource();

    // For backward compatibility:
    // InputSource is prioritized as follows:
    // 1. options.inputSource (passed in the execute method)
    // 2. template.getInputSource() (if available for backward compatibility)
    const inputSource = options?.inputSource ?? 
      ('getInputSource' in template && typeof template.getInputSource === 'function' ? 
        template.getInputSource() : undefined);

    // GenerateOptions is prioritized as follows:
    // 1. options.generateOptions (passed in the execute method)
    // 2. template.getGenerateOptionsOrContent() (if available for backward compatibility)
    const generateOptions = options?.generateOptions ?? 
      ('getGenerateOptionsOrContent' in template && typeof template.getGenerateOptionsOrContent === 'function' ? 
        template.getGenerateOptionsOrContent() : undefined);

    return { session, contentSource, inputSource, generateOptions };
  }

  /**
   * Interpolate content with session metadata
   */
  static interpolateContent(content: string, session: ISession): string {
    return interpolateTemplate(content, session.metadata || createMetadata());
  }

  /**
   * Convert legacy inputs to ContentSource
   */
  static convertToContentSource(
    input: string | InputSource | GenerateOptions | ContentSource<unknown> | undefined
  ): ContentSource<unknown> | undefined {
    if (input === undefined) {
      return undefined;
    }

    // If it's already a ContentSource, return it
    if (input instanceof ContentSource) {
      return input;
    }

    // If it's a string, convert to StaticContentSource
    if (typeof input === 'string') {
      return new StaticContentSource(input);
    }

    // If it's an InputSource, convert to a wrapper ContentSource
    if (input && typeof input === 'object' && 'getInput' in input) {
      return new InputSourceWrapper(input as InputSource);
    }

    // If it's GenerateOptions, convert to BasicModelContentSource
    if (input && typeof input === 'object' && 'provider' in input) {
      return new BasicModelContentSource(input as GenerateOptions);
    }

    return undefined;
  }
}

/**
 * Wrapper to convert InputSource to ContentSource for backward compatibility
 */
class InputSourceWrapper extends StringContentSource {
  constructor(private inputSource: InputSource) {
    super();
  }

  async getContent(session: ISession): Promise<string> {
    return this.inputSource.getInput({
      metadata: session.metadata,
    });
  }

  hasValidator(): boolean {
    return !!this.inputSource.getValidator();
  }

  getValidator(): IValidator | undefined {
    return this.inputSource.getValidator();
  }
}

/**
 * Base class for all templates
 */
export abstract class Template<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
  TContentType = unknown,
> {
  protected contentSource?: ContentSource<TContentType>;
  
  // For backward compatibility
  protected inputSource?: InputSource;
  protected generateOptionsOrContent?: GenerateOptions | string;

  abstract execute(
    session?: ISession<TInput>,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions | string;
    },
  ): Promise<ISession<TOutput>>;

  getContentSource(): ContentSource<TContentType> | undefined {
    return this.contentSource;
  }

  // For backward compatibility
  getInputSource(): InputSource | undefined {
    return this.inputSource;
  }

  // For backward compatibility
  getGenerateOptionsOrContent(): GenerateOptions | string | undefined {
    return this.generateOptionsOrContent;
  }

  /**
   * Indicates whether the template instance was constructed with its own ContentSource.
   * Container templates use this to decide whether to propagate their ContentSource.
   */
  hasOwnContentSource(): boolean {
    return !!this.contentSource;
  }

  /**
   * For backward compatibility
   */
  hasOwnInputSource(): boolean {
    return !!this.inputSource;
  }

  /**
   * For backward compatibility
   */
  hasOwnGenerateOptionsOrContent(): boolean {
    return !!this.generateOptionsOrContent;
  }
}

/**
 * Class for templating system messages
 */
export class SystemTemplate extends Template<
  Record<string, unknown>,
  Record<string, unknown>,
  string
> {
  constructor(contentOrSource: string | ContentSource<string>) {
    super();
    
    // Convert string to StaticContentSource if needed
    if (typeof contentOrSource === 'string') {
      this.contentSource = new StaticContentSource(contentOrSource);
    } else {
      this.contentSource = contentOrSource;
    }
  }

  async execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    const { session: validSession, contentSource } = TemplateUtils.prepareExecutionOptions(
      this,
      session,
      options,
    );

    if (!contentSource) {
      throw new Error('ContentSource is required for SystemTemplate');
    }

    const content = await contentSource.getContent(validSession) as string;
    
    return validSession.addMessage({
      type: 'system',
      content,
      metadata: createMetadata(),
    });
  }
}

/**
 * Class for templating user messages
 */
export class UserTemplate extends Template<
  Record<string, unknown>,
  Record<string, unknown>,
  string
> {
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
      | ContentSource<string>
      | {
          inputSource?: InputSource;
          contentSource?: ContentSource<string>;
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
      this.contentSource = new StaticContentSource(inputOrConfig);
    } else if (
      inputOrConfig !== undefined &&
      typeof inputOrConfig === 'object' &&
      inputOrConfig instanceof ContentSource
    ) {
      this.contentSource = inputOrConfig;
    } else if (
      inputOrConfig !== undefined &&
      typeof inputOrConfig === 'object' &&
      'getInput' in inputOrConfig
    ) {
      // For backward compatibility
      this.inputSource = inputOrConfig as InputSource;
      this.contentSource = new InputSourceWrapper(inputOrConfig as InputSource);
    } else if (typeof inputOrConfig === 'object') {
      // Handle object configuration
      if (inputOrConfig.contentSource) {
        this.contentSource = inputOrConfig.contentSource;
      } else if (inputOrConfig.inputSource) {
        // For backward compatibility
        this.inputSource = inputOrConfig.inputSource;
        this.contentSource = new InputSourceWrapper(inputOrConfig.inputSource);
      }
      
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
    const { session: validSession, contentSource, inputSource } =
      TemplateUtils.prepareExecutionOptions(this, session, options);

    // Use the content source or convert input source for backward compatibility
    let effectiveContentSource = contentSource as ContentSource<string>;
    
    if (!effectiveContentSource && inputSource) {
      effectiveContentSource = new InputSourceWrapper(inputSource);
    }

    if (!effectiveContentSource) {
      throw new Error('ContentSource is required for UserTemplate');
    }

    let input: string;
    let updatedSession = validSession;

    input = await effectiveContentSource.getContent(validSession);

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
        effectiveContentSource,
      );
    }

    return updatedSession;
  }

  private async validateInput(
    session: ISession,
    input: string,
    contentSource: ContentSource<string>,
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

      const newInput = await contentSource.getContent(updatedSession);

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
> extends Template<TInput, TOutput, ModelContentOutput> {
  private options: {
    validator?: IValidator;
    maxAttempts?: number;
    raiseError?: boolean;
  };

  constructor(
    contentOrGenerateOptions?: string | GenerateOptions | ContentSource<ModelContentOutput>,
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

    // Set content source based on input type
    if (contentOrGenerateOptions instanceof ContentSource) {
      this.contentSource = contentOrGenerateOptions;
    } else if (typeof contentOrGenerateOptions === 'string') {
      // For backward compatibility, store the string content
      this.generateOptionsOrContent = contentOrGenerateOptions;
      // Create a static content source that returns a ModelContentOutput
      this.contentSource = {
        async getContent(session: ISession): Promise<ModelContentOutput> {
          const interpolatedContent = TemplateUtils.interpolateContent(
            contentOrGenerateOptions,
            session
          );
          return {
            content: interpolatedContent
          };
        }
      } as ContentSource<ModelContentOutput>;
    } else if (contentOrGenerateOptions && typeof contentOrGenerateOptions === 'object') {
      // For backward compatibility, store the generate options
      this.generateOptionsOrContent = contentOrGenerateOptions as GenerateOptions;
      // Create a model content source
      this.contentSource = new BasicModelContentSource(
        contentOrGenerateOptions as GenerateOptions,
        this.options.validator ? {
          validator: this.options.validator,
          maxAttempts: this.options.maxAttempts,
          raiseError: this.options.raiseError
        } : undefined
      );
    }
  }

  async execute(
    session?: ISession<TInput>,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession<TOutput>> {
    const { session: validSession, contentSource, generateOptions } =
      TemplateUtils.prepareExecutionOptions(
        this as unknown as Template<
          Record<string, unknown>,
          Record<string, unknown>
        >,
        session as ISession<Record<string, unknown>> | undefined,
        options,
      );

    // Use the content source or create one from generate options for backward compatibility
    let effectiveContentSource = contentSource as ContentSource<ModelContentOutput>;
    
    if (!effectiveContentSource && generateOptions) {
      if (typeof generateOptions === 'string') {
        // Create a static content source for string content
        effectiveContentSource = {
          async getContent(session: ISession): Promise<ModelContentOutput> {
            const interpolatedContent = TemplateUtils.interpolateContent(
              generateOptions,
              session
            );
            return {
              content: interpolatedContent
            };
          }
        } as ContentSource<ModelContentOutput>;
      } else {
        // Create a model content source for generate options
        effectiveContentSource = new BasicModelContentSource(
          generateOptions as GenerateOptions,
          this.options.validator ? {
            validator: this.options.validator,
            maxAttempts: this.options.maxAttempts,
            raiseError: this.options.raiseError
          } : undefined
        );
      }
    }

    if (!effectiveContentSource) {
      throw new Error('ContentSource is required for AssistantTemplate');
    }

    // Get content from the content source
    const modelOutput = await effectiveContentSource.getContent(validSession);
    
    // Process the model output
    let updatedSession = validSession;
    
    // Add the assistant message to the session
    updatedSession = updatedSession.addMessage({
      type: 'assistant',
      content: modelOutput.content,
      toolCalls: modelOutput.toolCalls,
      metadata: createMetadata(),
    });
    
    // Update session metadata if provided
    if (modelOutput.metadata) {
      updatedSession = updatedSession.updateMetadata(modelOutput.metadata as any);
    }
    
    // Add structured output to metadata if available
    if (modelOutput.structuredOutput) {
      updatedSession = updatedSession.updateMetadata({
        structured_output: modelOutput.structuredOutput,
      } as any);
    }
    
    // Handle tool calls if any
    if (modelOutput.toolCalls && Array.isArray(modelOutput.toolCalls) && modelOutput.toolCalls.length > 0) {
      // If we have the original GenerateOptions, use it for tool execution
      if (this.generateOptionsOrContent && typeof this.generateOptionsOrContent !== 'string') {
        updatedSession = await this.handleToolCalls(
          updatedSession,
          modelOutput.toolCalls,
          this.generateOptionsOrContent
        );
      } else if (generateOptions && typeof generateOptions !== 'string') {
        updatedSession = await this.handleToolCalls(
          updatedSession,
          modelOutput.toolCalls,
          generateOptions
        );
      }
    }
    
    return updatedSession as ISession<TOutput>;
  }

  // For backward compatibility
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

  // For backward compatibility
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
