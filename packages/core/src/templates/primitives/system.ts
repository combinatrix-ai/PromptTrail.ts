import type { SystemMessage } from '../../message';
import type { Session } from '../../session';
import type { Attrs, Vars } from '../../session';
import type { Source } from '../../source';
import { interpolateTemplate } from '../../utils/template_interpolation';
import { TemplateBase } from '../base';

export type SystemContentInput =
  | string
  | Source<string>
  | ((session: Session<any, any>) => Promise<string>);

export class System<
  TAttrs extends Attrs = Record<string, any>,
  TVars extends Vars = Record<string, any>,
> extends TemplateBase<TAttrs, TVars> {
  private content: SystemContentInput;

  constructor(contentOrSource: SystemContentInput) {
    super();
    this.content = contentOrSource;
  }

  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const validSession = this.ensureSession(session);

    let content: string;

    if (typeof this.content === 'string') {
      content = this.content;
    } else if (typeof this.content === 'function') {
      content = await this.content(validSession);
    } else {
      // Source object
      content = await this.content.getContent(validSession);
    }

    const interpolatedContent = interpolateTemplate(content, validSession);

    const message: SystemMessage<TAttrs> = {
      type: 'system',
      content: interpolatedContent,
    };
    return validSession.addMessage(message);
  }
}
