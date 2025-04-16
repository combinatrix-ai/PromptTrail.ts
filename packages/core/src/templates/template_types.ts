import type { Session } from '../types';
import type { Template } from './interfaces';

/**
 * Type definition for transform functions
 */
export type TTransformFunction<
  T extends Record<string, unknown> = Record<string, unknown>,
> = (session: Session<T>) => Session<any> | Promise<Session<any>>;

/**
 * Options for configuring the SubroutineTemplate.
 */
export interface ISubroutineTemplateOptions<
  P extends Record<string, unknown> = Record<string, unknown>,
  S extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * A function to initialize the session for the subroutine based on the parent session.
   * Defaults to cloning the parent session's messages and metadata.
   * If `isolatedContext` is true, this function is ignored and a new empty session is created.
   * @param parentSession The parent session (ISession<P>).
   * @returns The initial session for the subroutine (ISession<S>).
   */
  initWith?: (parentSession: Session<P>) => Session<S>;

  /**
   * A function to merge the final session of the subroutine back into the parent session.
   * Defaults to merging messages (if `retainMessages` is true) and metadata.
   * If `isolatedContext` is true, this function is ignored for metadata merging,
   * and messages are only merged if `retainMessages` is explicitly true.
   * @param parentSession The original parent session (ISession<P>).
   * @param subroutineSession The final session after the subroutine execution (ISession<S>).
   * @returns The merged session (ISession<P>).
   */
  squashWith?: (
    parentSession: Session<P>,
    subroutineSession: Session<S>,
  ) => Session<P>;

  /**
   * If true, messages generated within the subroutine are retained in the final merged session.
   * Defaults to true.
   * This influences the default `squashWith` behavior.
   */
  retainMessages?: boolean;

  /**
   * If true, the subroutine executes in an isolated context. It does not inherit
   * metadata from the parent session, and its generated metadata is not merged back.
   * Messages might still be merged based on `retainMessages`.
   * Defaults to false.
   * This influences the default `initWith` and `squashWith` behavior.
   */
  isolatedContext?: boolean;

  /**
   * Optional identifier for the template.
   */
  id?: string;
}