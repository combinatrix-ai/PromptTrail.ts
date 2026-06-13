import type { Session } from '../session';
import type { Vars } from '../session';

/**
 * Type definition for transform functions
 */
export type TransformFn<TVars extends Vars> = (
  session: Session<TVars>,
) => Session<TVars>;

/**
 * Options for configuring the SubroutineTemplate.
 */
export interface ISubroutineTemplateOptions<TVars extends Vars> {
  /**
   * Entry projection for the subroutine session.
   *
   * Defaults to a fresh empty session with fresh vars. System prompts and
   * other required context must be re-established inside the subroutine or
   * explicitly passed through this projection.
   *
   * @param parentSession The parent session (Session<P>).
   * @returns The initial session for the subroutine (Session<S>).
   */
  init?: (parentSession: Session<TVars>) => Session<TVars>;

  /**
   * Exit projection for merging the final subroutine session back into the
   * parent session.
   *
   * Defaults to appending only messages added by the subroutine to the parent
   * messages while keeping parent vars unchanged.
   *
   * @param parentSession The original parent session (Session<P>).
   * @param subroutineSession The final session after the subroutine execution (Session<S>).
   * @returns The merged session (Session<P>).
   */
  squash?: (
    parentSession: Session<TVars>,
    subroutineSession: Session<TVars>,
  ) => Session<TVars>;

  /**
   * Optional identifier for the template.
   */
  id?: string;
}
