import type { Session } from '../../session';
import type { Attrs, Vars } from '../../session';
import type { Template } from '../base';
import { Composite } from './composite';

/**
 * A template that executes its body templates repeatedly until a condition is met.
 * @template TAttrs - Type of the session metadata.
 * @template TVars - Type of the session context.
 * @class
 * @public
 * @remarks
 * This class allows for the creation and execution of a loop of templates,
 * enabling repeated execution until a specified condition is met.
 */
export class Loop<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends Composite<TAttrs, TVars> {
  // implements ICompositeTemplateFactoryMethods<TAttrs, TVars>
  /**
   * Creates a new Loop template.
   * @param options - Configuration options for the loop
   */
  constructor(
    options: {
      bodyTemplate?: Template<any, any> | Template<any, any>[];
      // Do not make loopIf optional, to prevent unwanted infinite loops
      loopIf?: (session: Session<TVars, TAttrs>) => boolean;
      maxIterations?: number;
    } = {},
  ) {
    super();
    if (Array.isArray(options.bodyTemplate)) {
      this.templates = options.bodyTemplate;
    } else if (options.bodyTemplate) {
      this.templates = [options.bodyTemplate];
    }
    this.loopCondition = options.loopIf;

    if (options.maxIterations !== undefined) {
      this.maxIterations = options.maxIterations;
    }

    // Add factory methods
    // return addFactoryMethods(this, TemplateFactory);
    return this;
  }

  /**
   * Sets the body template to execute in each iteration.
   * @param template - The template to execute
   * @returns This instance for method chaining
   */
  setBody(template: Template<any, any>): this {
    this.templates = [template];
    return this;
  }

  /**
   * Sets the condition that determines when to exit the loop.
   * The loop continues as long as the condition returns false.
   * @param condition - Function that evaluates the session and returns true when the loop should continue
   * @returns This instance for method chaining
   */
  setLoopIf(condition: (session: Session<TVars, TAttrs>) => boolean): this {
    this.loopCondition = condition;
    return this;
  }

  /**
   * Sets the maximum number of iterations to prevent infinite loops.
   * @param maxIterations - Maximum number of iterations
   * @returns This instance for method chaining
   */
  setMaxIterations(maxIterations: number): this {
    this.maxIterations = maxIterations;
    return this;
  }
}
