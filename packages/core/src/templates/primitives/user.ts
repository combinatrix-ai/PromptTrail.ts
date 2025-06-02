import * as readline from 'node:readline/promises';
import type { UserMessage } from '../../message';
import type { Session } from '../../session';
import type { Attrs, Vars } from '../../session';
import type { Source } from '../../source';
import { interpolateTemplate } from '../../utils/template_interpolation';
import type { IValidator } from '../../validators/base';
import { ValidationError } from '../../errors';
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
  | Source<string>; // Backward compatibility

export class User<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
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

    // Check if this is a Source instance for backward compatibility
    this.isSourceBased = !!(
      content &&
      typeof content === 'object' &&
      'getContent' in content
    );
  }

  private async getStringContent(
    session: Session<TVars, TAttrs>,
  ): Promise<string> {
    // Backward compatibility: Use Source if provided
    if (this.isSourceBased) {
      const source = this.content as Source<string>;
      const result = await source.getContent(session);
      if (typeof result !== 'string') {
        throw new Error('Expected string content from User template Source');
      }
      return result;
    }

    // Direct API implementation
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
    // Skip validation for Source-based content (Sources handle their own validation)
    if (this.isSourceBased) return;

    if (!this.options.validation) return;

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

    // For Source-based content, use simpler execution (Sources handle retries)
    if (this.isSourceBased) {
      const content = await this.getStringContent(validSession);
      const message: UserMessage<TAttrs> = {
        type: 'user',
        content,
      };
      return validSession.addMessage(message);
    }

    // Direct API execution with retry logic
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
