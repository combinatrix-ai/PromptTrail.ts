import type { Source } from '../../content_source';
import type { UserMessage } from '../../message';
import type { Session } from '../../session';
import { Context, Metadata } from '../../tagged_record';
import { TemplateBase } from '../base';

export class User<
  TMetadata extends Metadata = Metadata,
  TContext extends Context = Context,
> extends TemplateBase<TMetadata, TContext> {
  constructor(contentOrSource?: string | Source<string>) {
    super();
    this.contentSource = this.initializeContentSource(
      contentOrSource,
      'string',
    );
  }

  async execute(
    session?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>> {
    const validSession = this.ensureSession(session);
    if (!this.contentSource)
      throw new Error('Content source required for UserTemplate');

    const content = await this.contentSource.getContent(validSession);
    if (typeof content !== 'string')
      throw new Error('Expected string content from UserTemplate source');

    const message: UserMessage<TMetadata> = {
      type: 'user',
      content,
    };
    return validSession.addMessage(message);
  }
}
