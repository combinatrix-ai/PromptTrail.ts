import type { ISession } from './types';
import type {
  IValidator,
  TValidationResult as ValidationResult,
} from './validators/base'; // TODO: Rename IValidator to Validator, Use TValidationResult
import type { Metadata } from './metadata';
import { interpolateTemplate } from './utils/template_interpolation';
import * as readline from 'node:readline/promises';
import { generateText } from './generate';
import type { GenerateOptions } from './generate_options';
import { z } from 'zod';

// --- Temporary Definitions (Move to appropriate files later) ---

/**
 * Interface for AI model outputs with metadata and structured data
 * (Equivalent to ModelContentOutput in the original file)
 */
export interface ModelOutput {
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
  structuredOutput?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Options for validation behavior
 */
export interface ValidationOptions {
  validator?: IValidator; // TODO: Rename IValidator to Validator
  maxAttempts?: number;
  raiseError?: boolean;
}

/**
 * Custom error for validation failures
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public result?: ValidationResult,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

// --- Refactored Content Sources ---

/**
 * Base class for all content sources (Renamed from ContentSource)
 */
export abstract class Source<T = unknown> {
  protected validator?: IValidator; // TODO: Rename IValidator to Validator
  protected maxAttempts: number;
  protected raiseError: boolean;

  constructor(options?: ValidationOptions) {
    this.validator = options?.validator;
    this.maxAttempts = options?.maxAttempts ?? 1;
    this.raiseError = options?.raiseError ?? true;
  }

  /**
   * Get content with session context
   * @param session Session context for content generation
   * @returns Promise resolving to content of type T
   */
  abstract getContent(session: ISession): Promise<T>; // TODO: Rename ISession to Session

  /**
   * Validates the given content once using the assigned validator.
   * Does NOT handle retries internally. Retries should be handled by the calling method (e.g., getContent).
   */
  protected async validateContent(
    content: string,
    session: ISession, // TODO: Rename ISession to Session
  ): Promise<ValidationResult> {
    if (!this.validator) {
      return { isValid: true }; // No validator means content is considered valid
    }
    // Perform a single validation attempt
    return this.validator.validate(content, session);
  }

  /**
   * Check if this content source has a validator
   * @returns True if a validator is available
   */
  hasValidator(): boolean {
    return !!this.validator;
  }

  /**
   * Get the validator associated with this content source
   * @returns The validator or undefined if no validator is set
   */
  getValidator(): IValidator | undefined {
    // TODO: Rename IValidator to Validator
    return this.validator;
  }
}

/**
 * Base class for sources returning simple string content (Renamed from StringContentSource)
 */
export abstract class TextSource extends Source<string> {
  // Returns plain string content
}

/**
 * Base class for sources returning AI model outputs (Renamed from ModelContentSource)
 */
export abstract class ModelSource extends Source<ModelOutput> {
  // Returns structured content with content, toolCalls, structuredOutput and metadata
}

/**
 * Static content source that returns the same content every time
 * Supports template interpolation with session metadata (Renamed from StaticContentSource)
 */
export class StaticSource extends TextSource {
  constructor(
    private content: string,
    options?: ValidationOptions, // Added options
  ) {
    super(options); // Pass options to base class
  }

  async getContent(session: ISession): Promise<string> {
    // TODO: Rename ISession to Session
    const interpolatedContent = interpolateTemplate(
      this.content,
      session.metadata,
    );
    // Use shared validation logic (single attempt)
    const validationResult = await this.validateContent(
      interpolatedContent,
      session,
    );
    if (!validationResult.isValid && this.raiseError) {
      const errorMessage = `Validation failed: ${validationResult.instruction || ''}`;
      throw new ValidationError(errorMessage, validationResult);
    }
    // If valid or raiseError is false, return content
    return interpolatedContent;
  }
}

/**
 * Static content source that returns the content based on predefined list
 */
export class StaticListSource extends TextSource {
  constructor(
    private contentList: string[],
    private index: number = 0,
    options?: ValidationOptions, // Added options
  ) {
    super(options); // Pass options to base class
  }

  async getContent(session: ISession): Promise<string> {
    if (this.index < this.contentList.length) {
      return this.contentList[this.index++];
    } else {
      throw new Error('No more content in the StaticListSource');
    }
  }

