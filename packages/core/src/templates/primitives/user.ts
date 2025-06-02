import type { UserMessage } from '../../message';
import type { Session } from '../../session';
import type { Source } from '../../source';
import type { Attrs, Vars } from '../../session';
import { TemplateBase } from '../base';

export class User<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends TemplateBase<TAttrs, TVars> {
  constructor(contentOrSource?: string | Source<string>) {
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
      throw new Error('Content source required for UserTemplate');

    const content = await this.contentSource.getContent(validSession);
    if (typeof content !== 'string')
      throw new Error('Expected string content from UserTemplate source');

    const message: UserMessage<TAttrs> = {
      type: 'user',
      content,
    };
    return validSession.addMessage(message);
  }
}
