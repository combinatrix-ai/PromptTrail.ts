import type { Session } from '../types';
import { createSession } from '../session';
import { Source, StaticSource, LlmSource } from '../content_source';
import type { ModelOutput } from '../content_source';
import { GenerateOptions } from '../generate_options';
import { interpolateTemplate } from '../utils/template_interpolation';
import { Composed } from './composition';
// Imports related to loopIf removed

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
 * Interface for composed templates
 */
export interface IComposedTemplate<
  TStart extends Record<string, unknown> = Record<string, unknown>,
  TEnd extends Record<string, unknown> = TStart,
> extends Template<TStart, TEnd> {
  templates: Template<any, any>[];
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

  then<TNextOut extends Record<string, unknown>>(
    next: Template<TOut, TNextOut>,
  ): IComposedTemplate<TIn, TNextOut> {
    return new Composed<TIn, TNextOut>([this, next]);
  }

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
              session.metadata,
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
