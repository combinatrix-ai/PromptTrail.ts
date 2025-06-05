import type { SystemMessage } from '../../message';
import type { Session } from '../../session';
import type { Attrs, Vars } from '../../session';
import { interpolateTemplate } from '../../utils/template_interpolation';
import { TemplateBase } from '../base';

export class System<
  TAttrs extends Attrs = Record<string, any>,
  TVars extends Vars = Record<string, any>,
> extends TemplateBase<TAttrs, TVars> {
  private content: string;

  constructor(content: string) {
    super();
    this.content = content;
  }

  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const validSession = this.ensureSession(session);

    const interpolatedContent = interpolateTemplate(this.content, validSession);

    const message: SystemMessage<TAttrs> = {
      type: 'system',
      content: interpolatedContent,
    };
    return validSession.addMessage(message);
  }
}
