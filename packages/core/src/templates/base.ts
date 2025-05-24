import type { LlmSource, ModelOutput } from '../content_source';
import { Source, StaticSource } from '../content_source';
import type { Session } from '../session';
import { createSession } from '../session';
import { Attrs, Vars } from '../tagged_record';
import { interpolateTemplate } from '../utils/template_interpolation';

/**
 * Core template interface
 * TAttrs: Message metadata type, must extend Record<string, unknown>
 * TVars: Session context type, must extend Record<string, unknown>
 */
export interface Template<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> {
  execute(session?: Session<TVars, TAttrs>): Promise<Session<TVars, TAttrs>>;
}

/**
 * Base template class with composition methods
 */
export abstract class TemplateBase<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> implements Template<TAttrs, TVars>
{
  protected contentSource?: Source<unknown>;

  abstract execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>>;

  protected ensureSession(
    session?: Session<TVars, TAttrs>,
  ): Session<TVars, TAttrs> {
    return session || createSession<TVars, TAttrs>();
  }

  getContentSource(): Source<unknown> | undefined {
    return this.contentSource;
  }

  protected initializeContentSource(
    input: string | Source<any> | LlmSource | Record<string, any> | undefined,
    expectedSourceType: 'string' | 'model' | 'any' = 'any',
  ): Source<any> | undefined {
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
            session: Session<TVars, TAttrs>,
          ): Promise<ModelOutput> {
            const interpolatedContent = interpolateTemplate(
              input,
              session.vars,
            );
            return { content: interpolatedContent };
          },
        } as Source<ModelOutput>;
      } else {
        return new StaticSource(input);
      }
    }

    // Handle plain objects that might be LLMOptions
    if (typeof input === 'object' && input !== null) {
      if (expectedSourceType === 'string') {
        throw new Error('Object cannot be used for a string-based source.');
      }

      // For Assistant templates, we no longer support GenerateOptions
      // Users should use Source.llm() instead
      throw new Error(
        'Object parameters are no longer supported. Please use Source.llm() for LLM-based content generation.',
      );
    }

    throw new Error(
      `Unsupported input type for content source: ${typeof input}`,
    );
  }
}
