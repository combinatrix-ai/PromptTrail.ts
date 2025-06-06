import * as readline from 'node:readline/promises';
import { ValidationError } from '../../errors';
import type { UserMessage } from '../../message';
import type { Attrs, Session, Vars } from '../../session';
import type { Source } from '../../source';
import { interpolateTemplate } from '../../utils/template_interpolation';
import type { IValidator } from '../../validators/base';
import { TemplateBase } from '../base';

export interface CLIOptions {
  cli: string;
  defaultValue?: string;
}

export interface UserTemplateOptions {
  role?: 'user' | 'assistant' | 'system';
  loop?: boolean;
  validation?: IValidator;
  maxAttempts?: number;
}

export type UserContentInput =
  | string
  | string[]
  | CLIOptions
  | ((session: Session<any, any>) => Promise<string>)
  | Source<string>;

export class User<
  TAttrs extends Attrs = Record<string, any>,
  TVars extends Vars = Record<string, any>,
> extends TemplateBase<TAttrs, TVars> {
  private content: UserContentInput;
  private options: UserTemplateOptions;
  private currentIndex = 0;
  private isSourceBased = false;

  constructor(
    content: UserContentInput = '',
    options: UserTemplateOptions = {},
  ) {
    super();
    this.content = content;
    this.options = options;
    this.isSourceBased = !!(
      content &&
      typeof content === 'object' &&
      'getContent' in content
    );
  }

  getContentSource(): Source<string> | null {
    return this.isSourceBased ? (this.content as Source<string>) : null;
  }

  set contentSource(source: Source<string> | undefined) {
    if (source) {
      this.content = source;
      this.isSourceBased = true;
    }
  }

  private async getStringContent(
    session: Session<TVars, TAttrs>,
  ): Promise<string> {
    if (this.isSourceBased) {
      const source = this.content as Source<string>;
      const result = await source.getContent(session);
      if (typeof result !== 'string') {
        throw new Error('Expected string content from User template Source');
      }
      return result;
    }

    if (typeof this.content === 'string') {
      return interpolateTemplate(this.content, session);
    }

    if (Array.isArray(this.content)) {
      if (this.content.length === 0) {
        throw new Error('User template content array is empty');
      }

      if (this.currentIndex >= this.content.length) {
        if (this.options.loop) {
          this.currentIndex = 0;
        } else {
          throw new Error('No more content in User template array');
        }
      }

      const content = this.content[this.currentIndex++];
      return interpolateTemplate(content, session);
    }

    if (typeof this.content === 'object' && 'cli' in this.content) {
      try {
        const { InkDebugContext } = await import('../../cli/ink-debug-context');

        if (session.debug) {
          const isInkAvailable = await InkDebugContext.waitForInitialization();

          if (isInkAvailable) {
            return await InkDebugContext.captureCliInput(
              this.content.cli,
              this.content.defaultValue,
              session,
            );
          }
        }
      } catch (error) {}

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        const rawInput = await rl.question(this.content.cli);
        return rawInput || this.content.defaultValue || '';
      } finally {
        rl.close();
      }
    }

    if (typeof this.content === 'function') {
      return await this.content(session);
    }

    throw new Error('Invalid User template content type');
  }

  private async validateContent(
    content: string,
    session: Session<TVars, TAttrs>,
  ): Promise<void> {
    if (this.isSourceBased || !this.options.validation) return;

    const result = await this.options.validation.validate(content, session);
    if (!result.isValid) {
      throw new ValidationError(
        `User content validation failed: ${result.instruction || ''}`,
      );
    }
  }

  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const validSession = this.ensureSession(session);

    if (this.isSourceBased) {
      const content = await this.getStringContent(validSession);
      const message: UserMessage<TAttrs> = {
        type: 'user',
        content,
      };
      return validSession.addMessage(message);
    }

    const maxAttempts = this.options.maxAttempts || 1;
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts++;

      try {
        const content = await this.getStringContent(validSession);
        await this.validateContent(content, validSession);

        const message: UserMessage<TAttrs> = {
          type: 'user',
          content,
        };

        return validSession.addMessage(message);
      } catch (error) {
        if (attempts >= maxAttempts) {
          throw error;
        }

        console.warn(
          `User template attempt ${attempts} failed: ${(error as Error).message}. Retrying...`,
        );
      }
    }

    throw new Error('User template execution failed unexpectedly');
  }
}
