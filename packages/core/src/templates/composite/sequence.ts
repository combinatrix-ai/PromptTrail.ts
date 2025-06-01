import { Session } from '../../session';
import { Attrs, Vars } from '../../session';
import type { Template } from '../base';
import { Composite } from './composite';

/**
 * A template that executes a sequence of templates in order.
 * @template TAttrs - The metadata type.
 * @template TVars - The context type.
 * @extends Composite<TAttrs, TVars>
 * @class
 * @public
 * @remarks
 * This class allows for the creation and execution of a sequence of templates,
 * enabling complex template compositions.
 */
export class Sequence<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends Composite<TAttrs, TVars> {
  /**
   * Creates a new Sequence template.
   * @param templates - Optional array of templates to execute in sequence
   */
  constructor(templates?: Template<TAttrs, TVars>[]) {
    super();
    if (templates) {
      this.templates = [...templates];
    }

    return this;
  }

  loopIf(condition: (session: Session<TVars, TAttrs>) => boolean): this {
    this.loopCondition = condition;
    return this;
  }
}
