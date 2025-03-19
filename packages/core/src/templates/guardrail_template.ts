import type { Session } from '../session';
import { Template } from '../templates';
import { createMetadata } from '../metadata';
import {
  createTransformer,
  type SessionTransformer,
} from '../utils/session_transformer';

/**
 * Interface for validator functions that check if a response meets certain criteria
 */
export interface Validator {
  /**
   * Validate a string against specific criteria
   * @param content The content to validate
   * @returns A validation result object
   */
  validate(content: string): Promise<ValidationResult>;
}

/**
 * Result of a validation operation
 */
export interface ValidationResult {
  /**
   * Whether the validation passed
   */
  passed: boolean;

  /**
   * Score between 0 and 1 if applicable
   */
  score?: number;

  /**
   * Explanation of why validation failed or feedback on the content
   */
  feedback?: string;

  /**
   * Suggested fix for the content if validation failed
   */
  fix?: string;
}

/**
 * Action to take when validation fails
 */
export enum OnFailAction {
  /**
   * Throw an exception
   */
  EXCEPTION = 'exception',

  /**
   * Retry with the model
   */
  RETRY = 'retry',

  /**
   * Apply the suggested fix if available
   */
  FIX = 'fix',

  /**
   * Continue despite the failure
   */
  CONTINUE = 'continue',
}

/**
 * Options for the GuardrailTemplate
 */
export interface GuardrailTemplateOptions<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * The template to execute and validate
   */
  template: Template<TInput, Record<string, unknown>>;

  /**
   * Validators to apply to the response
   */
  validators: Validator[];

  /**
   * Action to take when validation fails
   */
  onFail?: OnFailAction;

  /**
   * Maximum number of retry attempts
   */
  maxAttempts?: number;

  /**
   * Callback function called when validation fails
   */
  onRejection?: (
    result: ValidationResult,
    content: string,
    attempt: number,
  ) => void;
}

/**
 * Template that applies guardrails to ensure responses meet quality criteria
 *
 * @example
 * ```typescript
 * // Create a guardrail template with validators
 * const guardrailTemplate = new GuardrailTemplate({
 *   template: new AssistantTemplate({ model }),
 *   validators: [
 *     new RegexMatchValidator({
 *       regex: /^[A-Z][a-z]+$/,
 *       description: "Response must be a single capitalized word"
 *     }),
 *     new ToxicLanguageValidator({
 *       threshold: 0.5
 *     })
 *   ],
 *   onFail: OnFailAction.RETRY,
 *   maxAttempts: 3
 * });
 *
 * // Use in a conversation
 * const template = new LinearTemplate()
 *   .addSystem("You are a helpful assistant.")
 *   .addUser("Give me a name for my pet cat.")
 *   .addTemplate(guardrailTemplate);
 *
 * const session = await template.execute(createSession());
 * ```
 */
export class GuardrailTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> extends Template<TInput> {
  private options: GuardrailTemplateOptions<TInput>;

  constructor(options: GuardrailTemplateOptions<TInput>) {
    super();
    this.options = {
      ...options,
      onFail: options.onFail || OnFailAction.RETRY,
      maxAttempts: options.maxAttempts || 3,
    };
  }

