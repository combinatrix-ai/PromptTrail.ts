import type { Attrs, Vars } from '../session';
import { Session } from '../session';

export interface Template<
  TAttrs extends Attrs = Record<string, any>,
  TVars extends Vars = Record<string, any>,
> {
  execute(session?: Session<TVars, TAttrs>): Promise<Session<TVars, TAttrs>>;
}

export abstract class TemplateBase<
  TAttrs extends Attrs = Record<string, any>,
  TVars extends Vars = Record<string, any>,
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
