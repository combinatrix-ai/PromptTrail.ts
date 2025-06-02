import { Session } from '../session';
import type { Attrs, Vars } from '../session';

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
  abstract execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>>;

  protected ensureSession(
    session?: Session<TVars, TAttrs>,
  ): Session<TVars, TAttrs> {
    return session || Session.create<TVars, TAttrs>();
  }
}
