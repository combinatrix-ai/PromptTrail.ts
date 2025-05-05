import type { Session } from '../../session';
import { Metadata, Context } from '../../taggedRecord';
import type { Template } from '../base';

/**
 * Fluent interface is an interface marker that allow fluent method chaining
 * in the Agent.
 */
export interface Fluent<
  TMetadata extends Metadata = Metadata,
  TContext extends Context = Context,
> extends Template<TMetadata, TContext> {
  add(t: Template<TMetadata, TContext>): any;
  execute(
    s?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>>;
}
