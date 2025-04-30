import { Context, createMetadata, Metadata } from '../../taggedRecord';
import type { Session } from '../../session';
import type { SystemMessage } from '../../message';
import { BaseTemplate } from '../base';
import type { Source } from '../../content_source';

export class System<
  TMetadata extends Metadata,
  TContext extends Context,
> extends BaseTemplate<TMetadata, TContext> {
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
      metadata: createMetadata<TMetadata>(),
    };
    return validSession.addMessage(message);
  }
}
