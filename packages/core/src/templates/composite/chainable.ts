import type { Session } from '../../session';
import { Attrs, Vars } from '../../tagged_record';
import type { Template } from '../base';

/**
 * Fluent interface is an interface marker that allow fluent method chaining
 * in the Agent.
 */
export interface Fluent<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>
  extends Template<TAttrs, TVars> {
  add(t: Template<TAttrs, TVars>): any;
  execute(s?: Session<TVars, TAttrs>): Promise<Session<TVars, TAttrs>>;
}
