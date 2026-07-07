import type { SystemMessage } from '../../message';
import type { Session, Vars } from '../../session';
import type { Source } from '../../source';
import { TemplateBase } from '../base';

export class System<TVars extends Vars = Vars> extends TemplateBase<TVars> {
  constructor(contentOrSource: string | Source<string>) {
    super();
    this.contentSource = this.initializeContentSource(
      contentOrSource,
      'string',
    );
  }

  async execute(session?: Session<TVars>): Promise<Session<TVars>> {
    const validSession = this.ensureSession(session);
    if (!this.contentSource)
      throw new Error('Content source required for SystemTemplate');

    const content = await this.contentSource.getContent(validSession);
    if (typeof content !== 'string')
      throw new Error('Expected string content from SystemTemplate source');

    const message: SystemMessage = {
      type: 'system',
      content,
    };
    return validSession.addMessage(message);
  }

  getManifestDescriptor() {
    return {
      kind: 'template',
      templateType: 'System',
      contentSource: this.contentSource,
    };
  }
}
