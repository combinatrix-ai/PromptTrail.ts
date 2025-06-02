import type { Message } from '../../message';
import { Session } from '../../session';
import type { Attrs, Vars } from '../../session';
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
 * It provides options for retaining messages, isolating context, and defining
 * initialization and squashing functions for the subroutine execution.
 */
export class Subroutine<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends Composite<TAttrs, TVars> {
  public readonly id?: string;
  private readonly retainMessages: boolean;
  private readonly isolatedContext: boolean;

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

    // Set options with defaults
    this.retainMessages = options?.retainMessages ?? true;
    this.isolatedContext = options?.isolatedContext ?? false;
    this.id = options?.id;

    // Set up init and squash functions
    if (options?.initWith) {
      this.initFunction = options.initWith;
    } else {
      // Default init function
      this.initFunction = (
        parentSession: Session<TVars, TAttrs>,
      ): Session<TVars, TAttrs> => {
        if (this.isolatedContext) {
          // Create a completely new, empty session for isolated context
          return Session.create<TVars, TAttrs>({});
        }

        // Default: Clone parent session messages and context
        const clonedContextObject =
          parentSession.getVarsObject() as unknown as TVars;
        let clonedSession = Session.create<TVars, TAttrs>({
          vars: clonedContextObject,
        });

        // Add messages immutably
        parentSession.messages.forEach((msg: Message<TAttrs>) => {
          clonedSession = clonedSession.addMessage(msg);
        });

        return clonedSession;
      };
    }

    if (options?.squashWith) {
      this.squashFunction = options.squashWith;
    } else {
      // Default squash function
      this.squashFunction = (
        parentSession: Session<TVars, TAttrs>,
        subroutineSession: Session<TVars, TAttrs>,
      ): Session<TVars, TAttrs> => {
        // Default merging logic
        let finalMessages = [...parentSession.messages];
        let finalMetadata = parentSession.getVarsObject();

        if (this.retainMessages) {
          // Append messages from the subroutine session that were added after
          // the messages potentially copied from the parent
          const parenMessageSet = new Set(parentSession.messages);
          const newMessages = subroutineSession.messages.filter(
            (msg) => !parenMessageSet.has(msg),
          );
          finalMessages = [...finalMessages, ...newMessages];
        }

        if (!this.isolatedContext) {
          // Merge metadata only if not isolated
          finalMetadata = {
            ...finalMetadata,
            ...subroutineSession.getVarsObject(),
          };
        }

        // Create a new session with the merged state
        let mergedSession = Session.create<TVars, TAttrs>({
          vars: finalMetadata as TVars,
        });

        // Add messages one by one
        finalMessages.forEach((msg: Message<TAttrs>) => {
          mergedSession = mergedSession.addMessage(msg);
        });

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
  initWith(
    fn: (parentSession: Session<TVars, TAttrs>) => Session<TVars, TAttrs>,
  ): this {
    this.initFunction = fn;
    return this;
  }

  /**
   * Sets the squash function for merging the subroutine session back into the parent session.
   * @param fn Function to merge the subroutine session into the parent session
   * @returns This instance for method chaining
   */
  squashWith(
    fn: (
      parentSession: Session<TVars, TAttrs>,
      subroutineSession: Session<TVars, TAttrs>,
    ) => Session<TVars, TAttrs>,
  ): this {
    this.squashFunction = fn;
    return this;
  }
}
