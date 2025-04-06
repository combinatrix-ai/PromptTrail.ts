// templates.ts (Executorクラスなしの実装)
import { createMetadata } from '../metadata';
import { interpolateTemplate } from '../utils/template_interpolation';
import type { SessionTransformer } from '../utils/session_transformer';
import type { ISession } from '../types';
import { type IValidator } from '../validators';
import { CustomValidator } from '../validators';
import { createSession } from '../session';
import {
  ContentSource,
  StaticContentSource,
  type ModelContentOutput,
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
  ): {
    session: ISession;
    contentSource?: ContentSource<unknown>;
  } {
    session = TemplateUtils.ensureSession(session);

    // Get the content source from the template
    const contentSource = template.getContentSource();

    return { session, contentSource };
  }

  /**
   * Interpolate content with session metadata
   */
  static interpolateContent(content: string, session: ISession): string {
    return interpolateTemplate(content, session.metadata || createMetadata());
  }

  /**
   * Convert string to ContentSource
   */
  static convertToContentSource(
    input: string | ContentSource<unknown> | undefined,
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

    return undefined;
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

  abstract execute(session?: ISession<TInput>): Promise<ISession<TOutput>>;

  getContentSource(): ContentSource<TContentType> | undefined {
    return this.contentSource;
  }

  /**
   * Indicates whether the template instance was constructed with its own ContentSource.
   * Container templates use this to decide whether to propagate their ContentSource.
   */
  hasOwnContentSource(): boolean {
    return !!this.contentSource;
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

  async execute(session?: ISession): Promise<ISession> {
    const { session: validSession, contentSource } =
      TemplateUtils.prepareExecutionOptions(this, session);

    if (!contentSource) {
      throw new Error('ContentSource is required for SystemTemplate');
    }

    const content = await contentSource.getContent(validSession);
    if (typeof content !== 'string') {
      throw new Error('Expected string content from ContentSource');
    }

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
      | ContentSource<string>
      | {
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
    } else if (typeof inputOrConfig === 'object') {
      // Handle object configuration
      if (inputOrConfig.contentSource) {
        this.contentSource = inputOrConfig.contentSource;
      } else {
        // Default to empty static content
        this.contentSource = new StaticContentSource('');
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

  async execute(session?: ISession): Promise<ISession> {
    const { session: validSession, contentSource } =
      TemplateUtils.prepareExecutionOptions(this, session);

    if (!contentSource) {
      throw new Error('ContentSource is required for UserTemplate');
    }

    const typedContentSource = contentSource as ContentSource<string>;

    let input: string;
    let updatedSession = validSession;

    input = await typedContentSource.getContent(validSession);

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
        typedContentSource,
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

import { GenerateOptions } from '../generate_options';
import { BasicModelContentSource } from '../content_source';

/**
 * Class for templating assistant messages
 */
export class AssistantTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> extends Template<TInput, TOutput, ModelContentOutput> {
  constructor(
    contentSource?:
      | ContentSource<ModelContentOutput>
      | string
      | GenerateOptions,
  ) {
    super();

    // Set content source based on input type
    if (contentSource === undefined) {
      // No content source provided, will use parent's content source
    } else if (contentSource instanceof ContentSource) {
      this.contentSource = contentSource;
    } else if (contentSource instanceof GenerateOptions) {
      // Convert GenerateOptions to BasicModelContentSource
      this.contentSource = new BasicModelContentSource(contentSource);
    } else if (typeof contentSource === 'string') {
      // Create a static content source that returns a ModelContentOutput
      this.contentSource = {
        async getContent(session: ISession): Promise<ModelContentOutput> {
          const interpolatedContent = TemplateUtils.interpolateContent(
            contentSource,
            session,
          );
          return {
            content: interpolatedContent,
          };
        },
      } as ContentSource<ModelContentOutput>;
    }
  }

  async execute(session?: ISession<TInput>): Promise<ISession<TOutput>> {
    const { session: validSession, contentSource } =
      TemplateUtils.prepareExecutionOptions(
        this as unknown as Template<
          Record<string, unknown>,
          Record<string, unknown>
        >,
        session as ISession<Record<string, unknown>> | undefined,
      );

    if (!contentSource) {
      throw new Error('ContentSource is required for AssistantTemplate');
    }

    // Get content from the content source
    const modelOutput = await contentSource.getContent(validSession);

    if (
      !modelOutput ||
      typeof modelOutput !== 'object' ||
      typeof (modelOutput as any).content !== 'string'
    ) {
      throw new Error('Expected ModelContentOutput from ContentSource');
    }

    const typedOutput = modelOutput as ModelContentOutput;

    // Process the model output
    let updatedSession = validSession;

    // Add the assistant message to the session
    updatedSession = updatedSession.addMessage({
      type: 'assistant',
      content: typedOutput.content,
      toolCalls: typedOutput.toolCalls,
      metadata: createMetadata(),
    });

    // Update session metadata if provided
    if (typedOutput.metadata) {
      updatedSession = updatedSession.updateMetadata(
        typedOutput.metadata as any,
      );
    }

    // Add structured output to metadata if available
    if (typedOutput.structuredOutput) {
      updatedSession = updatedSession.updateMetadata({
        structured_output: typedOutput.structuredOutput,
      } as any);
    }

    return updatedSession as ISession<TOutput>;
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

  async execute(session?: ISession<TInput>): Promise<ISession<TOutput>> {
    const { session: validSession } = TemplateUtils.prepareExecutionOptions(
      this as unknown as Template<
        Record<string, unknown>,
        Record<string, unknown>
      >,
      session as ISession<Record<string, unknown>> | undefined,
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

  async execute(session?: ISession): Promise<ISession> {
    const { session: validSession } = TemplateUtils.prepareExecutionOptions(
      this,
      session,
    );

    if (this.condition(validSession)) {
      return this.thenTemplate.execute(validSession);
    } else if (this.elseTemplate) {
      return this.elseTemplate.execute(validSession);
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
    );

    return this.transformer.transform(validSession);
  }
}
