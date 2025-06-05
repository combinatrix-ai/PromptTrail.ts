import type { Attrs, Vars } from '../../session';
import { Session } from '../../session';
import type { Template } from '../base';
import { TemplateBase } from '../base';

export class Conditional<
  TAttrs extends Attrs = Record<string, any>,
  TVars extends Vars = Record<string, any>,
> extends TemplateBase<TAttrs, TVars> {
  private condition: (session: Session<TVars, TAttrs>) => boolean;
  private thenTemplate: Template<TAttrs, TVars>;
  private elseTemplate?: Template<TAttrs, TVars>;

  constructor(options: {
    condition: (session: Session<TVars, TAttrs>) => boolean;
    thenTemplate: Template<TAttrs, TVars>;
    elseTemplate?: Template<TAttrs, TVars>;
  }) {
    super();
    this.condition = options.condition;
    this.thenTemplate = options.thenTemplate;
    this.elseTemplate = options.elseTemplate;
  }

  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const validSession = this.ensureSession(session);

    if (this.condition(validSession)) {
      return this.thenTemplate.execute(validSession);
    } else if (this.elseTemplate) {
      return this.elseTemplate.execute(validSession);
    }
    return validSession;
  }
}
