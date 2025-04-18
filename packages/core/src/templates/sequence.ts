import type { Session } from '../types';
import type { Template } from './base';
import { CompositeTemplateBase } from './base';
import { addFactoryMethods, ICompositeTemplateFactoryMethods } from './composite_base';

/**
 * A template that executes a sequence of templates in order.
 * @template T - Type of the session metadata
 */
export class Sequence<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends CompositeTemplateBase<T, T> implements ICompositeTemplateFactoryMethods<Sequence<T>> {
  /**
   * Creates a new Sequence template.
   * @param templates - Optional array of templates to execute in sequence
   */
  constructor(templates?: Template<any, any>[]) {
    super();
    if (templates) {
      this.templates = [...templates];
    }

    // Add factory methods
    return addFactoryMethods(this);
  }

  // Declare the factory methods to satisfy TypeScript
  addSystem!: (content: string | import('../content_source').Source<string>) => this;
  addUser!: (content: string | import('../content_source').Source<string>) => this;
  addAssistant!: (content: string | import('../content_source').Source<import('../content_source').ModelOutput> | import('../generate_options').GenerateOptions) => this;
  addTransform!: (transformFn: import('./template_types').TTransformFunction<any>) => this;
  addIf!: (
    condition: (session: Session) => boolean,
    thenTemplate: Template<any, any>,
    elseTemplate?: Template<any, any>,
  ) => this;
  addLoop!: (
    bodyTemplate: Template<any, any>,
    exitCondition: (session: Session) => boolean,
  ) => this;
  addSubroutine!: (
    templateOrTemplates: Template<any, any> | Template<any, any>[],
    options?: import('./template_types').ISubroutineTemplateOptions<any, any>,
  ) => this;
}
