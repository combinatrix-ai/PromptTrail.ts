import { createContext } from '../context';
import type { Session } from '../session';
import type { SystemMessage } from '../message';
import { BaseTemplate } from './base';
import type { Source } from '../content_source';

export class System extends BaseTemplate<any, any> {
  constructor(contentOrSource: string | Source<string>) {
    super();
    this.contentSource = this.initializeContentSource(
      contentOrSource,
      'string',
    );
  }

  async execute(session?: Session): Promise<Session> {
    const validSession = this.ensureSession(session);
    if (!this.contentSource)
      throw new Error('Content source required for SystemTemplate');

    const content = await this.contentSource.getContent(validSession);
    if (typeof content !== 'string')
      throw new Error('Expected string content from SystemTemplate source');

    const message: SystemMessage = {
      type: 'system',
      content,
      metadata: createContext(),
    };
    return validSession.addMessage(message);
  }
}
