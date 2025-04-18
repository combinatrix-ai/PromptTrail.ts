import { createMetadata } from '../metadata';
import type { Session, AssistantMessage } from '../types';
import { BaseTemplate } from './base';
import { Source, ModelOutput, ValidationOptions } from '../content_source';
import type { IValidator } from '../validators/base';
import { GenerateOptions } from '../generate_options';

export class Assistant extends BaseTemplate<any, any> {
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
      let currentOutput: ModelOutput | undefined;
      let currentError: Error | undefined;

      try {
        // 1. Get Content
        console.log(`[Debug] Attempt ${attempts}: Starting...`); // DEBUG
        const rawOutput = await this.contentSource.getContent(validSession);
        let outputContent: string;
        let outputToolCalls: ModelOutput['toolCalls'] | undefined;
        let outputMetadata: ModelOutput['metadata'] | undefined;
        let outputStructured: ModelOutput['structuredOutput'] | undefined;

        if (typeof rawOutput === 'string') {
          outputContent = rawOutput;
        } else if (
          rawOutput &&
          typeof rawOutput === 'object' &&
          'content' in rawOutput &&
          typeof rawOutput.content === 'string'
        ) {
          const modelOutput = rawOutput as ModelOutput;
          outputContent = modelOutput.content;
          outputToolCalls = modelOutput.toolCalls;
          outputMetadata = modelOutput.metadata;
          outputStructured = modelOutput.structuredOutput;
        } else {
          throw new Error(
            'Invalid content source output for AssistantTemplate',
          );
        }
        console.log(`[Debug] Attempt ${attempts}: Raw Output =`, rawOutput); // DEBUG

        // Store the output of this attempt
        currentOutput = {
          content: outputContent,
          toolCalls: outputToolCalls,
          metadata: outputMetadata,
          structuredOutput: outputStructured,
        };
        lastOutput = currentOutput; // Keep track of the very last output

        // 2. Validate Content (if validator exists)
        if (this.validator) {
          const validationResult = await this.validator.validate(
            outputContent,
            validSession,
          );
          if (!validationResult.isValid) {
            console.log(`[Debug] Attempt ${attempts}: Validation FAILED`); // DEBUG
            // Throw specific error based on content type
            throw new Error(
              this.isStaticContent
                ? 'Assistant content validation failed'
                : 'Assistant response validation failed',
            );
          }
        } else {
          console.log(`[Debug] Attempt ${attempts}: Validation PASSED`); // DEBUG
        }

        // 3. Success: Validation passed (or no validator) - Return immediately
        const message: AssistantMessage = {
          type: 'assistant',
          content: currentOutput.content,
          toolCalls: currentOutput.toolCalls,
          metadata: createMetadata(),
        };
        let updatedSession = validSession.addMessage(message);
        if (currentOutput.metadata) {
          updatedSession = updatedSession.updateMetadata(
            currentOutput.metadata as any,
          );
        }
        if (currentOutput.structuredOutput) {
          updatedSession = updatedSession.updateMetadata({
            structured_output: currentOutput.structuredOutput,
          } as any);
        }
        return updatedSession; // Exit loop and function on success
      } catch (error) {
        // 4. Handle Error (Validation or other error during try block)
        currentError = error as Error;
        lastError = currentError; // Keep track of the very last error

        if (attempts < this.maxAttempts) {
          // Not the last attempt, log and retry
          console.warn(
            `Attempt ${attempts} failed: ${currentError.message}. Retrying...`,
          );
          continue; // Go to next iteration
        } else {
          // Last attempt failed
          if (this.raiseError) {
            // If raiseError is true, explicitly return a rejected promise
            // with the last recorded error.
            return Promise.reject(lastError);
          } else {
            // If raiseError is false, break the loop to handle returning the last output below
            console.warn(
              `Validation failed after ${attempts} attempts. raiseError is false, returning last output.`,
            );
            break; // Exit the loop
          }
        }
      } // End catch
    } // End while

    // 5. Post-Loop Handling (Only reached if loop finished without success)
    // This happens if the last attempt failed and raiseError was false.
    if (!this.raiseError && lastError && lastOutput) {
      // Construct session from the last recorded output (which failed validation)
      const lastMessage: AssistantMessage = {
        type: 'assistant',
        content: lastOutput.content,
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
      return lastAttemptSession; // Resolve with the session containing the last (failed) output
    }

    // Should not be reachable if logic is correct
    throw new Error(
      'Assistant template execution finished in an unexpected state. No result or definitive error.',
    );
  }
}
