import type { Message } from '../../message';
import type { Session } from '../../session';
import { Attrs, Vars } from '../../session';
import { TemplateBase } from '../base';

export type GenerateMessagesFn<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> = (
  session: Session<TVars, TAttrs>,
) => Message<TAttrs>[] | Promise<Message<TAttrs>[]>;

/**
 * A template that appends one or more messages produced from the current session.
 */
export class GenerateMessages<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends TemplateBase<TAttrs, TVars> {
  constructor(
    private readonly generateMessages: GenerateMessagesFn<TAttrs, TVars>,
  ) {
    super();
  }

  /**
   * @internal
   */
  getGenerateMessages(): GenerateMessagesFn<TAttrs, TVars> {
    return this.generateMessages;
  }

  getManifestDescriptor() {
    return {
      kind: 'template',
      templateType: 'GenerateMessages',
      generateMessages: this.generateMessages,
    };
  }

  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    let currentSession = this.ensureSession(session);
    const messages = await this.generateMessages(currentSession);

    for (const message of messages) {
      currentSession = currentSession.addMessage(message);
    }

    return currentSession;
  }
}
