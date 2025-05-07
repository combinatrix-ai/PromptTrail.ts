import { Session } from '../../session';
import { Context, Metadata } from '../../tagged_record';
import type { Template } from '../base';
import { Composite } from './composite';

/**
 * A template that executes a sequence of templates in order.
 * @template TMetadata - The metadata type.
 * @template TContext - The context type.
 * @extends Composite<TMetadata, TContext>
 * @class
 * @public
 * @remarks
 * This class allows for the creation and execution of a sequence of templates,
 * enabling complex template compositions.
 */
export class Sequence<
  TMetadata extends Metadata = Metadata,
  TContext extends Context = Context,
> extends Composite<TMetadata, TContext> {
  /**
   * Creates a new Sequence template.
   * @param templates - Optional array of templates to execute in sequence
   */
  constructor(templates?: Template<TMetadata, TContext>[]) {
    super();
    if (templates) {
      this.templates = [...templates];
    }

    return this;
  }

  loopIf(condition: (session: Session<TContext, TMetadata>) => boolean): this {
    this.loopCondition = condition;
    return this;
  }
}
