import type { Session } from '../../session';
import { Context, Metadata } from '../../taggedRecord';
import type { Template } from '../base';
import { CompositeTemplateBase } from './composite_base';

/**
 * A template that executes its body templates repeatedly until a condition is met.
 * @template TMetadata - Type of the session metadata.
 * @template TContext - Type of the session context.
 * @class
 * @public
 * @remarks
 * This class allows for the creation and execution of a loop of templates,
 * enabling repeated execution until a specified condition is met.
 */
export class Loop<
  TMetadata extends Metadata,
  TContext extends Context,
> extends CompositeTemplateBase<TMetadata, TContext> {
  // implements ICompositeTemplateFactoryMethods<TMetadata, TContext>
  /**
   * Creates a new Loop template.
   * @param options - Configuration options for the loop
   */
  constructor(
    options: {
      bodyTemplate?: Template<any, any>;
      exitCondition?: (session: Session<TContext, TMetadata>) => boolean;
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
   * @param condition - Function that evaluates the session and returns true when the loop should exit
   * @returns This instance for method chaining
   */
  setLoopIf(
    condition: (session: Session<TContext, TMetadata>) => boolean,
  ): this {
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

  // // Declare the factory methods to satisfy TypeScript
  // addSystem!: (
  //   content: string | import('../content_source').Source<string>,
  // ) => this;
  // addUser!: (
  //   content: string | import('../content_source').Source<string>,
  // ) => this;
  // addAssistant!: (
  //   content:
  //     | string
  //     | import('../content_source').Source<
  //         import('../content_source').ModelOutput
  //       >
  //     | import('../generate_options').GenerateOptions,
  // ) => this;
  // addTransform!: (
  //   transformFn: import('./template_types').TTransformFunction<
  //     TMetadata,
  //     TContext
  //   >,
  // ) => this;
  // addIf!: (
  //   condition: (session: Session<TContext, TMetadata>) => boolean,
  //   thenTemplate: Template<any, any>,
  //   elseTemplate?: Template<any, any>,
  // ) => this;
  // addLoop!: (
  //   bodyTemplate: Template<any, any>,
  //   exitCondition: (session: Session<TContext, TMetadata>) => boolean,
  // ) => this;
  // addSubroutine!: (
  //   templateOrTemplates: Template<any, any> | Template<any, any>[],
  //   options?: import('./template_types').ISubroutineTemplateOptions<any, any>,
  // ) => this;
}
