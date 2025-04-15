import type { Session } from '../types';
import { BaseTemplate } from './interfaces';
import type { Template } from './interfaces';

export class Conditional extends BaseTemplate<any, any> {
  private condition: (session: Session) => boolean;
  private thenTemplate: Template<any, any>;
  private elseTemplate?: Template<any, any>;

  constructor(options: {
    condition: (session: Session) => boolean;
    thenTemplate: Template<any, any>;
    elseTemplate?: Template<any, any>;
  }) {
    super();
    this.condition = options.condition;
    this.thenTemplate = options.thenTemplate;
    this.elseTemplate = options.elseTemplate;
  }

  async execute(session?: Session): Promise<Session> {
    const validSession = this.ensureSession(session);

    if (this.condition(validSession)) {
      return this.thenTemplate.execute(validSession);
    } else if (this.elseTemplate) {
      return this.elseTemplate.execute(validSession);
    }
    return validSession; // Return unchanged session if condition is false and no else branch
  }
}
