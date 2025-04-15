import { createMetadata } from '../metadata';
import type { Session, UserMessage } from '../types';
import { BaseTemplate } from './interfaces';
import type { Source } from '../content_source';

export class User extends BaseTemplate<any, any> {
  constructor(contentOrSource?: string | Source<string>) {
    super();
    this.contentSource = this.initializeContentSource(
      contentOrSource,
      'string',
    );
  }

  async execute(session?: Session): Promise<Session> {
    const validSession = this.ensureSession(session);
    if (!this.contentSource)
      throw new Error('Content source required for UserTemplate');

    const content = await this.contentSource.getContent(validSession);
    if (typeof content !== 'string')
      throw new Error('Expected string content from UserTemplate source');

    const message: UserMessage = {
      type: 'user',
      content,
      metadata: createMetadata(),
    };
    return validSession.addMessage(message);
  }
}
