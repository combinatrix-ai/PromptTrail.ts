import type { Session, Vars } from '../../session';
import type { Template } from '../base';
import { Composite } from './composite';

/**
 * A template that executes a sequence of templates in order.
 * @template TVars - The context type.
 * @extends Composite<TVars>
 * @class
 * @public
 * @remarks
 * This class allows for the creation and execution of a sequence of templates,
 * enabling complex template compositions.
 */
export class Sequence<TVars extends Vars = Vars> extends Composite<TVars> {
  /**
   * Creates a new Sequence template.
   * @param templates - Optional array of templates to execute in sequence
   */
  constructor(templates?: Template<TVars>[]) {
    super();
    if (templates) {
      this.templates = [...templates];
    }

    return this;
  }

  loopIf(condition: (session: Session<TVars>) => boolean): this {
    this.loopCondition = condition;
    return this;
  }

  getManifestDescriptor() {
    return {
      kind: 'template',
      templateType: 'Sequence',
      templates: this.templates,
      loopIf: this.loopCondition,
      maxIterations: this.maxIterations,
    };
  }
}
