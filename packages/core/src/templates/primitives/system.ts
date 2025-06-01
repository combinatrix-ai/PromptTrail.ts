import type { SystemMessage } from '../../message';
import type { Session } from '../../session';
import type { Source } from '../../source';
import { Attrs, Vars } from '../../session';
import { TemplateBase } from '../base';

export class System<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends TemplateBase<TAttrs, TVars> {
  constructor(contentOrSource: string | Source<string>) {
    super();
    this.contentSource = this.initializeContentSource(
      contentOrSource,
      'string',
    );
  }

  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const validSession = this.ensureSession(session);
    if (!this.contentSource)
      throw new Error('Content source required for SystemTemplate');

    const content = await this.contentSource.getContent(validSession);
    if (typeof content !== 'string')
      throw new Error('Expected string content from SystemTemplate source');

    const message: SystemMessage<TAttrs> = {
      type: 'system',
      content,
    };
    return validSession.addMessage(message);
  }
}
