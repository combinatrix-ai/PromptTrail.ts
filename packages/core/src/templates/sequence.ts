import type { Session } from '../types';
import type { Template } from './interfaces';
import { CompositeTemplateBase } from './composite_base';

/**
 * A template that executes a sequence of templates in order.
 * @template T - Type of the session metadata
 */
export class Sequence<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends CompositeTemplateBase<T, T> {
  /**
   * Creates a new Sequence template.
   * @param templates - Optional array of templates to execute in sequence
   */
  constructor(templates?: Template<any, any>[]) {
    super();
    if (templates) {
      this.templates = [...templates];
    }
  }

}
