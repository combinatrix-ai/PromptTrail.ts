import type { Source } from '../content_source';
import type { ModelOutput } from '../content_source';
import type { GenerateOptions } from '../generate_options';
import type { Template } from './interfaces';
import { SystemTemplate } from './system';
import { UserTemplate } from './user';
import { AssistantTemplate } from './assistant';
import { IfTemplate } from './if';
import { LoopTemplate } from './loop';
import { Sequence } from './sequence';
import { TransformTemplate, TTransformFunction } from './transform'; // Correct import
import type { Session } from '../types';

/**
 * Factory methods for creating templates
 */
export class TemplateFactory {
  static system(content: string | Source<string>): Template<any, any> {
    return new SystemTemplate(content);
  }

  static user(content: string | Source<string>): Template<any, any> {
    return new UserTemplate(content);
  }

  static assistant(
    content: string | Source<ModelOutput> | GenerateOptions,
  ): Template<any, any> {
    return new AssistantTemplate(content);
  }

  static if(
    condition: (session: Session) => boolean,
    thenTemplate: Template<any, any>,
    elseTemplate?: Template<any, any>,
  ): Template<any, any> {
    return new IfTemplate({ condition, thenTemplate, elseTemplate });
  }

  static loop(
    bodyTemplate?: Template<any, any>,
    exitCondition?: (session: Session) => boolean,
  ): Template<any, any> {
    return new LoopTemplate({ 
      bodyTemplate, 
      exitCondition 
    });
  }

  static sequence(templates?: Template<any, any>[]): Template<any, any> {
    return new Sequence(templates);
  }

  // Added transform method correctly inside the class
  // Make transform method generic
  static transform<T extends Record<string, unknown> = Record<string, unknown>>(
    transformFn: TTransformFunction<T>,
  ): Template<T, any> {
    // Return Template<T, any>
    // Pass the generic type to TransformTemplate constructor
    return new TransformTemplate<T>(transformFn);
  }
} // Correct closing brace for the class
