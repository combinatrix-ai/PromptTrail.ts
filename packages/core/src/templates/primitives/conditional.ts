import type { Session } from '../../session';
import { Context, Metadata } from '../../taggedRecord';
import { BaseTemplate } from '../base';
import type { Template } from '../base';

export class Conditional<
  TMetadata extends Metadata,
  TContext extends Context,
> extends BaseTemplate<any, any> {
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
    return validSession; // Return unchanged session if condition is false and no else branch
  }
}
