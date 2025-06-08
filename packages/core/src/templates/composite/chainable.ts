import type { MessageMetadata, Session, SessionContext } from '../../session';
import type { Template } from '../base';

/**
 * Fluent interface is an interface marker that allow fluent method chaining
 * in the Agent.
 */
export interface Fluent<
  TMetadata extends MessageMetadata = Record<string, any>,
  TContext extends SessionContext = Record<string, any>,
> extends Template<TMetadata, TContext> {
  then(t: Template<TMetadata, TContext>): any;
  execute(
    s?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>>;
}
