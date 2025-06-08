import type { MessageMetadata, SessionContext } from '../../session';
import { Session } from '../../session';
import type { Template } from '../base';
import { TemplateBase } from '../base';

export class Conditional<
  TMetadata extends MessageMetadata = Record<string, any>,
  TContext extends SessionContext = Record<string, any>,
> extends TemplateBase<TMetadata, TContext> {
  private condition: (session: Session<TContext, TMetadata>) => boolean;
  private thenTemplate: Template<TMetadata, TContext>;
  private elseTemplate?: Template<TMetadata, TContext>;

  constructor(options: {
    condition: (session: Session<TContext, TMetadata>) => boolean;
    thenTemplate: Template<TMetadata, TContext>;
    elseTemplate?: Template<TMetadata, TContext>;
  }) {
    super();
    this.condition = options.condition;
    this.thenTemplate = options.thenTemplate;
    this.elseTemplate = options.elseTemplate;
  }

  async execute(
    session?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>> {
    const validSession = this.ensureSession(session);

    if (this.condition(validSession)) {
      return this.thenTemplate.execute(validSession);
    } else if (this.elseTemplate) {
      return this.elseTemplate.execute(validSession);
    }
    return validSession;
  }
}
