import type { Session, Vars } from '../../session';
import type { ExecutionRuntimeState } from '../../interceptors';
import type { Template } from '../base';

/**
 * Fluent interface is an interface marker that allow fluent method chaining
 * in the Agent.
 */
export interface Fluent<TVars extends Vars = Vars> extends Template<TVars> {
  add(t: Template<TVars>): any;
  execute(
    s?: Session<TVars>,
    runtime?: ExecutionRuntimeState<TVars>,
  ): Promise<Session<TVars>>;
}
