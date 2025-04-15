import { createSession } from '../session';
import type { ISession, Message, Session } from '../types'; // Import ISession, Message, and Session
import { BaseTemplate } from './interfaces';
import type { Template } from './interfaces'; // Use Template interface
import type { Metadata } from '../metadata'; // Use Metadata interface
import { createMetadata } from '../metadata';
import type { Source, ModelOutput } from '../content_source';
import type { GenerateOptions } from '../generate_options';
import { TemplateFactory } from './factory';
import type { TTransformFunction } from './transform';

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
> extends BaseTemplate<P, P> {
  // Output metadata type is P
  public readonly id?: string;
  private templates: Template<any, any>[] = [];
  private readonly options: ISubroutineTemplateOptions<P, S>;

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
    this.options = {
      retainMessages: true, // Default: retain messages
      isolatedContext: false, // Default: share context
      ...options,
    };
    this.id = this.options.id;

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
   * Adds a template to the subroutine.
   * @param template The template to add.
   * @returns This instance for method chaining.
   */
  add(template: Template<any, any>): this {
    this.templates.push(template);
    return this;
  }

  // Convenience methods for adding specific template types
  addSystem(content: string | Source<string>): this {
    return this.add(TemplateFactory.system(content));
  }

  addUser(content: string | Source<string>): this {
    return this.add(TemplateFactory.user(content));
  }

  addAssistant(content: string | Source<ModelOutput> | GenerateOptions): this {
    return this.add(TemplateFactory.assistant(content));
  }

  addTransform(transformFn: TTransformFunction<S>): this {
    return this.add(TemplateFactory.transform(transformFn));
  }

  addIf(
    condition: (session: Session) => boolean,
    thenTemplate: Template<any, any>,
    elseTemplate?: Template<any, any>,
  ): this {
    return this.add(TemplateFactory.if(condition, thenTemplate, elseTemplate));
  }

  addLoop(
    bodyTemplate: Template<any, any>,
    exitCondition: (session: Session) => boolean,
  ): this {
    return this.add(TemplateFactory.loop(bodyTemplate, exitCondition));
  }

  addSubroutine(
    template: Template<any, any>,
    options?: ISubroutineTemplateOptions<any, any>,
  ): this {
    return this.add(new Subroutine(template, options));
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

    // 2. Execute all templates in sequence
    let currentSession = initialSubroutineSession;

    if (this.templates.length === 0) {
      // If no templates, just return the initialized session
      return this.mergeSessions(parentSession, currentSession);
    }

    for (const template of this.templates) {
      const result = await template.execute(currentSession);

      // Handle potential errors or early exits
      if (result instanceof Error) {
        console.error(`Subroutine execution failed: ${result.message}`);
        throw result;
      }

      if (result === null) {
        console.warn(
          'Template in subroutine returned null, stopping execution.',
        );
        // Return the session state before the template that returned null
        return this.mergeSessions(parentSession, currentSession);
      }

      currentSession = result;
    }

    // 3. Merge results back into the parent session
    const finalParentSession = this.mergeSessions(
      parentSession,
      currentSession,
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
