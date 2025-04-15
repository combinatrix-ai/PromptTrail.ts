import type { Session } from '../types'; // Imports the generic Session type
import { BaseTemplate } from './interfaces';
import type { Template } from './interfaces';
import type { Source, ModelOutput } from '../content_source';
import type { GenerateOptions } from '../generate_options';
import { TemplateFactory } from './factory';
import type { TTransformFunction } from './transform';
import type { ISubroutineTemplateOptions } from './subroutine';

// Make LoopTemplate generic over the metadata type T
export class LoopTemplate<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends BaseTemplate<any, any> {
  // BaseTemplate generics might need review later
  // TODO: Review if Template<any, any> is correct or needs T
  private bodyTemplate?: Template<any, any>;
  private exitCondition?: (session: Session<T>) => boolean; // Use Session<T>
  private maxIterations: number;

  // Update constructor signature to use Session<T> and make parameters optional
  constructor(options: {
    bodyTemplate?: Template<any, any>;
    exitCondition?: (session: Session<T>) => boolean;
    maxIterations?: number;
  } = {}) {
    super();
    this.bodyTemplate = options.bodyTemplate;
    this.exitCondition = options.exitCondition;
    this.maxIterations = options.maxIterations ?? 100; // Default to 100 iterations
  }

  // Method to set the body template
  setBody(template: Template<any, any>): this {
    this.bodyTemplate = template;
    return this;
  }

  // Method to set the exit condition
  setLoopIf(condition: (session: Session<T>) => boolean): this {
    this.exitCondition = condition;
    return this;
  }

  // Method to set the maximum iterations
  setMaxIterations(maxIterations: number): this {
    this.maxIterations = maxIterations;
    return this;
  }

  // Convenience methods similar to Sequence
  add(template: Template<any, any>): this {
    if (!this.bodyTemplate) {
      this.bodyTemplate = template;
    } else {
      // If bodyTemplate already exists, convert it to a Sequence if it's not already one
      if (!(this.bodyTemplate instanceof TemplateFactory.sequence().constructor)) {
        this.bodyTemplate = TemplateFactory.sequence([this.bodyTemplate, template]);
      } else {
        // If it's already a Sequence, add the template to it
        (this.bodyTemplate as any).add(template);
      }
    }
    return this;
  }

  // Convenience methods for adding specific template types
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

  addSubroutine(
    templateOrTemplates: Template<any, any> | Template<any, any>[],
    options?: ISubroutineTemplateOptions<any, any>,
  ): this {
    return this.add(TemplateFactory.subroutine(templateOrTemplates, options));
  }

  // Update execute signature to use Session<T>
  async execute(session?: Session<T>): Promise<Session<T>> {
    // Ensure we have a body template
    if (!this.bodyTemplate) {
      throw new Error('LoopTemplate requires a bodyTemplate.');
    }

    // If no exit condition is set, execute the body template once and then exit
    if (!this.exitCondition) {
      console.warn('LoopTemplate executed without an exit condition. Executing once and exiting.');
      let currentSession = this.ensureSession(session) as Session<T>;
      currentSession = await this.bodyTemplate.execute(currentSession);
      return currentSession;
    }

    // Assuming ensureSession can handle or infer T, or needs update
    let currentSession = this.ensureSession(session) as Session<T>; // Cast for now, review ensureSession later
    let iterations = 0;

    // Original simple while loop
    while (
      iterations < this.maxIterations &&
      !this.exitCondition(currentSession)
    ) {
      currentSession = await this.bodyTemplate.execute(currentSession);
      iterations++;
    }

    if (iterations >= this.maxIterations) {
      console.warn(
        `LoopTemplate reached maximum iterations (${this.maxIterations}). Exiting.`,
      );
      // Optionally, you could throw an error instead:
      // throw new Error(`LoopTemplate reached maximum iterations (${this.maxIterations}).`);
    }

    return currentSession;
  }
}
