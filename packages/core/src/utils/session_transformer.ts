import type { Session } from '../types';

/**
 * Session transformer interface for transforming sessions
 */
export interface SessionTransformer<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> {
  transform(
    session: Session<TInput>,
  ): Promise<Session<TOutput>> | Session<TOutput>;
}

/**
 * Function-based session transformer
 */
export type SessionTransformerFn<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> = (session: Session<TInput>) => Promise<Session<TOutput>> | Session<TOutput>;

/**
 * Create a transformer from a function
 */
export function createTransformer<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
>(
  transformFn: SessionTransformerFn<TInput, TOutput>,
): SessionTransformer<TInput, TOutput> {
  return {
    transform: (session) => transformFn(session),
  };
}
