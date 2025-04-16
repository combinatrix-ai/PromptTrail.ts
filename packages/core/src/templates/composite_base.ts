import type { Session } from '../types';
import { BaseTemplate } from './interfaces';
import type { Template } from './interfaces';
import type { Source, ModelOutput } from '../content_source';
import type { GenerateOptions } from '../generate_options';
import { System } from './system';
import { User } from './user';
import { Assistant } from './assistant';
import { Conditional } from './conditional';
import { Loop } from './loop';
import { Sequence } from './sequence';
import { Subroutine } from './subroutine';
import { Transform } from './transform';
import type { TTransformFunction } from './transform';
import type { ISubroutineTemplateOptions } from './subroutine';

/**
 * Base class for composite templates (Sequence, Loop, Subroutine)
 * Provides common functionality and a unified execution model
 */
export abstract class CompositeTemplateBase<
  TIn extends Record<string, unknown> = Record<string, unknown>,
  TOut extends Record<string, unknown> = TIn
> extends BaseTemplate<TIn, TOut> {
  // Common properties - protected so derived classes can access them
  protected templates: Template<any, any>[] = [];
  protected initFunction?: (session: Session<TIn>) => Session<any>;
  protected squashFunction?: (parentSession: Session<TIn>, childSession: Session<any>) => Session<TOut>;
  protected loopCondition?: (session: Session<any>) => boolean;
  protected maxIterations: number = 100;

  // Common template management method
  add(template: Template<any, any>): this {
    this.templates.push(template);
    return this;
  }

  // Direct implementation of factory methods
  addSystem(content: string | Source<string>): this {
    return this.add(new System(content));
  }

  addUser(content: string | Source<string>): this {
    return this.add(new User(content));
  }

  addAssistant(content: string | Source<ModelOutput> | GenerateOptions): this {
    return this.add(new Assistant(content));
  }

  addTransform(transformFn: TTransformFunction<any>): this {
    return this.add(new Transform(transformFn));
  }

  addIf(
    condition: (session: Session) => boolean,
    thenTemplate: Template<any, any>,
    elseTemplate?: Template<any, any>,
  ): this {
    return this.add(new Conditional({ condition, thenTemplate, elseTemplate }));
  }

  addLoop(
    bodyTemplate: Template<any, any>,
    exitCondition: (session: Session) => boolean,
  ): this {
    return this.add(new Loop({
      bodyTemplate,
      exitCondition,
    }));
  }

  addSubroutine(
    templateOrTemplates: Template<any, any> | Template<any, any>[],
    options?: ISubroutineTemplateOptions<any, any>,
  ): this {
    return this.add(new Subroutine(templateOrTemplates, options));
  }

  // Unified execute implementation
  async execute(session?: Session<TIn>): Promise<Session<TOut>> {
    const originalSession = this.ensureSession(session);
    
    // Validate that we have templates to execute
    if (this.templates.length === 0) {
      // For Loop templates, throw an error
      if (this.constructor.name === 'Loop') {
        throw new Error('LoopTemplate requires a bodyTemplate.');
      }
      // For other templates, just return the original session
      return originalSession as unknown as Session<TOut>;
    }
    
    // 1. Initialize session (if initFunction provided)
    let currentSession = this.initFunction 
      ? this.initFunction(originalSession) 
      : originalSession;
    
    // 2. Execute templates (with optional looping)
    if (this.loopCondition !== undefined) {
      // Loop execution
      let iterations = 0;
      
      // Check if the loopCondition is a function
      if (typeof this.loopCondition !== 'function') {
        // If no exit condition is provided, execute once and warn
        if (this.constructor.name === 'Loop') {
          console.warn('LoopTemplate executed without an exit condition. Executing once.');
        }
        for (const template of this.templates) {
          currentSession = await template.execute(currentSession);
        }
      } else {
        // Execute the loop until the exit condition is met or max iterations reached
        while (iterations < this.maxIterations && !this.loopCondition(currentSession)) {
          for (const template of this.templates) {
            currentSession = await template.execute(currentSession);
          }
          iterations++;
        }
        
        if (iterations >= this.maxIterations) {
          if (this.constructor.name === 'Loop') {
            console.warn(`LoopTemplate reached maximum iterations (${this.maxIterations}). Exiting.`);
          } else {
            console.warn(`Loop reached maximum iterations (${this.maxIterations}). Exiting.`);
          }
        }
      }
    } else {
      // Simple sequence execution
      for (const template of this.templates) {
        currentSession = await template.execute(currentSession);
      }
    }
    
    // 3. Apply squash function (if provided)
    return this.squashFunction 
      ? this.squashFunction(originalSession, currentSession) 
      : currentSession as unknown as Session<TOut>;
  }
}
