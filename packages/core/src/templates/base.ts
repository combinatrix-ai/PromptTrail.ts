import type { MessageMetadata, SessionContext } from '../session';
import { Session } from '../session';

export interface Template<
  TMetadata extends MessageMetadata = Record<string, any>,
  TContext extends SessionContext = Record<string, any>,
> {
  execute(
    session?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>>;
}

export abstract class TemplateBase<
  TMetadata extends MessageMetadata = Record<string, any>,
  TContext extends SessionContext = Record<string, any>,
> implements Template<TMetadata, TContext>
{
  abstract execute(
    session?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>>;

  protected ensureSession(
    session?: Session<TContext, TMetadata>,
  ): Session<TContext, TMetadata> {
    return session || Session.create<TContext, TMetadata>();
  }
}