  async execute(session: Session<TInput>): Promise<Session<TInput & { guardrail?: { attempt: number; passed: boolean; validationResults: ValidationResult[] } }>> {
    const maxAttempts = this.options.maxAttempts || 3;

    let attempts = 0;
    let resultSession: Session<TInput & { guardrail?: { attempt: number; passed: boolean; validationResults: ValidationResult[] } }>;
    let validationResults: ValidationResult[] = [];
    let allPassed = false;

    do {
      attempts++;

      // Execute the template
      // Use type assertion to handle template execution
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resultSession = await this.options.template.execute(session as any) as any;

      // Get the last message content
      const lastMessage = resultSession.getLastMessage();
      if (!lastMessage) {
        throw new Error('No message generated to validate');
      }

      // Validate the content with all validators
      validationResults = await Promise.all(
        this.options.validators.map((validator) =>
          validator.validate(lastMessage.content),
        ),
      );

      // Check if all validations passed
      allPassed = validationResults.every((result) => result.passed);

      // Handle validation failure
      if (!allPassed) {
        // Call rejection handler if provided
        if (this.options.onRejection) {
          const failedResults = validationResults.filter(
            (result) => !result.passed,
          );
          for (const result of failedResults) {
            this.options.onRejection(result, lastMessage.content, attempts);
          }
        }

        // Handle based on onFail action
        switch (this.options.onFail) {
          case OnFailAction.EXCEPTION: {
            const failedFeedback = validationResults
              .filter((result) => !result.passed)
              .map((result) => result.feedback)
              .filter(Boolean)
              .join('; ');
            throw new Error(`Validation failed: ${failedFeedback}`);
          }

          case OnFailAction.FIX: {
            // If any validator provides a fix, apply it and return
            const fixResult = validationResults.find(
              (result) => !result.passed && result.fix,
            );
            if (fixResult?.fix) {
              return resultSession.addMessage({
                type: 'assistant',
                content: fixResult.fix,
                metadata: createMetadata().set('guardrail', {
                  fixed: true,
                  originalContent: lastMessage.content,
                  validationResults,
                }),
              });
            }
            // If no fix available, continue to retry
            break;
          }

          case OnFailAction.CONTINUE:
            // Continue with the failed result but keep allPassed as false
            // This will exit the loop but preserve the failed status
            // Use type assertion to handle return type
             
            return resultSession.updateMetadata({
              guardrail: {
                attempt: attempts,
                passed: false,
                validationResults,
              },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            }) as any;

          case OnFailAction.RETRY:
          default:
            // Will retry in the next loop iteration if attempts < maxAttempts
            break;
        }
      }
    } while (!allPassed && attempts < maxAttempts);

    // Add validation metadata to the result
    // Use type assertion to handle return type
     
    return resultSession.updateMetadata({
      guardrail: {
        attempt: attempts,
        passed: allPassed,
        validationResults,
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  }
}

/**
 * Create a guardrail transformer that validates messages and updates metadata
 *
 * Unlike GuardrailTemplate which can retry or fix responses, this transformer
 * only validates existing messages and adds metadata about the validation.
 *
 * @example
 * ```typescript
 * // Create a guardrail transformer
 * const guardrailTransformer = createGuardrailTransformer({
 *   validators: [
 *     new RegexMatchValidator({ regex: /\d{3}-\d{3}-\d{4}/ }),
 *     new ToxicLanguageValidator({ threshold: 0.5 })
 *   ],
 *   messageTypes: ['assistant']
 * });
 *
 * // Use in a template
 * const template = new LinearTemplate()
 *   .addAssistant({ model })
 *   .addTransformer(guardrailTransformer);
 * ```
 */
export function createGuardrailTransformer<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput & {
    guardrail: { passed: boolean; validationResults: ValidationResult[] };
  },
>(options: {
  validators: Validator[];
  messageTypes?: string[];
}): SessionTransformer<TInput, TOutput> {
  return createTransformer<TInput, TOutput>(async (session) => {
    const messageTypes = options.messageTypes || ['assistant'];

    // Get messages to validate
    const messages = session.messages.filter((msg) =>
      messageTypes.includes(msg.type),
    );

    if (messages.length === 0) {
      return session as unknown as Session<TOutput>;
    }

    // Validate the last message of specified types
    const lastMessage = messages[messages.length - 1];

    // Run all validators
    const validationResults = await Promise.all(
      options.validators.map((validator) =>
        validator.validate(lastMessage.content),
      ),
    );

    // Check if all validations passed
    const allPassed = validationResults.every((result) => result.passed);

    // Add validation results to metadata
    return session.updateMetadata({
      guardrail: {
        passed: allPassed,
        validationResults,
      },
    }) as unknown as Session<TOutput>;
  });
}
