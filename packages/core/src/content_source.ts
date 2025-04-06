import type { ISession } from './types';
import type { IValidator } from './validators/base';
import type { Metadata } from './metadata';
import { interpolateTemplate } from './utils/template_interpolation';
import * as readline from 'node:readline/promises';
import { generateText } from './generate';
import type { GenerateOptions } from './generate_options';
import { z } from 'zod';
import { createMetadata } from './metadata';

/**
 * Base interface for all content sources
 */
export abstract class ContentSource<T = unknown> {
  /**
   * Get content with session context
   * @param session Session context for content generation
   * @returns Promise resolving to content of type T
   */
  abstract getContent(session: ISession): Promise<T>;

  /**
   * Check if this content source has a validator
   * @returns True if a validator is available
   */
  hasValidator?(): boolean;

  /**
   * Get the validator associated with this content source
   * @returns The validator or undefined if no validator is set
   */
  getValidator?(): IValidator | undefined;
}

/**
 * For simple string content (like user inputs)
 */
export abstract class StringContentSource extends ContentSource<string> {
  // Returns plain string content
}

/**
 * Interface for AI model outputs with metadata and structured data
 */
export interface ModelContentOutput {
  content: string; // Plain text content
  toolCalls?: Array<{
    // Tool calls if any were made
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
  structuredOutput?: Record<string, unknown>; // Schema-based structured output
  metadata?: Record<string, unknown>; // Additional metadata to update in session
}

/**
 * For AI responses with rich outputs
 */
export abstract class ModelContentSource extends ContentSource<ModelContentOutput> {
  // Returns structured content with content, toolCalls, structuredOutput and metadata
}

/**
 * Static content source that returns the same content every time
 * Supports template interpolation with session metadata
 */
export class StaticContentSource extends StringContentSource {
  constructor(private content: string) {
    super();
  }

  async getContent(session: ISession): Promise<string> {
    // Support template interpolation
    return interpolateTemplate(this.content, session.metadata);
  }
}

/**
 * CLI input source that reads from command line
 */
export class CLIContentSource extends StringContentSource {
  private validator?: IValidator;
  private maxAttempts: number;
  private raiseError: boolean;

  constructor(
    private prompt: string,
    private defaultValue?: string,
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    super();
    // Setup validator logic
    if (
      validatorOrOptions &&
      typeof validatorOrOptions === 'object' &&
      !('validate' in validatorOrOptions)
    ) {
      this.validator = validatorOrOptions.validator;
      this.maxAttempts = validatorOrOptions.maxAttempts ?? 1;
      this.raiseError = validatorOrOptions.raiseError ?? true;
    } else {
      this.validator = validatorOrOptions as IValidator | undefined;
      this.maxAttempts = 1;
      this.raiseError = true;
    }
  }

  async getContent(session: ISession): Promise<string> {
    // CLI input logic with validation
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      let attempts = 0;
      let lastValidationError: string | undefined;

      while (attempts < this.maxAttempts) {
        attempts++;

        const input = await rl.question(this.prompt);
        const finalInput = input || this.defaultValue || '';

        if (!this.validator) {
          return finalInput;
        }

        const result = await this.validator.validate(finalInput, session);

        if (result.isValid) {
          return finalInput;
        }

        lastValidationError = result.instruction || 'Invalid input';
        console.log(
          `Input validation failed: ${lastValidationError}. Please try again.`,
        );

        if (attempts >= this.maxAttempts && this.raiseError) {
          throw new Error(
            `Input validation failed after ${attempts} attempts: ${lastValidationError}`,
          );
        }
      }

      return this.defaultValue || '';
    } finally {
      rl.close();
    }
  }

  hasValidator(): boolean {
    return !!this.validator;
  }

  getValidator(): IValidator | undefined {
    return this.validator;
  }
}

/**
 * Callback-based content source
 */
export class CallbackContentSource extends StringContentSource {
  private validator?: IValidator;
  private maxAttempts: number;
  private raiseError: boolean;

  constructor(
    private callback: (context: { metadata?: Metadata }) => Promise<string>,
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    super();
    // Setup validator logic
    if (
      validatorOrOptions &&
      typeof validatorOrOptions === 'object' &&
      !('validate' in validatorOrOptions)
    ) {
      this.validator = validatorOrOptions.validator;
      this.maxAttempts = validatorOrOptions.maxAttempts ?? 1;
      this.raiseError = validatorOrOptions.raiseError ?? true;
    } else {
      this.validator = validatorOrOptions as IValidator | undefined;
      this.maxAttempts = 1;
      this.raiseError = true;
    }
  }

  async getContent(session: ISession): Promise<string> {
    let attempts = 0;
    let lastValidationError: string | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;

      const input = await this.callback({ metadata: session.metadata });

      if (!this.validator) {
        return input;
      }

      const result = await this.validator.validate(input, session);

      if (result.isValid) {
        return input;
      }

      lastValidationError = result.instruction || 'Invalid input';

      if (attempts >= this.maxAttempts && this.raiseError) {
        throw new Error(
          `Input validation failed after ${attempts} attempts: ${lastValidationError}`,
        );
      }
    }

