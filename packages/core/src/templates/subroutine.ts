import { createSession } from '../session';
import type { ISession, Message, Session } from '../types';
import type { Template } from './interfaces';
import { CompositeTemplateBase } from './composite_base';

/**
 * Options for configuring the SubroutineTemplate.
 * @template P - Type of the parent session metadata (Record<string, unknown>).
 * @template S - Type of the subroutine session metadata (Record<string, unknown>).
 */
export interface ISubroutineTemplateOptions<
  P extends Record<string, unknown> = Record<string, unknown>,
  S extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * A function to initialize the session for the subroutine based on the parent session.
   * Defaults to cloning the parent session's messages and metadata.
   * If `isolatedContext` is true, this function is ignored and a new empty session is created.
   * @param parentSession The parent session (ISession<P>).
   * @returns The initial session for the subroutine (ISession<S>).
   */
  initWith?: (parentSession: ISession<P>) => ISession<S>;

  /**
   * A function to merge the final session of the subroutine back into the parent session.
   * Defaults to merging messages (if `retainMessages` is true) and metadata.
   * If `isolatedContext` is true, this function is ignored for metadata merging,
   * and messages are only merged if `retainMessages` is explicitly true.
   * @param parentSession The original parent session (ISession<P>).
   * @param subroutineSession The final session after the subroutine execution (ISession<S>).
   * @returns The merged session (ISession<P>).
   */
  squashWith?: (
    parentSession: ISession<P>,
    subroutineSession: ISession<S>,
  ) => ISession<P>;

  /**
   * If true, messages generated within the subroutine are retained in the final merged session.
   * Defaults to true.
   * This influences the default `squashWith` behavior.
   */
  retainMessages?: boolean;

  /**
   * If true, the subroutine executes in an isolated context. It does not inherit
   * metadata from the parent session, and its generated metadata is not merged back.
   * Messages might still be merged based on `retainMessages`.
   * Defaults to false.
   * This influences the default `initWith` and `squashWith` behavior.
   */
  isolatedContext?: boolean;

  /**
   * Optional identifier for the template.
   */
  id?: string;
}

/**
 * A template that executes a list of templates (the subroutine) within a potentially
 * isolated or customized session context.
 *
 * This allows encapsulating complex logic, controlling context visibility, and
 * managing how results are integrated back into the main conversation flow.
 *
 * @template P - Type of the parent session metadata (Record<string, unknown>).
 * @template S - Type of the subroutine session metadata (Record<string, unknown>).
 */
export class Subroutine<
  P extends Record<string, unknown> = Record<string, unknown>,
  S extends Record<string, unknown> = Record<string, unknown>,
> extends CompositeTemplateBase<P, P> {
  public readonly id?: string;
  private readonly retainMessages: boolean;
  private readonly isolatedContext: boolean;

  /**
   * Creates an instance of SubroutineTemplate.
   * @param templateOrTemplates The inner template(s) (subroutine) to execute.
   * @param options Configuration options for the subroutine execution and context management.
   */
  constructor(
    templateOrTemplates?: Template<S, S> | Template<any, any>[],
    options?: ISubroutineTemplateOptions<P, S>,
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
      this.initFunction = (parentSession: ISession<P>): ISession<S> => {
        if (this.isolatedContext) {
          // Create a completely new, empty session for isolated context
          return createSession<S>();
        }
        
        // Default: Clone parent session messages and metadata
        const clonedMetadataObject = parentSession.metadata.toObject() as unknown as S;
        let clonedSession = createSession<S>({ metadata: clonedMetadataObject });
        
        // Add messages immutably
        parentSession.messages.forEach((msg: Message) => {
          clonedSession = clonedSession.addMessage(msg);
        });
        
        return clonedSession;
      };
    }
    
    if (options?.squashWith) {
      this.squashFunction = options.squashWith;
    } else {
      // Default squash function
      this.squashFunction = (parentSession: ISession<P>, subroutineSession: ISession<S>): ISession<P> => {
        // Default merging logic
        let finalMessages = [...parentSession.messages];
        let finalMetadata = parentSession.metadata.toObject();
        
        if (this.retainMessages) {
          // Append messages from the subroutine session that were added after
          // the messages potentially copied from the parent
          const parentMessageSet = new Set(parentSession.messages);
          const newMessages = subroutineSession.messages.filter(
            (msg) => !parentMessageSet.has(msg),
          );
          finalMessages = [...finalMessages, ...newMessages];
        }
        
        if (!this.isolatedContext) {
          // Merge metadata only if not isolated
          finalMetadata = {
            ...finalMetadata,
            ...subroutineSession.metadata.toObject(),
          };
        }
        
        // Create a new session with the merged state
        let mergedSession = createSession<P>({ metadata: finalMetadata as P });
        
        // Add messages one by one
        finalMessages.forEach((msg: Message) => {
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
  }

  /**
   * Sets the initialization function for the subroutine.
   * @param fn Function to initialize the subroutine session from the parent session
   * @returns This instance for method chaining
   */
  initWith(fn: (parentSession: ISession<P>) => ISession<S>): this {
    this.initFunction = fn;
    return this;
  }

  /**
   * Sets the squash function for merging the subroutine session back into the parent session.
   * @param fn Function to merge the subroutine session into the parent session
   * @returns This instance for method chaining
   */
  squashWith(fn: (parentSession: ISession<P>, subroutineSession: ISession<S>) => ISession<P>): this {
    this.squashFunction = fn;
    return this;
  }
}
