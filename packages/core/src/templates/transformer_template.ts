import type { Session } from '../session';
import type { SessionTransformer } from '../utils/session_transformer';

/**
 * Create a template that applies a transformer to a session
 *
 * This is used internally by LinearTemplate.addTransformer
 *
 * @param transformer The transformer to apply
 * @returns A template-like object that can execute the transformer
 */
export function createTransformerTemplate<TInput extends Record<string, unknown>, TOutput extends Record<string, unknown>>(
  transformer: SessionTransformer<TInput, TOutput>,
) {
  return {
    execute: async (session: Session<TInput>): Promise<Session<TOutput>> => {
      return transformer.transform(session);
    },
  };
}