  async getIndex(): Promise<number> {
    return this.index;
  }

  async atEnd(): Promise<boolean> {
    return this.index >= this.contentList.length;
  }
}

/**
 * CLI input source that reads from command line (Adapted to new structure)
 */
export class CLISource extends TextSource {
  // Inherits from TextSource
  constructor(
    private prompt: string,
    private defaultValue?: string,
    options?: ValidationOptions, // Use ValidationOptions
  ) {
    super(options); // Pass options to base class
  }

  async getContent(session: ISession): Promise<string> {
    // TODO: Rename ISession to Session
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      let attempts = 0;
      let lastResult: ValidationResult | undefined;
      let currentInput = '';

      while (attempts < this.maxAttempts) {
        attempts++;
        const rawInput = await rl.question(this.prompt);
        currentInput = rawInput || this.defaultValue || '';

        lastResult = await this.validateContent(currentInput, session); // Single validation attempt

        if (lastResult.isValid) {
          return currentInput;
        }

        const isLastAttempt = attempts >= this.maxAttempts;

        if (isLastAttempt) {
          if (this.raiseError) {
            const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
            throw new ValidationError(errorMessage, lastResult);
          } else {
            console.warn(
              `CLISource: Validation failed after ${attempts} attempts. Returning last input or default value.`,
            );
            return currentInput; // Return the last invalid input
          }
        } else {
          console.log(
            `Validation attempt ${attempts} failed: ${
              lastResult?.instruction || 'Invalid input'
            }. Please try again.`,
          );
        }
      }
      // Fallback (should not be reached with maxAttempts >= 1)
      return this.defaultValue || '';
    } finally {
      rl.close();
    }
  }
}

/**
 * Callback-based content source (Adapted to new structure)
 */
export class CallbackSource extends TextSource {
  // Inherits from TextSource
  constructor(
    private callback: (context: { metadata?: Metadata }) => Promise<string>,
    options?: ValidationOptions, // Use ValidationOptions
  ) {
    super(options); // Pass options to base class
  }

  async getContent(session: ISession): Promise<string> {
    // TODO: Rename ISession to Session
    let attempts = 0;
    let lastResult: ValidationResult | undefined;
    let currentInput = '';

    while (attempts < this.maxAttempts) {
      attempts++;
      currentInput = await this.callback({ metadata: session.metadata });
      lastResult = await this.validateContent(currentInput, session); // Validate the newly fetched content (single attempt)

      if (lastResult.isValid) {
        return currentInput; // Return the valid input
      }

      // If validation failed
      const isLastAttempt = attempts >= this.maxAttempts;

      if (isLastAttempt) {
        if (this.raiseError) {
          const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
          throw new ValidationError(errorMessage, lastResult);
        } else {
          console.warn(
            `CallbackSource: Validation failed after ${attempts} attempts. Returning last (invalid) input.`,
          );
          return currentInput; // Return the last invalid input if not raising error
        }
      } else {
        // Log retry message if not the last attempt
        console.log(
          `Validation attempt ${attempts} failed: ${
            lastResult?.instruction || 'Invalid input'
          }. Retrying...`,
        );
        // Optionally add delay here
      }
    }

    // Fallback in case loop finishes unexpectedly (e.g., maxAttempts <= 0)
    // This part should ideally not be reached with maxAttempts >= 1
    if (!this.raiseError) {
      return currentInput; // Return the last input fetched
    } else {
      // If raiseError was true, an error should have been thrown already.
      throw new Error(
        `Callback input validation failed unexpectedly after ${this.maxAttempts} attempts.`,
      );
    }
  }
}

/**
 * Basic model content generation (Renamed from BasicModelContentSource to LlmSource)
 */
export class LlmSource extends ModelSource {
  // Inherits from ModelSource
  constructor(
    private generateOptions: GenerateOptions,
    options?: ValidationOptions, // Use ValidationOptions
  ) {
    super(options); // Pass options to base class
  }

