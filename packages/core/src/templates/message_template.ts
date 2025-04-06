import { ContentSource, StaticContentSource } from '../content_source';
import type { ModelContentOutput } from '../content_source';
import { createMetadata } from '../metadata';
import { createSession } from '../session';
import type { ISession, TMessage, IToolResultMetadata } from '../types';
import { Template } from './basic';
import { GenerateOptions } from '../generate_options';
import { BasicModelContentSource } from '../content_source';
import type { InputSource } from '../input_source';
import type { IValidator } from '../validators/base';
import { CustomValidator } from '../validators';
import { interpolateTemplate } from '../utils/template_interpolation';

/**
 * Extended Template class that includes ContentSource
 */
export abstract class ContentSourceTemplate<
  TOutput = unknown,
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TResultOutput extends Record<string, unknown> = TInput,
> extends Template<TInput, TResultOutput, TOutput> {
  // Override the contentSource property with the correct type
  // No need to redeclare it since it's already in the base class

  // Override getContentSource to return the correct type
  override getContentSource(): ContentSource<TOutput> | undefined {
    return this.contentSource as ContentSource<TOutput> | undefined;
  }
}

/**
 * Message template for handling any message type
 */
export class MessageTemplate<
  TOutput = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends ContentSourceTemplate<TOutput, TMetadata, TMetadata> {
  constructor(
    private messageType: TMessage['type'],
    contentSource: ContentSource<TOutput>,
  ) {
    super();
    this.contentSource = contentSource;
  }

  async execute(session?: ISession<TMetadata>): Promise<ISession<TMetadata>> {
    const validSession = session ? session : createSession<TMetadata>();

    if (!this.contentSource) {
      throw new Error('ContentSource is required for MessageTemplate');
    }

    // Use type assertion to handle type compatibility
    const content = await this.contentSource.getContent(
      validSession as unknown as ISession,
    );

    // Type-specific handling based on the content type
    if (typeof content === 'string') {
      if (this.messageType === 'tool_result') {
        const metadata = createMetadata<IToolResultMetadata>();
        metadata.set('toolCallId', 'default-tool-call-id');

        return validSession.addMessage({
          type: this.messageType,
          content,
          metadata,
          result: content,
        });
      } else {
        return validSession.addMessage({
          type: this.messageType,
          content,
          metadata: createMetadata(),
        });
      }
    } else if (this.isModelContentOutput(content)) {
      // Handle ModelContentOutput
      if (this.messageType === 'assistant') {
        let updatedSession = validSession.addMessage({
          type: this.messageType,
          content: content.content,
          toolCalls: content.toolCalls,
          metadata: createMetadata(),
        });

        // Update session metadata if provided
        if (content.metadata) {
          updatedSession = updatedSession.updateMetadata(
            content.metadata as any,
          );
        }

        // Add structured output to metadata if available
        if (content.structuredOutput) {
          updatedSession = updatedSession.updateMetadata({
            structured_output: content.structuredOutput,
          } as any);
        }

        return updatedSession;
      } else if (this.messageType === 'tool_result') {
        const metadata = createMetadata<IToolResultMetadata>();
        metadata.set('toolCallId', 'default-tool-call-id');

        return validSession.addMessage({
          type: this.messageType,
          content: content.content,
          metadata,
          result: content.content,
        });
      } else {
        return validSession.addMessage({
          type: this.messageType,
          content: content.content,
          metadata: createMetadata(),
        });
      }
    } else {
      // Handle other types of content
      throw new Error(`Unsupported content type: ${typeof content}`);
    }
  }

  // Type guard to check if content is ModelContentOutput
  private isModelContentOutput(content: any): content is ModelContentOutput {
    return (
      content &&
      typeof content === 'object' &&
      typeof content.content === 'string'
    );
  }
}

/**
 * System template for system messages
 */
