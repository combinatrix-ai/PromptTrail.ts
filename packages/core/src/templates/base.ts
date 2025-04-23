import type { Session } from '../types';
import { createSession } from '../session';
import { Source, StaticSource, LlmSource } from '../content_source';
import type { ModelOutput } from '../content_source';
import { GenerateOptions } from '../generate_options';
import { interpolateTemplate } from '../utils/template_interpolation';

/**
 * Core template interface
 * TIn: Input session metadata type, must extend Record<string, unknown>
 * TOut: Output session metadata type, must extend Record<string, unknown>
 */
export interface Template<
  TIn extends Record<string, unknown> = Record<string, unknown>,
  TOut extends Record<string, unknown> = TIn,
> {
  execute(session?: Session<TIn>): Promise<Session<TOut>>;
}

/**
 * Base template class with composition methods
 */
export abstract class BaseTemplate<
  TIn extends Record<string, unknown> = Record<string, unknown>,
  TOut extends Record<string, unknown> = TIn,
> implements Template<TIn, TOut>
{
  protected contentSource?: Source<unknown>;

  abstract execute(session?: Session<TIn>): Promise<Session<TOut>>;

  protected ensureSession(session?: Session<TIn>): Session<TIn> {
    return session || createSession<TIn>();
  }

  getContentSource(): Source<unknown> | undefined {
    return this.contentSource;
  }

  protected initializeContentSource(
    input:
      | string
      | Source<any>
      | GenerateOptions
      | Record<string, any>
      | undefined,
    expectedSourceType: 'string' | 'model' | 'any' = 'any',
  ): Source<any> | undefined {
    // Remove debug logs
    if (input === undefined) {
      return undefined;
    }

    if (input instanceof Source) {
      return input;
    }

    if (typeof input === 'string') {
      if (expectedSourceType === 'model') {
        return {
          async getContent(session: Session): Promise<ModelOutput> {
            const interpolatedContent = interpolateTemplate(
              input,
              session.context,
            );
            return { content: interpolatedContent };
          },
        } as Source<ModelOutput>;
      } else {
        return new StaticSource(input);
      }
    }
    // Check if it's a GenerateOptions instance or has the same constructor name
    if (
      input instanceof GenerateOptions ||
      (input &&
        typeof input === 'object' &&
        input.constructor &&
        input.constructor.name === 'GenerateOptions')
    ) {
      if (expectedSourceType === 'string') {
        throw new Error(
          'GenerateOptions cannot be used for a string-based source.',
        );
      }
      return new LlmSource(input as GenerateOptions);
    }

    // Handle plain objects that might be GenerateOptions
    if (typeof input === 'object' && input !== null) {
      if (expectedSourceType === 'string') {
        throw new Error('Object cannot be used for a string-based source.');
      }

      // Check if it has the properties of a GenerateOptions
      if ('provider' in input) {
        // Create a new LlmSource directly with the input
        return new LlmSource(input as any);
      }
    }

    throw new Error(
      `Unsupported input type for content source: ${typeof input}`,
    );
  }
} // Correct closing brace for BaseTemplate class
/**
 * Base class for composite templates (Sequence, Loop, Subroutine)
 * Provides common functionality and a unified execution model
 */

export abstract class CompositeTemplateBase<
  TIn extends Record<string, unknown> = Record<string, unknown>,
  TOut extends Record<string, unknown> = TIn,
> extends BaseTemplate<TIn, TOut> {
  // Common properties - protected so derived classes can access them
  protected templates: Template<any, any>[] = [];
  protected initFunction?: (session: Session<TIn>) => Session<any>;
  protected squashFunction?: (
    parentSession: Session<TIn>,
    childSession: Session<any>,
  ) => Session<TOut>;
  protected loopCondition?: (session: Session<any>) => boolean;
  protected maxIterations: number = 100;

  // Common template management method
  add(template: Template<any, any>): this {
    this.templates.push(template);
    return this;
  }

  // Factory methods will be added by the factory module
  // Unified execute implementation
  async execute(session?: Session<TIn>): Promise<Session<TOut>> {
    const originalSession = this.ensureSession(session);

    // Validate that we have templates to execute
    if (this.templates.length === 0) {
      // For Loop templates, throw an error
      if (this.constructor.name === 'Loop') {
        throw new Error('LoopTemplate requires a bodyTemplate.');
      }
      // For other templates, just return the original session
      return originalSession as unknown as Session<TOut>;
    }

    // 1. Initialize session (if initFunction provided)
    let currentSession = this.initFunction
      ? this.initFunction(originalSession)
      : originalSession;

    // 2. Execute templates (with optional looping)
    if (this.loopCondition !== undefined) {
      // Loop execution
      let iterations = 0;

      // Check if the loopCondition is a function
      if (typeof this.loopCondition !== 'function') {
        // If no exit condition is provided, execute once and warn
        if (this.constructor.name === 'Loop') {
          console.warn(
            'LoopTemplate executed without an exit condition. Executing once.',
          );
        }
        for (const template of this.templates) {
          currentSession = await template.execute(currentSession);
        }
      } else {
        // Execute the loop until the exit condition is met or max iterations reached
        while (
          iterations < this.maxIterations &&
          !this.loopCondition(currentSession)
        ) {
          for (const template of this.templates) {
            currentSession = await template.execute(currentSession);
          }
          iterations++;
        }

        if (iterations >= this.maxIterations) {
          if (this.constructor.name === 'Loop') {
            console.warn(
              `LoopTemplate reached maximum iterations (${this.maxIterations}). Exiting.`,
            );
          } else {
            console.warn(
              `Loop reached maximum iterations (${this.maxIterations}). Exiting.`,
            );
          }
        }
      }
    } else {
      // Simple sequence execution
      for (const template of this.templates) {
        currentSession = await template.execute(currentSession);
      }
    }

    // 3. Apply squash function (if provided)
    return this.squashFunction
      ? this.squashFunction(originalSession, currentSession)
      : (currentSession as unknown as Session<TOut>);
  }
}