  async getContent(session: ISession): Promise<ModelOutput> {
    // TODO: Rename ISession to Session
    let attempts = 0;
    let lastResult: ValidationResult | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;
      const response = await generateText(session, this.generateOptions);
      const responseContent = response.content ?? ''; // Handle null/undefined content

      if (response.type !== 'assistant') {
        console.warn(
          `LLM generation did not return assistant response. Attempt ${attempts}.`,
        );
        // Decide how to handle non-assistant responses (retry? throw? return empty?)
        // For now, let's retry if not last attempt, otherwise handle based on raiseError
        if (attempts >= this.maxAttempts) {
          if (this.raiseError) {
            throw new Error(
              `LLM generation failed after ${attempts} attempts: Did not return assistant response.`,
            );
          } else {
            return { content: '' }; // Return empty on failure if not raising error
          }
        }
        continue; // Retry generation
      }

      // Validate the string content using shared logic (single attempt)
      lastResult = await this.validateContent(responseContent, session);

      if (lastResult.isValid) {
        return {
          content: responseContent,
          toolCalls: response.toolCalls,
          metadata: response.metadata?.toObject(),
        };
      }

      // If validation failed
      const isLastAttempt = attempts >= this.maxAttempts;

      if (isLastAttempt) {
        if (this.raiseError) {
          const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
          throw new ValidationError(errorMessage, lastResult);
        } else {
          console.warn(
            `LlmSource: Validation failed after ${attempts} attempts. Returning last generated content.`,
          );
          // Return the last (invalid) response if not raising error
          return {
            content: responseContent,
            toolCalls: response.toolCalls,
            metadata: response.metadata?.toObject(),
          };
        }
      } else {
        console.log(
          `Validation attempt ${attempts} failed: ${
            lastResult?.instruction || 'Invalid input'
          }. Retrying generation...`,
        );
        // Optionally add feedback to the session for the next attempt
        // session = session.addMessage({ type: 'system', content: `Validation failed: ${lastResult.instruction}. Please revise.` });
      }
    }

    // Fallback (should not be reached with maxAttempts >= 1 and proper error handling)
    throw new Error(
      `LLM content generation failed unexpectedly after ${this.maxAttempts} attempts.`,
    );
  }
}

/**
 * Schema-based content generation (Adapted to new structure)
 */
export class SchemaSource<
  T extends Record<string, unknown>,
