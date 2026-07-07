import type { UserMessage } from '../../message';
import type { Session, Vars } from '../../session';
import type { Source } from '../../source';
import { TemplateBase } from '../base';

export class User<TVars extends Vars = Vars> extends TemplateBase<TVars> {
  constructor(contentOrSource?: string | Source<string>) {
    super();
    this.contentSource = this.initializeContentSource(
      contentOrSource,
      'string',
    );
  }

  async execute(session?: Session<TVars>): Promise<Session<TVars>> {
    const validSession = this.ensureSession(session);
    if (!this.contentSource)
      throw new Error('Content source required for UserTemplate');

    const content = await this.contentSource.getContent(validSession);
    if (typeof content !== 'string')
      throw new Error('Expected string content from UserTemplate source');

    const message: UserMessage = {
      type: 'user',
      content,
    };
    return validSession.addMessage(message);
  }

  getManifestDescriptor() {
    return {
      kind: 'template',
      templateType: 'User',
      contentSource: this.contentSource,
    };
  }
}
