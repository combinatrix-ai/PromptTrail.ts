import type { Session } from '../types';
import type { Template } from './base';
import { CompositeTemplateBase } from './base';
import { addFactoryMethods } from './composite_base';

/**
 * A template that executes its body templates repeatedly until a condition is met.
 * @template T - Type of the session metadata
 */
export class Loop<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends CompositeTemplateBase<T, T> {
  /**
   * Creates a new Loop template.
   * @param options - Configuration options for the loop
   */
  constructor(
    options: {
      bodyTemplate?: Template<any, any>;
      exitCondition?: (session: Session<T>) => boolean;
      maxIterations?: number;
    } = {},
  ) {
    super();
    if (options.bodyTemplate) {
      this.templates = [options.bodyTemplate];
    }
    if (options.exitCondition) {
      this.loopCondition = options.exitCondition;
    } else {
      // Set loopCondition to a non-function value to trigger the warning
      this.loopCondition = null as any;
    }
    if (options.maxIterations !== undefined) {
      this.maxIterations = options.maxIterations;
    }

    // Add factory methods
    return addFactoryMethods(this);
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
   * @param condition - Function that evaluates the session and returns true when the loop should exit
   * @returns This instance for method chaining
   */
  setLoopIf(condition: (session: Session<T>) => boolean): this {
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