> extends ModelSource {
  // Inherits from ModelSource
  // private schemaValidator: IValidator; // Removed unused property

  constructor(
    private generateOptions: GenerateOptions,
    private schema: z.ZodType<T>,
    private options: {
      functionName?: string;
      maxAttempts?: number; // Use base class maxAttempts
      raiseError?: boolean; // Use base class raiseError
      // Allow passing an additional validator for the text part
      validator?: IValidator;
    } = {},
  ) {
    // Pass validator options to the base class for text content validation
    super({
      validator: options.validator,
      maxAttempts: options.maxAttempts,
      raiseError: options.raiseError,
    });

    // Create an internal validator for the schema itself
    // This requires a SchemaValidator implementation (assuming it exists in validators/schema)
    // import { SchemaValidator } from './validators/schema'; // Assuming this path
    // this.schemaValidator = new SchemaValidator(schema); // Need to adapt based on actual SchemaValidator constructor
    // For now, we'll handle schema validation within getContent as before,
    // but ideally, it should use a dedicated validator.
  }

  async getContent(session: ISession): Promise<ModelOutput> {
    // TODO: Rename ISession to Session
    const schemaFunction = {
      name: this.options.functionName || 'generateStructuredOutput',
      description: 'Generate structured output according to schema',
      parameters: this.schema,
    };

    const enhancedOptions = this.generateOptions
      .clone()
      .addTool(schemaFunction.name, schemaFunction)
      .setToolChoice('required');

    let attempts = 0;
    let lastError: Error | null = null;
    let lastResponse: Awaited<ReturnType<typeof generateText>> | undefined;

    // Use maxAttempts from base class
    while (attempts < this.maxAttempts) {
      attempts++;
      try {
        lastResponse = await generateText(session, enhancedOptions);
        const responseContent = lastResponse.content ?? ''; // Handle null/undefined content

        // 1. Validate text content if a validator was provided (single attempt)
        if (this.validator) {
          const textValidationResult = await this.validateContent(
            responseContent,
            session,
          );
          if (!textValidationResult.isValid) {
            lastError = new ValidationError(
              'Text content validation failed',
              textValidationResult,
            );
            console.warn(
              `SchemaSource: Text content validation failed (attempt ${attempts}).`,
            );
            if (this.raiseError) throw lastError;
            // If not raising error, continue to schema validation, but store the error
          } else {
            lastError = null; // Reset error if text validation passes
          }
        }

        // If text validation failed and we are not raising errors, we might still want to check schema
        // or we might want to retry immediately. Let's retry immediately if text validation fails.
        if (lastError && !this.raiseError) {
          if (attempts >= this.maxAttempts) break; // Don't retry if last attempt
          console.log(`Retrying generation due to text validation failure...`);
          continue;
        }

        // 2. Validate structured output (schema validation)
        if (
          lastResponse.type === 'assistant' &&
          lastResponse.toolCalls?.some((tc) => tc.name === schemaFunction.name)
        ) {
          const toolCall = lastResponse.toolCalls.find(
            (tc) => tc.name === schemaFunction.name,
          );

          if (toolCall) {
            const result = this.schema.safeParse(toolCall.arguments);
            if (result.success) {
              // Both text (if validator provided and passed) and schema are valid
              return {
                content: responseContent,
                toolCalls: lastResponse.toolCalls,
                structuredOutput: result.data,
                metadata: lastResponse.metadata?.toObject(),
              };
            } else {
              lastError = new Error(
                `Schema validation failed: ${result.error.message}`,
              );
              console.warn(
                `SchemaSource: Schema validation failed (attempt ${attempts}): ${lastError.message}`,
              );
            }
          } else {
            lastError = new Error(
              `SchemaSource: Expected tool call '${schemaFunction.name}' not found.`,
            );
            console.warn(
              `SchemaSource: Tool call not found (attempt ${attempts}).`,
            );
          }
        } else {
          lastError = new Error(
            `SchemaSource: No valid assistant response with tool call found.`,
          );
          console.warn(
            `SchemaSource: No valid assistant response (attempt ${attempts}).`,
          );
        }

        // If we reach here, either schema validation failed or no tool call found (or text validation failed earlier and raiseError=true)
        if (this.raiseError && lastError) {
          throw lastError; // Throw immediately if raiseError is true
        }

        if (attempts >= this.maxAttempts) break; // Exit loop if max attempts reached

        // If raiseError is false, log the specific error and continue to retry
        if (lastError) {
          console.log(`Retrying generation due to: ${lastError.message}`);
        }
      } catch (err) {
        // Catch errors from generateText or validateContent (if raiseError=true)
        lastError = err as Error;
        console.error(
          `SchemaSource: Error during generation/validation (attempt ${attempts}):`,
          lastError,
        );
        if (this.raiseError) throw lastError; // Re-throw immediately if raiseError is true
        if (attempts >= this.maxAttempts) break; // Exit loop if max attempts reached
      }
    }

    // Loop finished (max attempts reached or error occurred with raiseError=false)
    if (this.raiseError && lastError) {
      // Should have been thrown inside loop, but as a fallback
      throw new Error(
        `Schema generation failed after ${this.maxAttempts} attempts. Last error: ${lastError.message}`,
      );
    } else if (!this.raiseError) {
      console.warn(
        `SchemaSource: Max attempts reached or non-fatal error occurred. Returning last response or fallback.`,
      );
      // Return last response even if invalid, or generate a fallback without schema tool
      if (lastResponse) {
        return {
          content: lastResponse.content ?? '',
          toolCalls:
            lastResponse.type === 'assistant'
              ? lastResponse.toolCalls
              : undefined,
          metadata: lastResponse.metadata?.toObject(),
          structuredOutput: undefined, // Indicate schema validation failed
        };
      } else {
        // Fallback if generateText failed consistently
        const fallbackResponse = await generateText(
          session,
          this.generateOptions,
        ); // Generate without schema tool
        return {
          content: fallbackResponse.content,
          toolCalls:
            fallbackResponse.type === 'assistant'
              ? fallbackResponse.toolCalls
              : undefined,
          metadata: fallbackResponse.metadata?.toObject(),
        };
      }
    } else {
      // Should not happen, but safety return
      return { content: '' };
    }
  }
}
