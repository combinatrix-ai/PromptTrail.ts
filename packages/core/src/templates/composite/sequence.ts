import { Context, Metadata } from '../../taggedRecord';
import type { Template } from '../base';
import { CompositeTemplateBase } from './composite_base';

/**
 * A template that executes a sequence of templates in order.
 * @template TMetadata - The metadata type.
 * @template TContext - The context type.
 * @extends CompositeTemplateBase<TMetadata, TContext>
 * @class
 * @public
 * @remarks
 * This class allows for the creation and execution of a sequence of templates,
 * enabling complex template compositions.
 */
export class Sequence<
  TMetadata extends Metadata,
  TContext extends Context,
> extends CompositeTemplateBase<TMetadata, TContext> {
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
}
