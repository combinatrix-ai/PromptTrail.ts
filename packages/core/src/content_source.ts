import * as readline from 'node:readline/promises';
import { z } from 'zod';
import { ValidationError } from './errors';
import { generateText } from './generate';
import type {
  GenerateOptions,
  OpenAIProviderConfig,
  AnthropicProviderConfig,
  GoogleProviderConfig,
  ProviderConfig,
} from './generate_options';
import { createGenerateOptions } from './generate_options';
import type { Session } from './session';
import type { Vars } from './tagged_record';
import { interpolateTemplate } from './utils/template_interpolation';
import type {
  IValidator,
  TValidationResult as ValidationResult,
} from './validators/base'; // TODO: Rename IValidator to Validator, Use TValidationResult

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
  validator?: IValidator;
  maxAttempts?: number;
  raiseError?: boolean;
}

/**
 * Base class for all content sources (Renamed from ContentSource)
 */
export abstract class Source<T = unknown> {
  protected validator?: IValidator;
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
  abstract getContent(session: Session<any, any>): Promise<T>;

  /**
   * Validates the given content once using the assigned validator.
   * Does NOT handle retries internally. Retries should be handled by the calling method (e.g., getContent).
   */
  protected async validateContent(
    content: string,
    session: Session<any, any>,
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
 * Supports template interpolation with session context (Renamed from StaticContentSource)
 */
export class StaticSource extends TextSource {
  constructor(
    private content: string,
    options?: ValidationOptions, // Added options
  ) {
    super(options); // Pass options to base class
  }

  async getContent(session: Session<any, any>): Promise<string> {
    const interpolatedContent = interpolateTemplate(this.content, session);
    // Use shared validation logic (single attempt)
    const validationResult = await this.validateContent(
      interpolatedContent,
      session,
    );
    if (!validationResult.isValid && this.raiseError) {
      const errorMessage = `Validation failed: ${validationResult.instruction || ''}`;
      throw new ValidationError(errorMessage);
    }
    // If valid or raiseError is false, return content
    return interpolatedContent;
  }
}

/**
 * Content source that returns a random element from a predefined list
 */
export class RandomSource extends TextSource {
  constructor(
    private contentList: string[],
    options?: ValidationOptions,
  ) {
    super(options);
  }

  async getContent(session: Session<any, any>): Promise<string> {
    const randomIndex = Math.floor(Math.random() * this.contentList.length);
    return this.contentList[randomIndex];
  }
}

/**
 * Content source that returns elements from a predefined list sequentially.
 * By default, it throws an error when the list is exhausted.
 * If `loop` is set to true in options, it restarts from the beginning.
 */
export class ListSource extends TextSource {
  private index: number = 0;
  private loop: boolean;

  constructor(
    private contentList: string[],
    options?: ValidationOptions & { loop?: boolean },
  ) {
    super(options);
    this.loop = options?.loop ?? false;
  }

  async getContent(session: Session<any, any>): Promise<string> {
    if (this.index < this.contentList.length) {
      const content = this.contentList[this.index++];
      // Apply validation if a validator exists
      const validationResult = await this.validateContent(content, session);
      if (!validationResult.isValid && this.raiseError) {
        const errorMessage = `Validation failed for item at index ${this.index - 1}: ${validationResult.instruction || ''}`;
        throw new ValidationError(errorMessage);
      }
      // Return content if valid or if raiseError is false
      return content;
    } else if (this.loop) {
      this.index = 0; // Reset index to loop
      if (this.index < this.contentList.length) {
        // Check if list is not empty
        const content = this.contentList[this.index++];
        // Apply validation if a validator exists
        const validationResult = await this.validateContent(content, session);
        if (!validationResult.isValid && this.raiseError) {
          const errorMessage = `Validation failed for item at index ${this.index - 1} (looping): ${validationResult.instruction || ''}`;
          throw new ValidationError(errorMessage);
        }
        // Return content if valid or if raiseError is false
        return content;
      } else {
        // Handle empty list case during loop reset
        throw new Error('ListSource is empty.');
      }
    } else {
      throw new Error('No more content in the ListSource.');
    }
  }

  /**
   * Gets the current index.
   */
  getIndex(): number {
    return this.index;
  }

  /**
   * Checks if the source is at the end of the list (and not looping).
   */
  atEnd(): boolean {
    return !this.loop && this.index >= this.contentList.length;
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

  async getContent(session: Session<any, any>): Promise<string> {
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
            throw new ValidationError(errorMessage);
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
    private callback: (context: { context?: Vars }) => Promise<string>,
    options?: ValidationOptions, // Use ValidationOptions
  ) {
    super(options); // Pass options to base class
  }

  async getContent(session: Session<any, any>): Promise<string> {
    let attempts = 0;
    let lastResult: ValidationResult | undefined;
    let currentInput = '';

    while (attempts < this.maxAttempts) {
      attempts++;
      currentInput = await this.callback({ context: session.vars });
      lastResult = await this.validateContent(currentInput, session); // Validate the newly fetched content (single attempt)

      if (lastResult.isValid) {
        return currentInput; // Return the valid input
      }

      // If validation failed
      const isLastAttempt = attempts >= this.maxAttempts;

      if (isLastAttempt) {
        if (this.raiseError) {
          const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
          throw new ValidationError(errorMessage);
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
        // session = session.addMessage({ type: 'system', content: `Validation failed: ${lastResult.instruction}. Please revise.` });
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
  private generateOptions: GenerateOptions;

  constructor(options?: ValidationOptions) {
    super(options);
    // Sensible defaults using OpenAI provider
    this.generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || '',
        modelName: 'gpt-4o-mini',
      },
    });
  }

  /** Configure OpenAI provider */
  openai(cfg: Partial<Omit<OpenAIProviderConfig, 'type'>> = {}) {
    this.generateOptions.provider = {
      type: 'openai',
      apiKey: cfg.apiKey ?? process.env.OPENAI_API_KEY ?? '',
      modelName: cfg.modelName ?? 'gpt-4o-mini',
      baseURL: cfg.baseURL,
      organization: cfg.organization,
      dangerouslyAllowBrowser: cfg.dangerouslyAllowBrowser,
    };
    return this;
  }

  /** Configure Anthropic provider */
  anthropic(cfg: Partial<Omit<AnthropicProviderConfig, 'type'>> = {}) {
    this.generateOptions.provider = {
      type: 'anthropic',
      apiKey: cfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '',
      modelName: cfg.modelName ?? 'claude-3.7-haiku',
      baseURL: cfg.baseURL,
    };
    return this;
  }

  /** Configure Google provider */
  google(cfg: Partial<Omit<GoogleProviderConfig, 'type'>> = {}) {
    this.generateOptions.provider = {
      type: 'google',
      apiKey:
        cfg.apiKey ??
        process.env.GOOGLE_API_KEY ??
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
        '',
      modelName: cfg.modelName ?? 'gemini-pro',
      baseURL: cfg.baseURL,
    };
    return this;
  }

  /** Set temperature */
  temperature(value: number) {
    this.generateOptions.temperature = value;
    return this;
  }

  /** Override provider model */
  model(name: string) {
    this.generateOptions.provider = {
      ...this.generateOptions.provider,
      modelName: name,
    } as ProviderConfig;
    return this;
  }

  /** Override provider API key */
  apikey(key: string) {
    this.generateOptions.provider = {
      ...this.generateOptions.provider,
      apiKey: key,
    } as ProviderConfig;
    return this;
  }

  /** Delegate to GenerateOptions.addTool */
  addTool(name: string, tool: unknown) {
    this.generateOptions.addTool(name, tool);
    return this;
  }

  /** Delegate to GenerateOptions.setToolChoice */
  toolChoice(choice: 'auto' | 'required' | 'none') {
    this.generateOptions.setToolChoice(choice);
    return this;
  }

  /** Assign validator */
  validate(v: IValidator) {
    this.validator = v;
    return this;
  }

  async getContent(session: Session<any, any>): Promise<ModelOutput> {
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
          metadata: response.attrs,
        };
      }

      // If validation failed
      const isLastAttempt = attempts >= this.maxAttempts;

      if (isLastAttempt) {
        if (this.raiseError) {
          const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
          throw new ValidationError(errorMessage);
        } else {
          console.warn(
            `LlmSource: Validation failed after ${attempts} attempts. Returning last generated content.`,
          );
          // Return the last (invalid) response if not raising error
          return {
            content: responseContent,
            toolCalls: response.toolCalls,
            metadata: response.attrs,
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

  async getContent(session: Session<any, any>): Promise<ModelOutput> {
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
            lastError = new ValidationError('Text content validation failed');
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
                metadata: lastResponse.attrs,
              };
            } else {
              lastError = new Error(
                `Schema validation failed: ${result.error.message}`,
              );
              console.warn(
                `SchemaSource: Schema validation failed (attempt ${attempts}): ${lastError.message}`,
              );
              if (attempts >= this.maxAttempts && this.raiseError) {
                throw lastError;
              }
              if (attempts >= this.maxAttempts && !this.raiseError) {
                console.warn(
                  `SchemaSource: Schema validation failed after ${attempts} attempts. Returning last generated content.`,
                );
                return {
                  content: responseContent,
                  toolCalls: lastResponse.toolCalls,
                  metadata: lastResponse.attrs,
                };
              }
              console.log(
                `Retrying generation due to schema validation failure...`,
              );
              continue; // Retry generation
            }
          }
        }

        // If we reach here, either no tool call was made, or the tool call was not for the schema function.
        // This might be a valid response depending on the use case, but for SchemaSource, we expect a structured output.
        // Treat this as a validation failure for the purpose of retries.
        lastError = new Error('No valid schema tool call found in response.');
        console.warn(
          `SchemaSource: No valid schema tool call found (attempt ${attempts}).`,
        );

        if (attempts >= this.maxAttempts && this.raiseError) {
          throw lastError;
        }
        if (attempts >= this.maxAttempts && !this.raiseError) {
          console.warn(
            `SchemaSource: No valid schema tool call found after ${attempts} attempts. Returning last generated content.`,
          );
          // Return the last response even if it didn't have the expected tool call
          return {
            content: responseContent,
            toolCalls: lastResponse?.toolCalls,
            metadata: lastResponse?.attrs,
          };
        }
        console.log(`Retrying generation due to missing schema tool call...`);
        continue; // Retry generation
      } catch (error) {
        // Handle other errors during generateText or processing
        lastError = error as Error;
        console.error(
          `SchemaSource: Attempt ${attempts}/${this.maxAttempts} failed:`,
          lastError,
        );

        if (attempts >= this.maxAttempts) {
          if (this.raiseError) {
            throw new Error(
              `SchemaSource: Failed after ${this.maxAttempts} attempts: ${lastError.message}`,
            );
          } else {
            console.warn(
              `SchemaSource: Failed after ${attempts} attempts. Returning last generated content (if any).`,
            );
            // Return last response if available, even if it caused an error
            if (lastResponse) {
              return {
                content: lastResponse.content ?? '',
                toolCalls: lastResponse.toolCalls,
                metadata: lastResponse.attrs,
              };
            } else {
              return { content: '' }; // Return empty if no response was generated
            }
          }
        }
        console.log(`Retrying... (${attempts}/${this.maxAttempts})`);
        // Optionally add delay here
      } // End catch
    } // End while

    // Should not be reachable if raiseError is true and maxAttempts >= 1
    // If raiseError is false, the last attempt failure case should have returned.
    // This might be reached if maxAttempts is 0 or negative, or if there's a logic error.
    throw new Error(
      `SchemaSource: Execution finished in an unexpected state after ${this.maxAttempts} attempts.`,
    );
  }
}

/**
 * Builder for {@link CLISource}
 */
export class CliBuilder {
  private promptText = '';
  private defaultVal?: string;
  private validation: ValidationOptions = {};

  /** Set prompt shown to the user */
  prompt(text: string) {
    this.promptText = text;
    return this;
  }

  /** Set default value when user provides empty input */
  defaultValue(val: string) {
    this.defaultVal = val;
    return this;
  }

  /** Configure validator */
  validate(v: IValidator) {
    this.validation.validator = v;
    return this;
  }

  /** Build the CLISource instance */
  build() {
    return new CLISource(this.promptText, this.defaultVal, this.validation);
  }
}

/**
 * Convenience factory methods for creating common sources
 */
export namespace Source {
  /** Create builder for LLM backed source */
  export function llm() {
    return new LlmSource();
  }

  /** Create builder for LLM with Google provider */
  export function google(cfg: Omit<GoogleProviderConfig, 'type'>) {
    return new LlmSource().google(cfg);
  }

  /** Create builder for CLI input source */
  export function cli() {
    return new CliBuilder();
  }
}
