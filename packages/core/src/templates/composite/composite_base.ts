import type { Session } from '../../session';
import { BaseTemplate, type Template } from '../base';
import type { Source, ModelOutput } from '../../content_source';
import type { GenerateOptions } from '../../generate_options';
import type {
  TTransformFunction,
  ISubroutineTemplateOptions,
} from '../template_types';
import { Context, Metadata } from '../../taggedRecord';
import { User } from '../primitives/user';
import { Assistant } from '../primitives/assistant';

/**
 * Base class for composite templates (Sequence, Loop, Subroutine)
 * Provides common functionality and a unified execution model
 */

export abstract class CompositeTemplateBase<
  TMetadata extends Metadata,
  TContext extends Context,
> extends BaseTemplate<TMetadata, TContext> {
  // Common properties - protected so derived classes can access them
  protected templates: Template<any, any>[] = [];
  protected initFunction?: (
    session: Session<TContext, TMetadata>,
  ) => Session<TContext, TMetadata>;
  protected squashFunction?: (
    parentSession: Session<TContext, TMetadata>,
    childSession: Session<TContext, TMetadata>,
  ) => Session<TContext, TMetadata>;
  protected loopCondition?: (session: Session<TContext, TMetadata>) => boolean;
  protected maxIterations: number = 100;
  protected defaultUserContentSource?: Source<any>;
  protected defaultAssistantContentSource?: Source<any>;

  // Common template management method
  add(template: Template<TMetadata, TContext>): this {
    this.templates.push(template);
    return this;
  }

  // Set default content sources for the template
  // Priority: this.contentSource > content source passed by the parent
  // If child template is a CompositeTemplate, pass the default too
  ensureTemplateHasContentSource(
    template: Template<TMetadata, TContext>,
  ): Template<TMetadata, TContext> {
    if (template instanceof CompositeTemplateBase) {
      // Pass default content sources to child CompositeTemplates
      if (template.defaultAssistantContentSource) {
        this.defaultAssistantContentSource =
          template.defaultAssistantContentSource;
      }
      if (template.defaultUserContentSource) {
        this.defaultUserContentSource = template.defaultUserContentSource;
      } else {
        // UserTemplate
        if (template instanceof User) {
          if (!template.getContentSource()) {
            template.contentSource = this.defaultUserContentSource;
          }
        }
        // AssistantTemplate
        else if (template instanceof Assistant) {
          if (!template.getContentSource()) {
            template.contentSource = this.defaultAssistantContentSource;
          }
        }
      }
    }
    return template;
  }

  // Factory methods will be added by the factory module
  // Unified execute implementation
  async execute(
    session?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>> {
    const originalSession = this.ensureSession(session);

    // Validate that we have templates to execute
    if (this.templates.length === 0) {
      // For Loop templates, throw an error
      if (this.constructor.name === 'Loop') {
        throw new Error('LoopTemplate requires a bodyTemplate.');
      }
      // For other templates, just return the original session
      return originalSession;
    }

    // 1. Initialize session (if initFunction provided)
    let currentSession = this.initFunction
      ? this.initFunction(originalSession)
      : originalSession;

    // 2. Execute templates (with optional looping)
    if (this.loopCondition !== undefined) {
      // Loop execution
      let iterations = 0;

      // Check if the loopCondition is a function
      if (typeof this.loopCondition !== 'function') {
        // If no exit condition is provided, execute once and warn
        if (this.constructor.name === 'Loop') {
          console.warn(
            'LoopTemplate executed without an exit condition. Executing once.',
          );
        }
        for (let template of this.templates) {
          template = this.ensureTemplateHasContentSource(template);
          currentSession = await template.execute(currentSession);
        }
      } else {
        // Execute the loop until the exit condition is met or max iterations reached
        while (
          iterations < this.maxIterations &&
          !this.loopCondition(currentSession)
        ) {
          for (let template of this.templates) {
            template = this.ensureTemplateHasContentSource(template);
            currentSession = await template.execute(currentSession);
          }
          iterations++;
        }

        if (iterations >= this.maxIterations) {
          if (this.constructor.name === 'Loop') {
            console.warn(
              `LoopTemplate reached maximum iterations (${this.maxIterations}). Exiting.`,
            );
          } else {
            console.warn(
              `Loop reached maximum iterations (${this.maxIterations}). Exiting.`,
            );
          }
        }
      }
    } else {
      // Simple sequence execution
      for (let template of this.templates) {
        template = this.ensureTemplateHasContentSource(template);
        currentSession = await template.execute(currentSession);
      }
    }

    // 3. Apply squash function (if provided)
    return this.squashFunction
      ? this.squashFunction(originalSession, currentSession)
      : currentSession;
  }
}

/**
 * Interface for factory methods that can be added to CompositeTemplateBase
 */
export interface ICompositeTemplateFactoryMethods<
  TMetadata extends Metadata,
  TContext extends Context,
> {
  addSystem(content: string | Source<string>): this;
  addUser(content: string | Source<string>): this;
  addAssistant(content: string | Source<ModelOutput> | GenerateOptions): this;
  addTransform(transformFn: TTransformFunction<TMetadata, TContext>): this;
  addIf(
    condition: (session: Session<TContext, TMetadata>) => boolean,
    thenTemplate: Template<TMetadata, TContext>,
    elseTemplate?: Template<TMetadata, TContext>,
  ): this;
  addLoop(
    bodyTemplate: Template<TMetadata, TContext>,
    exitCondition: (session: Session<TContext, TMetadata>) => boolean,
  ): this;
  addSubroutine(
    templateOrTemplates:
      | Template<TMetadata, TContext>
      | Template<TMetadata, TContext>[],
    options?: ISubroutineTemplateOptions<TMetadata, TContext>,
  ): this;
}
