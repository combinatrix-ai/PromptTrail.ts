import type { Session } from '../types';
import { BaseTemplate } from './interfaces';
import type { Template } from './interfaces';
import type { Source, ModelOutput } from '../content_source';
import type { GenerateOptions } from '../generate_options';
import { TemplateFactory } from './factory';

export class Sequence extends BaseTemplate<any, any> {
  private templates: Template<any, any>[] = [];

  constructor(templates?: Template<any, any>[]) {
    super();
    if (templates) {
      this.templates = [...templates];
    }
  }

  add(template: Template<any, any>): this {
    this.templates.push(template);
    return this;
  }

  // Convenience methods
  addSystem(content: string | Source<string>): this {
    return this.add(TemplateFactory.system(content));
  }

  addUser(content: string | Source<string>): this {
    return this.add(TemplateFactory.user(content));
  }

  addAssistant(content: string | Source<ModelOutput> | GenerateOptions): this {
    return this.add(TemplateFactory.assistant(content));
  }

  addIf(
    condition: (session: Session) => boolean,
    thenTemplate: Template<any, any>,
    elseTemplate?: Template<any, any>,
  ): this {
    return this.add(TemplateFactory.if(condition, thenTemplate, elseTemplate));
  }

  addLoop(
    bodyTemplate: Template<any, any>,
    exitCondition: (session: Session) => boolean,
  ): this {
    return this.add(TemplateFactory.loop(bodyTemplate, exitCondition));
  }

  async execute(session?: Session): Promise<Session> {
    let currentSession = this.ensureSession(session);

    for (const template of this.templates) {
      currentSession = await template.execute(currentSession);
    }

    return currentSession;
  }
}
