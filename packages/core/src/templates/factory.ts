import type { Source } from '../content_source';
import type { ModelOutput } from '../content_source';
import type { GenerateOptions } from '../generate_options';
import type { Template } from './base';
import { System } from './system';
import { User } from './user';
import { Assistant } from './assistant';
import { Conditional } from './conditional';
import { Loop } from './loop';
import { Sequence } from './sequence';
import { Subroutine } from './subroutine';
import { Transform } from './transform';
import type { Session } from '../types';
import type {
  TTransformFunction,
  ISubroutineTemplateOptions,
} from './template_types';

/**
 * Factory methods for creating templates
 */
export class TemplateFactory {
  static system(content: string | Source<string>): Template<any, any> {
    return new System(content);
  }

  static user(content: string | Source<string>): Template<any, any> {
    return new User(content);
  }

  static assistant(
    content: string | Source<ModelOutput> | GenerateOptions,
  ): Template<any, any> {
    return new Assistant(content);
  }

  static if(
    condition: (session: Session) => boolean,
    thenTemplate: Template<any, any>,
    elseTemplate?: Template<any, any>,
  ): Template<any, any> {
    return new Conditional({ condition, thenTemplate, elseTemplate });
  }

  static loop(
    bodyTemplate?: Template<any, any>,
    exitCondition?: (session: Session) => boolean,
  ): Template<any, any> {
    return new Loop({
      bodyTemplate,
      exitCondition,
    });
  }

  static sequence(templates?: Template<any, any>[]): Template<any, any> {
    return new Sequence(templates);
  }

  static subroutine<
    P extends Record<string, unknown> = Record<string, unknown>,
    S extends Record<string, unknown> = Record<string, unknown>,
  >(
    templateOrTemplates?: Template<S, S> | Template<any, any>[],
    options?: ISubroutineTemplateOptions<P, S>,
  ): Template<P, P> {
    return new Subroutine<P, S>(templateOrTemplates, options);
  }

  // Added transform method correctly inside the class
  // Make transform method generic
  static transform<T extends Record<string, unknown> = Record<string, unknown>>(
    transformFn: TTransformFunction<T>,
  ): Template<T, any> {
    // Return Template<T, any>
    // Pass the generic type to TransformTemplate constructor
    return new Transform<T>(transformFn);
  }
} // Correct closing brace for the class
