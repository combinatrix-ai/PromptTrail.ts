import { createMetadata } from '../metadata';
import type { Session, AssistantMessage } from '../types';
import { BaseTemplate } from './interfaces';
import { Source, ModelOutput, ValidationOptions } from '../content_source';
import type { IValidator } from '../validators/base';
import { GenerateOptions } from '../generate_options';

export class AssistantTemplate extends BaseTemplate<any, any> {
  private maxAttempts: number;
  private raiseError: boolean;
  private validator?: IValidator;
  private isStaticContent: boolean;

  constructor(
    contentOrSource?:
      | string
      | Source<ModelOutput>
      | GenerateOptions
      | Record<string, any>,
    validatorOrOptions?: IValidator | ValidationOptions,
  ) {
    super();
    this.isStaticContent = typeof contentOrSource === 'string';

    // Use the initializeContentSource method from BaseTemplate
    this.contentSource = this.initializeContentSource(contentOrSource, 'model');

    if (!this.contentSource) {
      throw new Error(
        `Failed to initialize content source from: ${typeof contentOrSource}`,
      );
    }

    // Handle both validator and options cases
    if (validatorOrOptions) {
      if ('validate' in validatorOrOptions) {
        // It's a validator
        this.validator = validatorOrOptions;
        this.maxAttempts = 1;
        this.raiseError = true;
      } else {
        // It's options
        this.validator = validatorOrOptions.validator;
        this.maxAttempts = validatorOrOptions.maxAttempts ?? 1;
        this.raiseError = validatorOrOptions.raiseError ?? true;
      }
    } else {
      this.maxAttempts = 1;
      this.raiseError = true;
    }
  }

  async execute(session?: Session): Promise<Session> {
    const validSession = this.ensureSession(session);
    if (!this.contentSource)
      throw new Error('Content source required for AssistantTemplate');

    let attempts = 0;
    let lastError: Error | undefined;
    let lastOutput: ModelOutput | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;
      try {
        // Get content, which could be string or ModelOutput
        const rawOutput = await this.contentSource.getContent(validSession);
        let outputContent: string;
        let outputToolCalls: ModelOutput['toolCalls'] | undefined;
        let outputMetadata: ModelOutput['metadata'] | undefined;
        let outputStructured: ModelOutput['structuredOutput'] | undefined;

        if (typeof rawOutput === 'string') {
          // Handle plain string source
          outputContent = rawOutput;
          // No tool calls, metadata, or structured output from static string
        } else if (
          rawOutput &&
          typeof rawOutput === 'object' &&
          'content' in rawOutput &&
          typeof rawOutput.content === 'string'
        ) {
          // Handle ModelOutput object source
          const modelOutput = rawOutput as ModelOutput;
          outputContent = modelOutput.content;
          outputToolCalls = modelOutput.toolCalls;
          outputMetadata = modelOutput.metadata;
          outputStructured = modelOutput.structuredOutput;
        } else {
          // Handle unexpected source type
          throw new Error(
            'Expected string or ModelOutput with string content from AssistantTemplate source',
          );
        }

        // Construct lastOutput from the extracted parts
        lastOutput = {
          content: outputContent,
          toolCalls: outputToolCalls,
          metadata: outputMetadata,
          structuredOutput: outputStructured,
        };

        // Validate the content if validator is present
        if (this.validator) {
          // Validate the extracted content string
          const validationResult = await this.validator.validate(
            outputContent, // Use the extracted content string
            validSession,
          );
          if (!validationResult.isValid) {
            // If content is static, validation failure is final, throw immediately
            if (this.isStaticContent) {
              // Use the specific error message for static content validation failure
              throw new Error('Assistant content validation failed');
            } else {
              // For generated content, use a different error message before retry logic
              throw new Error('Assistant response validation failed');
            }
            // NOTE: The error thrown here will be caught by the catch block below
            // and handled by the retry/raiseError logic. If immediate throw
            // without retry for static content is desired, the logic needs more restructuring.
            // For now, let's keep the existing retry structure but use distinct error messages.
          }
        }

        const message: AssistantMessage = {
          type: 'assistant',
          content: outputContent, // Use extracted content
          toolCalls: outputToolCalls, // Use extracted tool calls
          metadata: createMetadata(), // Start with fresh message metadata
        };

        let updatedSession = validSession.addMessage(message);

        // Merge metadata from the model output into the session metadata
        // Merge metadata from the model output (if it was ModelOutput) into the session metadata
        if (outputMetadata) {
          updatedSession = updatedSession.updateMetadata(
            outputMetadata as any, // Cast needed if metadata structure varies
          );
        }

        // Add structured output to session metadata if present
        // Add structured output to session metadata if present (if it was ModelOutput)
        if (outputStructured) {
          updatedSession = updatedSession.updateMetadata({
            structured_output: outputStructured,
          } as any); // Cast needed if metadata structure varies
        }

        return updatedSession;
      } catch (error) {
        lastError = error as Error;
        if (attempts < this.maxAttempts) {
          console.warn(
            `Validation attempt ${attempts} failed: ${lastError.message}. Retrying...`,
          );
          continue;
        }
      }
    }

    if (this.raiseError && lastError) {
      if (attempts > 1) {
        throw new Error(
          `Assistant response validation failed after ${attempts} attempts`,
        );
      } else {
        throw lastError;
      }
    }

    // If we get here, validation failed but raiseError is false
    console.warn(
      `LlmSource: Validation failed after ${attempts} attempts. Returning last generated content.`,
    );

    // Return the last generated content even though validation failed
    if (!lastOutput) {
      throw new Error('No output was generated');
    }

    // If raiseError is false, return the last valid output (if any) or the last error output
    // The current logic re-fetches content, which might not be desired if validation failed.
    // Let's return the session state corresponding to the last *attempted* output (lastOutput).
    if (!lastOutput) {
      // This should ideally not happen if the loop ran at least once, but handle defensively
      throw (
        lastError ??
        new Error('Assistant generation failed without specific error')
      );
    }

    // Reconstruct the message and session state from the last attempt (lastOutput)
    const lastMessage: AssistantMessage = {
      type: 'assistant',
      content: lastOutput.content, // Use content from the last attempt
      toolCalls: lastOutput.toolCalls,
      metadata: createMetadata(),
    };

    let lastAttemptSession = validSession.addMessage(lastMessage);

    if (lastOutput.metadata) {
      lastAttemptSession = lastAttemptSession.updateMetadata(
        lastOutput.metadata as any,
      );
    }
    if (lastOutput.structuredOutput) {
      lastAttemptSession = lastAttemptSession.updateMetadata({
        structured_output: lastOutput.structuredOutput,
      } as any);
    }
    // Return the session state from the last attempt, even if validation failed
    return lastAttemptSession;

    // This line was part of the old logic; the refactored block now correctly returns lastAttemptSession earlier.
    // Remove this potentially duplicated/incorrect return statement.
    // The correct return is handled within the refactored block ending on line 204.
  }
}
