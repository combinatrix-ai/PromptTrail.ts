import type { Message } from '../../message';
import type { Session, Vars } from '../../session';
import { TemplateBase } from '../base';

export type GenerateMessagesFn<TVars extends Vars = Vars> = (
  session: Session<TVars>,
) => Message[];

/**
 * A template that appends one or more messages produced from the current session.
 */
export class GenerateMessages<
  TVars extends Vars = Vars,
> extends TemplateBase<TVars> {
  constructor(private readonly generateMessages: GenerateMessagesFn<TVars>) {
    super();
  }

  /**
   * @internal
   */
  getGenerateMessages(): GenerateMessagesFn<TVars> {
    return this.generateMessages;
  }

  getManifestDescriptor() {
    return {
      kind: 'template',
      templateType: 'GenerateMessages',
      generateMessages: this.generateMessages,
    };
  }

  async execute(session?: Session<TVars>): Promise<Session<TVars>> {
    let currentSession = this.ensureSession(session);
    const messages = await this.generateMessages(currentSession);

    for (const message of messages) {
      currentSession = currentSession.addMessage(message);
    }

    return currentSession;
  }
}