export class ContentSourceSystemTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends MessageTemplate<string, TMetadata> {
  constructor(contentSource: ContentSource<string> | string) {
    // Convert string to StaticContentSource if needed
    const source =
      typeof contentSource === 'string'
        ? new StaticContentSource(contentSource)
        : contentSource;

    super('system', source);
  }
}

/**
 * User template for user messages
 */
export class ContentSourceUserTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends MessageTemplate<string, TMetadata> {
  private options: {
    description?: string;
    validate?: (input: string) => Promise<boolean>;
    onInput?: (input: string) => void;
    default?: string;
    validator?: IValidator;
  };

  constructor(
    contentOrSource:
      | string
      | ContentSource<string>
      | InputSource
      | {
          contentSource?: ContentSource<string>;
          inputSource?: InputSource;
          description?: string;
          validate?: (input: string) => Promise<boolean>;
          onInput?: (input: string) => void;
          default?: string;
          validator?: IValidator;
        },
  ) {
    // Initialize options
    const options: {
      description?: string;
      validate?: (input: string) => Promise<boolean>;
      onInput?: (input: string) => void;
      default?: string;
      validator?: IValidator;
    } = {};

    let source: ContentSource<string>;

    // Process the input options
    if (typeof contentOrSource === 'string') {
      source = new StaticContentSource(contentOrSource);
    } else if (contentOrSource instanceof ContentSource) {
      source = contentOrSource;
    } else if (
      contentOrSource !== undefined &&
      typeof contentOrSource === 'object' &&
      'getInput' in contentOrSource
    ) {
      // For backward compatibility with InputSource
      const inputSource = contentOrSource as InputSource;
      source = {
        async getContent(session: ISession): Promise<string> {
          return inputSource.getInput({
            metadata: session.metadata,
          });
        },
        hasValidator(): boolean {
          return !!inputSource.getValidator();
        },
        getValidator(): IValidator | undefined {
          return inputSource.getValidator();
        },
      } as ContentSource<string>;
    } else if (typeof contentOrSource === 'object') {
      // Handle object configuration
      if (contentOrSource.contentSource) {
        source = contentOrSource.contentSource;
      } else if (contentOrSource.inputSource) {
        // For backward compatibility with InputSource
        const inputSource = contentOrSource.inputSource;
        source = {
          async getContent(session: ISession): Promise<string> {
            return inputSource.getInput({
              metadata: session.metadata,
            });
          },
          hasValidator(): boolean {
            return !!inputSource.getValidator();
          },
          getValidator(): IValidator | undefined {
            return inputSource.getValidator();
          },
        } as ContentSource<string>;
      } else {
        // Default to empty static content
        source = new StaticContentSource('');
      }
      
      // Copy options
      options.description = contentOrSource.description;
      options.validate = contentOrSource.validate;
      options.onInput = contentOrSource.onInput;
      options.default = contentOrSource.default;
      options.validator = contentOrSource.validator;
    } else {
      // Default to empty static content
      source = new StaticContentSource('');
    }

    super('user', source);
    this.options = options;
  }

  async execute(session?: ISession<TMetadata>): Promise<ISession<TMetadata>> {
    const validSession = session ? session : createSession<TMetadata>();

    if (!this.contentSource) {
      throw new Error('ContentSource is required for UserTemplate');
    }

    // Get content from the content source
    let input = await this.contentSource.getContent(
      validSession as unknown as ISession<Record<string, unknown>>
    );

    // Handle onInput callback if provided
    if (this.options?.onInput) {
      this.options.onInput(input);
    }

    // Handle validation
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

    // Add the user message to the session
    let updatedSession = validSession.addMessage({
      type: 'user',
      content: input,
      metadata: createMetadata(),
    });

    // Handle validation if needed
    if (this.options?.validator) {
      updatedSession = await this.validateInput(
        updatedSession,
        input
      );
    }

    return updatedSession;
  }

