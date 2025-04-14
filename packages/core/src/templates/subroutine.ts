import { createSession } from '../session';
import type { ISession, Message } from '../types'; // Import ISession and Message
import type { Template } from './interfaces'; // Use Template interface
import type { Metadata } from '../metadata'; // Use Metadata interface
import { createMetadata } from '../metadata';

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
 * A template that executes another template (the subroutine) within a potentially
 * isolated or customized session context.
 *
 * This allows encapsulating complex logic, controlling context visibility, and
 * managing how results are integrated back into the main conversation flow.
 *
 * @template P - Type of the parent session metadata (Record<string, unknown>).
 * @template S - Type of the subroutine session metadata (Record<string, unknown>).
 */
export class SubroutineTemplate<
  P extends Record<string, unknown> = Record<string, unknown>,
  S extends Record<string, unknown> = Record<string, unknown>,
> implements Template<P, P>
{
  // Output metadata type is P
  public readonly id?: string;
  private readonly template: Template<S, S>; // Use Template interface, assume subroutine output metadata is S
  private readonly options: ISubroutineTemplateOptions<P, S>;

  /**
   * Creates an instance of SubroutineTemplate.
   * @param template The inner template (subroutine) to execute.
   * @param options Configuration options for the subroutine execution and context management.
   */
  constructor(
    template: Template<S, S>,
    options?: ISubroutineTemplateOptions<P, S>,
  ) {
    this.template = template;
    this.options = {
      retainMessages: true, // Default: retain messages
      isolatedContext: false, // Default: share context
      ...options,
    };
    this.id = this.options.id;
  }

  /**
   * Executes the subroutine template.
   * @param parentSession The parent session context.
   * @returns The parent session updated according to the subroutine execution and merging logic.
   */
  async execute(parentSession: ISession<P>): Promise<ISession<P>> {
    // Return ISession<P>
    // 1. Initialize subroutine session
    const initialSubroutineSession =
      this.initializeSubroutineSession(parentSession);

    // 2. Execute the inner template
    const finalSubroutineSessionResult = await this.template.execute(
      initialSubroutineSession,
    );

    // Handle potential errors or early exits from the subroutine
    if (finalSubroutineSessionResult instanceof Error) {
      // Decide how to handle subroutine errors. Propagate? Log?
      // For now, let's propagate the error.
      // Re-throw the error to comply with the return type Promise<ISession<P>>
      console.error(
        `Subroutine execution failed: ${finalSubroutineSessionResult.message}`,
      );
      throw finalSubroutineSessionResult;
    }
    if (finalSubroutineSessionResult === null) {
      // Decide how to handle subroutine null exit. Maybe merge back the initial state?
      // For now, let's treat it as if the subroutine did nothing significant and merge back.
      console.warn('Subroutine returned null, merging back initial state.');
      // Fall through to merge logic, which will use the state before the subroutine potentially modified it.
      // This might need refinement based on desired behavior for null returns.
      // Let's use the session state *before* the subroutine potentially returned null.
      return this.mergeSessions(parentSession, initialSubroutineSession);
    }

    const finalSubroutineSession = finalSubroutineSessionResult;

    // 3. Merge results back into the parent session
    const finalParentSession = this.mergeSessions(
      parentSession,
      finalSubroutineSession,
    );

    return finalParentSession;
  }

  private initializeSubroutineSession(parentSession: ISession<P>): ISession<S> {
    if (this.options.isolatedContext) {
      // Create a completely new, empty session for isolated context
      // We cast the metadata type, assuming the inner template works with the specified S
      return createSession<S>();
    }

    if (this.options.initWith) {
      // Use the custom initializer
      return this.options.initWith(parentSession);
    }

    // Default: Clone parent session messages and metadata.
    // This assumes S is compatible with P or the user handles potential type issues.
    // Cast the parent metadata object to S. This might be unsafe if P and S differ significantly,
    // but it reflects the default intention of inheriting context.
    const clonedMetadataObject =
      parentSession.metadata.toObject() as unknown as S; // Cast via unknown
    let clonedSession = createSession<S>({ metadata: clonedMetadataObject });
    // Add messages immutably
    parentSession.messages.forEach((msg: Message) => {
      clonedSession = clonedSession.addMessage(msg);
    });
    return clonedSession;
  }

  private mergeSessions(
    parentSession: ISession<P>,
    subroutineSession: ISession<S>,
  ): ISession<P> {
    if (this.options.squashWith) {
      // Use the custom merger
      return this.options.squashWith(parentSession, subroutineSession);
    }

    // Default merging logic:
    let finalMessages = [...parentSession.messages]; // Use messages property
    let finalMetadata = parentSession.metadata.toObject(); // Use toObject()

    if (this.options.retainMessages) {
      // Append messages from the subroutine session that were added *after*
      // the messages potentially copied from the parent by initWith.
      // The simplest robust way is to find messages in subroutineSession
      // that are not present (by reference) in the original parentSession.
      const parentMessageSet = new Set(parentSession.messages);
      const newMessages = subroutineSession.messages.filter(
        (msg) => !parentMessageSet.has(msg),
      );
      finalMessages = [...finalMessages, ...newMessages]; // Append only new messages
    } else {
      // If not retaining messages, the final messages are just the parent's original messages.
      finalMessages = [...parentSession.messages];
    }

    if (!this.options.isolatedContext) {
      // Merge metadata only if not isolated
      // Default merge: Subroutine metadata overwrites parent metadata for conflicting keys
      // Default merge: Subroutine metadata overwrites parent metadata for conflicting keys
      finalMetadata = {
        ...finalMetadata,
        ...subroutineSession.metadata.toObject(),
      }; // Use toObject()
    }

    // Create a new session with the merged state, passing the raw metadata object
    // Create the session with metadata first
    let mergedSession = createSession<P>({ metadata: finalMetadata as P });
    // Add messages one by one, reassigning the immutable result
    finalMessages.forEach((msg: Message) => {
      mergedSession = mergedSession.addMessage(msg);
    });

    return mergedSession;
  }
}
