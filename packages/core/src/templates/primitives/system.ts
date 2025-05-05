import { Context, Metadata } from '../../tagged_record';
import type { Session } from '../../session';
import type { SystemMessage } from '../../message';
import { TemplateBase } from '../base';
import type { Source } from '../../content_source';

export class System<
  TMetadata extends Metadata = Metadata,
  TContext extends Context = Context,
> extends TemplateBase<TMetadata, TContext> {
  constructor(contentOrSource: string | Source<string>) {
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
      throw new Error('Content source required for SystemTemplate');

    const content = await this.contentSource.getContent(validSession);
    if (typeof content !== 'string')
      throw new Error('Expected string content from SystemTemplate source');

    const message: SystemMessage<TMetadata> = {
      type: 'system',
      content,
      metadata: undefined,
    };
    return validSession.addMessage(message);
  }
}
