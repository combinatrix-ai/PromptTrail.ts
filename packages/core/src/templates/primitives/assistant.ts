// assistant.ts
import { ModelOutput, Source, ValidationOptions } from '../../content_source';
import type { AssistantMessage } from '../../message';
import type { Session } from '../../session';
import { Attrs, Vars } from '../../tagged_record';
import type { IValidator } from '../../validators/base';
import { TemplateBase } from '../base';

export class Assistant<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends TemplateBase<TAttrs, TVars> {
  private maxAttempts: number;
  private raiseError: boolean;
  private validator?: IValidator;
  private isStaticContent: boolean;

  constructor(
    contentOrSource?: string | Source<ModelOutput> | Source<string>,
    validatorOrOptions?: IValidator | ValidationOptions,
  ) {
    super();
    this.isStaticContent = typeof contentOrSource === 'string';

    // If no content source is provided, use default LLM source
    if (contentOrSource === undefined) {
      this.contentSource = Source.llm(); // Default to Source.llm()
    } else {
      // Use the initializeContentSource method from BaseTemplate
      this.contentSource = this.initializeContentSource(
        contentOrSource,
        'model',
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

  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const validSession = this.ensureSession(session);

    // Content source should always be available now (either provided or default)
    if (!this.contentSource) {
      throw new Error(
        'Content source initialization failed for AssistantTemplate',
      );
    }

    let attempts = 0;
    let lastError: Error | undefined;
    let lastOutput: ModelOutput | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;
      let currentOutput: ModelOutput | undefined;
      let currentError: Error | undefined;

      try {
        // 1. Get Content
        const rawOutput = await this.contentSource.getContent(validSession);
        let outputContent: string;
        let outputToolCalls: ModelOutput['toolCalls'] | undefined;
        let outpuTAttrs: ModelOutput['metadata'] | undefined;
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
          outpuTAttrs = modelOutput.metadata;
          outputStructured = modelOutput.structuredOutput;
        } else {
          throw new Error(
            'Invalid content source output for AssistantTemplate',
          );
        }

        // Store the output of this attempt
        currentOutput = {
          content: outputContent,
          toolCalls: outputToolCalls,
          metadata: outpuTAttrs,
          structuredOutput: outputStructured,
        };

        // Extract tool results if available
        if (
          rawOutput &&
          typeof rawOutput === 'object' &&
          'toolResults' in rawOutput
        ) {
          currentOutput.toolResults = (rawOutput as ModelOutput).toolResults;
        }

        lastOutput = currentOutput; // Keep track of the very last output

        // 2. Validate Content (if validator exists)
        if (this.validator) {
          const validationResult = await this.validator.validate(
            outputContent,
            validSession,
          );
          if (!validationResult.isValid) {
            // Throw specific error based on content type
            throw new Error(
              this.isStaticContent
                ? 'Assistant content validation failed'
                : 'Assistant response validation failed',
            );
          }
        }

        // 3. Success: Validation passed (or no validator) - Return immediately
        const message: AssistantMessage<TAttrs> = {
          type: 'assistant',
          content: currentOutput.content,
          toolCalls: currentOutput.toolCalls,
          attrs: Attrs.create<TAttrs>(currentOutput.metadata as TAttrs),
          structuredContent: currentOutput.structuredOutput,
        };
        let updatedSession = validSession.addMessage(message);

        // Add tool results as separate messages if available
        if (currentOutput.toolResults && currentOutput.toolResults.length > 0) {
          for (const toolResult of currentOutput.toolResults) {
            updatedSession = updatedSession.addMessage({
              type: 'tool_result',
              content: JSON.stringify(toolResult.result),
              attrs: Attrs.create<TAttrs>({
                toolCallId: toolResult.toolCallId,
              } as TAttrs),
            });
          }
        }

        return updatedSession;
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
      const lastMessage: AssistantMessage<TAttrs> = {
        type: 'assistant',
        content: lastOutput.content,
        toolCalls: lastOutput.toolCalls,
        attrs: Attrs.create<TAttrs>(lastOutput.metadata as TAttrs),
        structuredContent: lastOutput.structuredOutput,
      };
      let lastAttemptSession = validSession.addMessage(lastMessage);

      // Note: Not adding tool results to avoid ai-sdk message ordering issues

      return lastAttemptSession; // Resolve with the session containing the last (failed) output
    }

    // Should not be reachable if logic is correct
    throw new Error(
      'Assistant template execution finished in an unexpected state. No result or definitive error.',
    );
  }
}
