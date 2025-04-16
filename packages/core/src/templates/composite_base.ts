import type { Session } from '../types';
import type { Template } from './interfaces';
import type { Source, ModelOutput } from '../content_source';
import type { GenerateOptions } from '../generate_options';
import { CompositeTemplateBase } from './template_interfaces';
import { TemplateFactory } from './factory';
import type { TTransformFunction, ISubroutineTemplateOptions } from './template_types';

/**
 * Interface for factory methods that can be added to CompositeTemplateBase
 */
export interface ICompositeTemplateFactoryMethods<T> {
  addSystem(content: string | Source<string>): T;
  addUser(content: string | Source<string>): T;
  addAssistant(content: string | Source<ModelOutput> | GenerateOptions): T;
  addTransform(transformFn: TTransformFunction<any>): T;
  addIf(
    condition: (session: Session) => boolean,
    thenTemplate: Template<any, any>,
    elseTemplate?: Template<any, any>,
  ): T;
  addLoop(
    bodyTemplate: Template<any, any>,
    exitCondition: (session: Session) => boolean,
  ): T;
  addSubroutine(
    templateOrTemplates: Template<any, any> | Template<any, any>[],
    options?: ISubroutineTemplateOptions<any, any>,
  ): T;
}

/**
 * Add factory methods to CompositeTemplateBase
 */
export function addFactoryMethods<
  T extends CompositeTemplateBase<any, any>
>(template: T): T & ICompositeTemplateFactoryMethods<T> {
  const enhancedTemplate = template as T & ICompositeTemplateFactoryMethods<T>;
  
  // Add factory methods to the instance
  enhancedTemplate.addSystem = function(content: string | Source<string>): T {
    return this.add(TemplateFactory.system(content));
  };

  enhancedTemplate.addUser = function(content: string | Source<string>): T {
    return this.add(TemplateFactory.user(content));
  };

  enhancedTemplate.addAssistant = function(content: string | Source<ModelOutput> | GenerateOptions): T {
    return this.add(TemplateFactory.assistant(content));
  };

  enhancedTemplate.addTransform = function(transformFn: TTransformFunction<any>): T {
    return this.add(TemplateFactory.transform(transformFn));
  };

  enhancedTemplate.addIf = function(
    condition: (session: Session) => boolean,
    thenTemplate: Template<any, any>,
    elseTemplate?: Template<any, any>,
  ): T {
    return this.add(TemplateFactory.if(condition, thenTemplate, elseTemplate));
  };

  enhancedTemplate.addLoop = function(
    bodyTemplate: Template<any, any>,
    exitCondition: (session: Session) => boolean,
  ): T {
    return this.add(TemplateFactory.loop(bodyTemplate, exitCondition));
  };

  enhancedTemplate.addSubroutine = function(
    templateOrTemplates: Template<any, any> | Template<any, any>[],
    options?: ISubroutineTemplateOptions<any, any>,
  ): T {
    return this.add(TemplateFactory.subroutine(templateOrTemplates, options));
  };

  return enhancedTemplate;
}

// Re-export the base class
export { CompositeTemplateBase };
