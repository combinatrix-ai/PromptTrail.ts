import type { Session } from '../../session';
import type { Source } from '../../source';
import {
  runRuntimeExecutionPhase,
  type ExecutionRuntimeState,
} from '../../interceptors';
import type { ResolvedExecutionCommand } from '../../execution';
import { Attrs, Vars } from '../../session';
import { TemplateBase, type Template } from '../base';
import { Assistant } from '../primitives/assistant';
import { User } from '../primitives/user';
import { Fluent } from './chainable';

/**
 * Base class for composite templates (Sequence, Loop, Subroutine)
 * Provides common functionality and a unified execution model
 */
export abstract class Composite<
    TAttrs extends Attrs = Attrs,
    TVars extends Vars = Vars,
  >
  extends TemplateBase<TAttrs, TVars>
  implements Fluent<TAttrs, TVars>
{
  protected templates: Template<any, any>[] = [];
  protected initFunction?: (
    session: Session<TVars, TAttrs>,
  ) => Session<TVars, TAttrs>;
  protected squashFunction?: (
    parentSession: Session<TVars, TAttrs>,
    childSession: Session<TVars, TAttrs>,
  ) => Session<TVars, TAttrs>;
  protected loopCondition?: (session: Session<TVars, TAttrs>) => boolean;
  protected maxIterations: number = 100;
  protected defaultUserContentSource?: Source<any>;
  protected defaultAssistantContentSource?: Source<any>;

  setMaxIterations(maxIterations: number): this {
    this.maxIterations = maxIterations;
    return this;
  }

  add(template: Template<TAttrs, TVars>): this {
    this.templates.push(template);
    return this;
  }

  /**
   * Expose child templates to the legacy-to-graph compiler without routing
   * execution through the generic template adapter.
   *
   * @internal
   */
  getTemplates(): Template<TAttrs, TVars>[] {
    return [...this.templates];
  }

  /**
   * @internal
   */
  getLoopCondition():
    | ((session: Session<TVars, TAttrs>) => boolean)
    | undefined {
    return this.loopCondition;
  }

  /**
   * @internal
   */
  getMaxIterations(): number {
    return this.maxIterations;
  }

  /**
   * @internal
   */
  getInitFunction():
    | ((session: Session<TVars, TAttrs>) => Session<TVars, TAttrs>)
    | undefined {
    return this.initFunction;
  }

  /**
   * @internal
   */
  getSquashFunction():
    | ((
        parentSession: Session<TVars, TAttrs>,
        childSession: Session<TVars, TAttrs>,
      ) => Session<TVars, TAttrs>)
    | undefined {
    return this.squashFunction;
  }

  // Set default content sources for the template
  // Priority: this.contentSource > content source passed by the parent
  // If child template is a CompositeTemplate, pass the default too
  ensureTemplateHasContentSource(
    template: Template<TAttrs, TVars>,
  ): Template<TAttrs, TVars> {
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
    session?: Session<TVars, TAttrs>,
    runtime?: ExecutionRuntimeState<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
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
    let halted = false;

    // 2. Execute templates (with optional looping)
    if (this.loopCondition !== undefined) {
      // Loop execution
      let iterations = 0;

      // Execute the loop until the exit condition is met or max iterations reached
      while (
        !halted &&
        iterations < this.maxIterations &&
        this.loopCondition(currentSession)
      ) {
        for (let index = 0; index < this.templates.length; index++) {
          let template = this.templates[index];
          template = this.ensureTemplateHasContentSource(template);
          const before = await runTemplateLifecyclePhase(
            runtime,
            'beforeTemplate',
            currentSession,
            template,
            index,
          );
          currentSession = before.session;
          if (before.halted) {
            halted = true;
            break;
          }
          currentSession = await template.execute(currentSession, runtime);
          const after = await runTemplateLifecyclePhase(
            runtime,
            'afterTemplate',
            currentSession,
            template,
            index,
          );
          currentSession = after.session;
          if (after.halted) {
            halted = true;
            break;
          }
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
      for (let index = 0; index < this.templates.length; index++) {
        let template = this.templates[index];
        template = this.ensureTemplateHasContentSource(template);
        const before = await runTemplateLifecyclePhase(
          runtime,
          'beforeTemplate',
          currentSession,
          template,
          index,
        );
        currentSession = before.session;
        if (before.halted) {
          halted = true;
          break;
        }
        currentSession = await template.execute(currentSession, runtime);
        const after = await runTemplateLifecyclePhase(
          runtime,
          'afterTemplate',
          currentSession,
          template,
          index,
        );
        currentSession = after.session;
        if (after.halted) {
          halted = true;
          break;
        }
      }
    }

    // 3. Apply squash function (if provided)
    return this.squashFunction
      ? this.squashFunction(originalSession, currentSession)
      : currentSession;
  }
}

async function runTemplateLifecyclePhase<
  TAttrs extends Attrs,
  TVars extends Vars,
>(
  runtime: ExecutionRuntimeState<TVars, TAttrs> | undefined,
  phase: 'beforeTemplate' | 'afterTemplate',
  session: Session<TVars, TAttrs>,
  template: Template<TAttrs, TVars>,
  templateIndex: number,
): Promise<{ session: Session<TVars, TAttrs>; halted: boolean }> {
  if (!runtime) {
    return { session, halted: false };
  }
  const result = await runRuntimeExecutionPhase(runtime, {
    phase,
    session,
    request: {
      templateIndex,
      templateName: template.constructor.name,
    },
  });
  return {
    session: result.session,
    halted: handleTemplateLifecycleCommand(result.command),
  };
}

function handleTemplateLifecycleCommand(command: ResolvedExecutionCommand) {
  if (command.type === 'none') {
    return false;
  }
  if (command.type === 'halt') {
    return true;
  }
  throw new Error(
    `Template lifecycle does not support execution command ${command.type} yet.`,
  );
}
