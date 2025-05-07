import type { ModelOutput } from '../content_source';
import { LlmSource, Source, StaticSource } from '../content_source';
import { GenerateOptions } from '../generate_options';
import type { Session } from '../session';
import { createSession } from '../session';
import { Context, Metadata } from '../tagged_record';
import { interpolateTemplate } from '../utils/template_interpolation';

/**
 * Core template interface
 * TMetadata: Message metadata type, must extend Record<string, unknown>
 * TContext: Session context type, must extend Record<string, unknown>
 */
export interface Template<
  TMetadata extends Metadata = Metadata,
  TContext extends Context = Context,
> {
  execute(
    session?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>>;
}

/**
 * Base template class with composition methods
 */
export abstract class TemplateBase<
  TMetadata extends Metadata = Metadata,
  TContext extends Context = Context,
> implements Template<TMetadata, TContext>
{
  protected contentSource?: Source<unknown>;

  abstract execute(
    session?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>>;

  protected ensureSession(
    session?: Session<TContext, TMetadata>,
  ): Session<TContext, TMetadata> {
    return session || createSession<TContext, TMetadata>();
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
          async getContent(
            session: Session<TContext, TMetadata>,
          ): Promise<ModelOutput> {
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
}
