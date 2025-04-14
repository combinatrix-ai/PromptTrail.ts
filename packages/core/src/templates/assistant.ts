import { createMetadata } from '../metadata';
import type { Session, AssistantMessage } from '../types';
import { BaseTemplate } from './interfaces';
import {
  Source,
  ModelOutput,
  ValidationOptions,
} from '../content_source';
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
        const modelOutput = (await this.contentSource.getContent(
          validSession,
        )) as ModelOutput;

        if (!modelOutput || typeof modelOutput.content !== 'string') {
          throw new Error(
            'Expected ModelOutput with string content from AssistantTemplate source',
          );
        }

        lastOutput = modelOutput;

        // Validate the content if validator is present
        if (this.validator) {
          const validationResult = await this.validator.validate(
            modelOutput.content,
            validSession,
          );
          if (!validationResult.isValid) {
            // For static content, use "Assistant content validation failed"
            if (this.isStaticContent) {
              throw new Error('Assistant content validation failed');
            }
            // For generated content, use "Assistant response validation failed"
            throw new Error('Assistant response validation failed');
          }
        }

        const message: AssistantMessage = {
          type: 'assistant',
          content: modelOutput.content,
          toolCalls: modelOutput.toolCalls,
          metadata: createMetadata(),
        };

        let updatedSession = validSession.addMessage(message);

        // Merge metadata from the model output into the session metadata
        if (modelOutput.metadata) {
          updatedSession = updatedSession.updateMetadata(
            modelOutput.metadata as any,
          );
        }

        // Add structured output to session metadata if present
        if (modelOutput.structuredOutput) {
          updatedSession = updatedSession.updateMetadata({
            structured_output: modelOutput.structuredOutput,
          } as any);
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

    // Try one more time to get content
    const modelOutput = (await this.contentSource.getContent(
      validSession,
    )) as ModelOutput;

    const message: AssistantMessage = {
      type: 'assistant',
      content: modelOutput.content,
      toolCalls: modelOutput.toolCalls,
      metadata: createMetadata(),
    };

    let updatedSession = validSession.addMessage(message);

    // Merge metadata from the model output into the session metadata
    if (modelOutput.metadata) {
      updatedSession = updatedSession.updateMetadata(
        modelOutput.metadata as any,
      );
    }

    // Add structured output to session metadata if present
    if (modelOutput.structuredOutput) {
      updatedSession = updatedSession.updateMetadata({
        structured_output: modelOutput.structuredOutput,
      } as any);
    }

    return updatedSession;
  }
}