  private async validateInput(
    session: ISession<TMetadata>,
    input: string,
  ): Promise<ISession<TMetadata>> {
    if (!this.options?.validator || !this.contentSource) {
      return session;
    }

    let updatedSession = session;
    let attempts = 0;
    let result = await this.options.validator.validate(
      input, 
      updatedSession as unknown as ISession<Record<string, unknown>>
    );

    while (!result.isValid) {
      attempts++;

      updatedSession = updatedSession.addMessage({
        type: 'system',
        content: `Validation failed: ${result.instruction || ''}. Please try again.`,
        metadata: createMetadata(),
      });

      const newInput = await this.contentSource.getContent(
        updatedSession as unknown as ISession<Record<string, unknown>>
      );

      if (this.options.onInput) {
        this.options.onInput(newInput);
      }

      updatedSession = updatedSession.addMessage({
        type: 'user',
        content: newInput,
        metadata: createMetadata(),
      });

      result = await this.options.validator.validate(
        newInput, 
        updatedSession as unknown as ISession<Record<string, unknown>>
      );

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
 * Assistant template for assistant messages
 */
export class ContentSourceAssistantTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TMetadata & {
    structured_output?: Record<string, unknown>;
  },
> extends ContentSourceTemplate<ModelContentOutput, TMetadata, TOutput> {
  private validator?: IValidator;
  private maxAttempts: number;
  private raiseError: boolean;
  private staticContent?: string;
  private generateOptions?: GenerateOptions;

  constructor(
    contentOrGenerateOptions: ContentSource<ModelContentOutput> | GenerateOptions | string,
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    super();

    // Process validator options
    if (validatorOrOptions) {
      if ('validate' in validatorOrOptions) {
        this.validator = validatorOrOptions as IValidator;
        this.maxAttempts = 1;
        this.raiseError = true;
      } else {
        const options = validatorOrOptions as {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        };
        this.validator = options.validator;
        this.maxAttempts = options.maxAttempts ?? 1;
        this.raiseError = options.raiseError ?? true;
      }
    } else {
      this.maxAttempts = 1;
      this.raiseError = true;
    }

    // Convert input to ContentSource
    if (contentOrGenerateOptions instanceof ContentSource) {
      this.contentSource = contentOrGenerateOptions;
    } else if (typeof contentOrGenerateOptions === 'string') {
      this.staticContent = contentOrGenerateOptions;
      // Create a static content source that returns a ModelContentOutput
      this.contentSource = {
        async getContent(session: ISession): Promise<ModelContentOutput> {
          const interpolatedContent = interpolateTemplate(
            contentOrGenerateOptions,
            session.metadata
          );
          return {
            content: interpolatedContent
          };
        }
      } as ContentSource<ModelContentOutput>;
    } else {
      this.generateOptions = contentOrGenerateOptions;
      // We don't create a BasicModelContentSource here because we need to use the mocked generateText
      // in the execute method
    }
  }

  async execute(session?: ISession<TMetadata>): Promise<ISession<TOutput>> {
    const validSession = session ? session : createSession<TMetadata>();

    // For static content
    if (this.staticContent) {
      // Interpolate the static content
      const interpolatedContent = interpolateTemplate(
        this.staticContent,
        validSession.metadata
      );
      
      // Validate if validator is provided
      if (this.validator) {
        const result = await this.validator.validate(
          interpolatedContent,
          validSession as unknown as ISession<Record<string, unknown>>
        );

        if (!result.isValid && this.raiseError) {
          throw new Error('Assistant content validation failed: ' + (result.instruction || ''));
        }
      }

      // Add the assistant message to the session
      const updatedSession = validSession.addMessage({
        type: 'assistant',
        content: interpolatedContent,
        metadata: createMetadata(),
      });

      return updatedSession as unknown as ISession<TOutput>;
    }

    // For generate options
    if (this.generateOptions) {
      // Import generateText dynamically to avoid circular dependencies
      const { generateText } = await import('../generate');

      // If validator is provided, handle validation
      if (this.validator) {
        let attempts = 0;
        let lastValidationError: string | undefined;

        while (attempts < this.maxAttempts) {
          attempts++;

          // Generate content using the model
          const response = await generateText(
            validSession as unknown as ISession<Record<string, unknown>>,
            this.generateOptions
          );

          // Validate the content
          const result = await this.validator.validate(
            response.content,
            validSession as unknown as ISession<Record<string, unknown>>
          );

          if (result.isValid) {
            // Add the assistant message to the session
            const updatedSession = validSession.addMessage({
              type: 'assistant',
              content: response.content,
              toolCalls: response.type === 'assistant' ? response.toolCalls : undefined,
              metadata: createMetadata(),
            });
            
            return updatedSession as unknown as ISession<TOutput>;
          }

          lastValidationError = result.instruction || 'Invalid content';

          if (attempts >= this.maxAttempts && this.raiseError) {
            throw new Error(
              `Assistant response validation failed${this.maxAttempts > 1 ? ` after ${attempts} attempts` : ''}: ${lastValidationError}`
            );
          }
        }

        // If we get here, validation failed but raiseError is false
        // Generate one final response
        const finalResponse = await generateText(
          validSession as unknown as ISession<Record<string, unknown>>,
          this.generateOptions
        );

        // Add the assistant message to the session
        const updatedSession = validSession.addMessage({
          type: 'assistant',
          content: finalResponse.content,
          toolCalls: finalResponse.type === 'assistant' ? finalResponse.toolCalls : undefined,
          metadata: createMetadata(),
        });
        
        return updatedSession as unknown as ISession<TOutput>;
      } else {
        // No validator, just generate content and return
        const response = await generateText(
          validSession as unknown as ISession<Record<string, unknown>>,
          this.generateOptions
        );

        // Add the assistant message to the session
        const updatedSession = validSession.addMessage({
          type: 'assistant',
          content: response.content,
          toolCalls: response.type === 'assistant' ? response.toolCalls : undefined,
          metadata: createMetadata(),
        });
        
        return updatedSession as unknown as ISession<TOutput>;
      }
    }

    // If we have a contentSource (not static content or generateOptions)
    if (this.contentSource) {
      // Get content from the content source
      const modelOutput = await this.contentSource.getContent(
        validSession as unknown as ISession<Record<string, unknown>>
      );

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
      
      return updatedSession as unknown as ISession<TOutput>;
    }

    throw new Error('No content source, static content, or generate options provided');
  }
}

// Keep the original classes for backward compatibility
/**
 * System template for system messages
 */
export class SystemTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends ContentSourceSystemTemplate<TMetadata> {
  constructor(contentSource: ContentSource<string> | string) {
    super(contentSource);
  }
}

/**
 * User template for user messages
 */
export class UserTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends ContentSourceUserTemplate<TMetadata> {
  constructor(contentSource: ContentSource<string> | string) {
    super(contentSource);
  }
}

/**
 * Assistant template for assistant messages
 */
export class AssistantTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TMetadata & {
    structured_output?: Record<string, unknown>;
  },
> extends ContentSourceAssistantTemplate<TMetadata, TOutput> {
  constructor(
    contentSource: ContentSource<ModelContentOutput> | GenerateOptions | string,
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    super(contentSource, validatorOrOptions);
  }
}

/**
 * Tool result template for tool result messages
 */
export class ToolResultTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends Template<TMetadata, TMetadata> {
  constructor(
    private options: {
      toolCallId: string;
      content: string;
    },
  ) {
    super();
  }

  async execute(session?: ISession<TMetadata>): Promise<ISession<TMetadata>> {
    const validSession = session ? session : createSession<TMetadata>();

    const metadata = createMetadata<IToolResultMetadata>();
    metadata.set('toolCallId', this.options.toolCallId);

    return validSession.addMessage({
      type: 'tool_result',
      content: this.options.content,
      metadata,
      result: this.options.content, // Add the result property
    }) as ISession<TMetadata>;
  }
}
