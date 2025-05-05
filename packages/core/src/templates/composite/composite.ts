import type { Session } from '../../session';
import { TemplateBase, type Template } from '../base';
import type { Source } from '../../content_source';
import { Context, Metadata } from '../../taggedRecord';
import { User } from '../primitives/user';
import { Assistant } from '../primitives/assistant';
import { Fluent } from './chainable';

/**
 * Base class for composite templates (Sequence, Loop, Subroutine)
 * Provides common functionality and a unified execution model
 */
export abstract class Composite<
    TMetadata extends Metadata = Metadata,
    TContext extends Context = Context,
  >
  extends TemplateBase<TMetadata, TContext>
  implements Fluent<TMetadata, TContext>
{
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

  setMaxIterations(maxIterations: number): this {
    this.maxIterations = maxIterations;
    return this;
  }

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
    if (template instanceof Composite) {
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

      // Execute the loop until the exit condition is met or max iterations reached
      while (
        iterations < this.maxIterations &&
        this.loopCondition(currentSession)
      ) {
        for (let template of this.templates) {
          template = this.ensureTemplateHasContentSource(template);
          currentSession = await template.execute(currentSession);
        }
        iterations++;
      }

      if (iterations >= this.maxIterations) {
        console.warn(
          `LoopTemplate reached maximum iterations (${this.maxIterations}). Exiting.`,
        );
      }
    } else {
      // If this instance is a Loop, warn if no loop condition is provided
      if (this.constructor.name === 'Loop') {
        console.warn('LoopTemplate executed without an loopIf condition.');
      }
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