    return this.callback({ metadata: session.metadata });
  }

  hasValidator(): boolean {
    return !!this.validator;
  }

  getValidator(): IValidator | undefined {
    return this.validator;
  }
}

/**
 * Basic model content generation
 */
export class BasicModelContentSource extends ModelContentSource {
  private validator?: IValidator;
  private maxAttempts: number;
  private raiseError: boolean;

  constructor(
    private generateOptions: GenerateOptions,
    validatorOrOptions?:
      | IValidator
      | {
          validator?: IValidator;
          maxAttempts?: number;
          raiseError?: boolean;
        },
  ) {
    super();
    // Setup validator logic
    if (
      validatorOrOptions &&
      typeof validatorOrOptions === 'object' &&
      !('validate' in validatorOrOptions)
    ) {
      this.validator = validatorOrOptions.validator;
      this.maxAttempts = validatorOrOptions.maxAttempts ?? 1;
      this.raiseError = validatorOrOptions.raiseError ?? true;
    } else {
      this.validator = validatorOrOptions as IValidator | undefined;
      this.maxAttempts = 1;
      this.raiseError = true;
    }
  }

  async getContent(session: ISession): Promise<ModelContentOutput> {
    let attempts = 0;
    let lastValidationError: string | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;

      const response = await generateText(session, this.generateOptions);

      if (
        !this.validator ||
        response.type !== 'assistant' ||
        !response.content
      ) {
        return {
          content: response.content,
          toolCalls:
            response.type === 'assistant' ? response.toolCalls : undefined,
          metadata: response.metadata?.toObject(),
        };
      }

      const result = await this.validator.validate(response.content, session);

      if (result.isValid) {
        return {
          content: response.content,
          toolCalls:
            response.type === 'assistant' ? response.toolCalls : undefined,
          metadata: response.metadata?.toObject(),
        };
      }

      lastValidationError = result.instruction || 'Invalid content';

      if (attempts >= this.maxAttempts && this.raiseError) {
        throw new Error(
          `Content validation failed after ${attempts} attempts: ${lastValidationError}`,
        );
      }
    }

    const finalResponse = await generateText(session, this.generateOptions);

    return {
      content: finalResponse.content,
      toolCalls:
        finalResponse.type === 'assistant'
          ? finalResponse.toolCalls
          : undefined,
      metadata: finalResponse.metadata?.toObject(),
    };
  }

  hasValidator(): boolean {
    return !!this.validator;
  }

  getValidator(): IValidator | undefined {
    return this.validator;
  }
}

/**
 * Schema-based content generation
 */
export class SchemaModelContentSource<
  T extends Record<string, unknown>,
> extends ModelContentSource {
  constructor(
    private generateOptions: GenerateOptions,
    private schema: z.ZodType<T>,
    private options: {
      functionName?: string;
      maxAttempts?: number;
      raiseError?: boolean;
    } = {},
  ) {
    super();
  }

  async getContent(session: ISession): Promise<ModelContentOutput> {
    // Create a tool from the schema
    const schemaFunction = {
      name: this.options.functionName || 'generateStructuredOutput',
      description: 'Generate structured output according to schema',
      parameters: this.schema,
    };

    // Add the schema function as a tool
    const enhancedOptions = this.generateOptions
      .clone()
      .addTool(schemaFunction.name, schemaFunction)
      .setToolChoice('required'); // Force the model to use this tool

    // Generate response with retry logic
    let attempts = 0;
    let error: Error | null = null;

    while (attempts < (this.options.maxAttempts || 3)) {
      try {
        const response = await generateText(session, enhancedOptions);

        // Extract structured output from tool call
        if (
          response.type === 'assistant' &&
          response.toolCalls &&
          response.toolCalls.length > 0
        ) {
          const toolCall = response.toolCalls.find(
            (tc) => tc.name === schemaFunction.name,
          );

          if (toolCall) {
            // Validate against schema
            const result = this.schema.safeParse(toolCall.arguments);

            if (result.success) {
              // Return both text content and structured output
              return {
                content: response.content,
                toolCalls: response.toolCalls,
                structuredOutput: result.data,
                metadata: response.metadata?.toObject(),
              };
            } else if (this.options.raiseError !== false) {
              error = new Error(
                `Schema validation failed: ${result.error.message}`,
              );
            }
          }
        }

        attempts++;
      } catch (err) {
        error = err as Error;
        attempts++;
      }
    }

    if (error && this.options.raiseError !== false) {
      throw error;
    }

    // Return best effort if not raising errors
    const fallbackResponse = await generateText(session, this.generateOptions);
    return {
      content: fallbackResponse.content,
      toolCalls:
        fallbackResponse.type === 'assistant'
          ? fallbackResponse.toolCalls
          : undefined,
      metadata: fallbackResponse.metadata?.toObject(),
    };
  }
}
