import { Session } from '../../session';
import { Attrs, Vars } from '../../session';
import type { Template } from '../base';
import type { ISubroutineTemplateOptions } from '../template_types';
import { Composite } from './composite';

/**
 * A template that executes a list of templates (the subroutine) within a potentially
 * isolated or customized session context.
 *
 * This allows encapsulating complex logic, controlling context visibility, and
 * managing how results are integrated back into the main conversation flow.
 *
 * @template TAttrs - Type of the session metadata.
 * @template TVars - Type of the session context.
 * @extends Composite<TAttrs, TVars>
 * @class
 * @public
 * @remarks
 * This class allows for the creation and execution of a subroutine of templates,
 * enabling complex template compositions with customizable context management.
 * It provides entry (`init`) and exit (`squash`) projections for controlling
 * subroutine isolation. By default, subroutines enter a fresh session and
 * append only messages produced inside the subroutine back to the parent while
 * keeping parent vars unchanged.
 */
export class Subroutine<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends Composite<TAttrs, TVars> {
  public readonly id?: string;
  private initialMessageCount = 0;

  /**
   * Creates an instance of SubroutineTemplate.
   * @param templateOrTemplates The inner template(s) (subroutine) to execute.
   * @param options Configuration options for the subroutine execution and context management.
   */
  constructor(
    templateOrTemplates?: Template<TAttrs, TVars> | Template<TAttrs, TVars>[],
    options?: ISubroutineTemplateOptions<TAttrs, TVars>,
  ) {
    super();

    this.id = options?.id;

    // Set up init and squash functions
    if (options?.init) {
      this.initFunction = (parentSession) => {
        const initialSession = options.init!(parentSession);
        this.initialMessageCount = initialSession.messages.length;
        return initialSession;
      };
    } else {
      // Default init function
      this.initFunction = (): Session<TVars, TAttrs> => {
        this.initialMessageCount = 0;
        return Session.create<TVars, TAttrs>();
      };
    }

    if (options?.squash) {
      this.squashFunction = options.squash;
    } else {
      // Default squash function
      this.squashFunction = (
        parentSession: Session<TVars, TAttrs>,
        subroutineSession: Session<TVars, TAttrs>,
      ): Session<TVars, TAttrs> => {
        let mergedSession = Session.create<TVars, TAttrs>({
          vars: parentSession.getVarsObject() as TVars,
        });

        for (const msg of [
          ...parentSession.messages,
          ...subroutineSession.messages.slice(this.initialMessageCount),
        ]) {
          mergedSession = mergedSession.addMessage(msg);
        }

        return mergedSession;
      };
    }

    // Initialize templates array
    if (templateOrTemplates) {
      if (Array.isArray(templateOrTemplates)) {
        this.templates = [...templateOrTemplates];
      } else {
        this.templates = [templateOrTemplates];
      }
    }

    return this;
  }

  /**
   * Sets the initialization function for the subroutine.
   * @param fn Function to initialize the subroutine session from the parent session
   * @returns This instance for method chaining
   */
  init(
    fn: (parentSession: Session<TVars, TAttrs>) => Session<TVars, TAttrs>,
  ): this {
    this.initFunction = (parentSession) => {
      const initialSession = fn(parentSession);
      this.initialMessageCount = initialSession.messages.length;
      return initialSession;
    };
    return this;
  }

  /**
   * Sets the squash function for merging the subroutine session back into the parent session.
   * @param fn Function to merge the subroutine session into the parent session
   * @returns This instance for method chaining
   */
  squash(
    fn: (
      parentSession: Session<TVars, TAttrs>,
      subroutineSession: Session<TVars, TAttrs>,
    ) => Session<TVars, TAttrs>,
  ): this {
    this.squashFunction = fn;
    return this;
  }

  getManifestDescriptor() {
    return {
      kind: 'template',
      templateType: 'Subroutine',
      id: this.id,
      templates: this.templates,
      init: this.initFunction,
      squash: this.squashFunction,
    };
  }
}
