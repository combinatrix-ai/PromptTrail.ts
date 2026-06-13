import { Session } from '../session';
import type { ExecutionRuntimeState } from '../interceptors';
import type { LlmSource, ModelOutput } from '../source';
import { LiteralSource, Source } from '../source';
import type { Vars } from '../session';
import { interpolateTemplate } from '../utils/template_interpolation';

/**
 * Core template interface
 * TVars: Session context type, must extend Record<string, unknown>
 */
export interface Template<TVars extends Vars = Vars> {
  execute(
    session?: Session<TVars>,
    runtime?: ExecutionRuntimeState<TVars>,
  ): Promise<Session<TVars>>;
}

/**
 * Base template class with composition methods
 */
export abstract class TemplateBase<TVars extends Vars = Vars>
  implements Template<TVars>
{
  protected contentSource?: Source<unknown>;

  abstract execute(
    session?: Session<TVars>,
    runtime?: ExecutionRuntimeState<TVars>,
  ): Promise<Session<TVars>>;

  protected ensureSession(session?: Session<TVars>): Session<TVars> {
    return session || Session.create<TVars>();
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
          async getContent(session: Session<TVars>): Promise<ModelOutput> {
            const interpolatedContent = interpolateTemplate(
              input,
              session.vars,
            );
            return { content: interpolatedContent };
          },
          getManifestDescriptor() {
            return {
              kind: 'source',
              sourceType: 'StaticModelSource',
              config: { content: input },
            };
          },
        } as Source<ModelOutput>;
      } else {
        return new LiteralSource(input);
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
