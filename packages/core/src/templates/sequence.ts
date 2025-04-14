import type { Session } from '../types';
import { BaseTemplate } from './interfaces';
import type { Template } from './interfaces';
import type { Source, ModelOutput } from '../content_source';
import type { GenerateOptions } from '../generate_options';
import { TemplateFactory } from './factory';
import type { TTransformFunction } from './transform';

// Make Sequence generic over the metadata type T
export class Sequence<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends BaseTemplate<any, any> { // BaseTemplate generics might need review later
  // TODO: Review if Template<any, any> is correct or needs T
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
  
    // Update addTransform to use generic TTransformFunction<T>
    addTransform(transformFn: TTransformFunction<T>): this {
      return this.add(TemplateFactory.transform(transformFn));
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

  // Update execute signature to use Session<T>
  async execute(session?: Session<T>): Promise<Session<T>> {
    // Assuming ensureSession can handle or infer T, or needs update
    let currentSession = this.ensureSession(session) as Session<T>; // Cast for now, review ensureSession later

    for (const template of this.templates) {
      currentSession = await template.execute(currentSession);
    }

    return currentSession;
  }
}
