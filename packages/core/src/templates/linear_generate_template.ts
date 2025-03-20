import type { Session } from '../session';
import { Template } from '../templates';
import { SystemTemplate, UserTemplate } from '../templates';
import { CallbackInputSource } from '../input_source';
import { GenerateTemplate, ToolResultTemplate } from './generate_template';
import type { GenerateOptions } from '../generate';

/**
 * Template for linear sequence of templates using the generateText function
 */
export class LinearGenerateTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> extends Template<TInput, TOutput> {
  private templates: Template<
    Record<string, unknown>,
    Record<string, unknown>
  >[] = [];

  constructor(options?: GenerateOptions) {
    super({ generateOptions: options });
  }

  addSystem(content: string): this {
    this.templates.push(new SystemTemplate({ content }));
    return this;
  }

  addUser(content: string, defaultValue?: string): this {
    this.templates.push(
      new UserTemplate({
        description: content,
        default: defaultValue,
        inputSource: new CallbackInputSource(
          async ({ description }) => description,
        ),
      }),
    );
    return this;
  }

  addAssistant(
    options?:
      | string
      | {
          content?: string;
          generateOptions?: GenerateOptions;
        },
  ): this {
    if (typeof options === 'string') {
      this.templates.push(new GenerateTemplate({ content: options }));
    } else if (options) {
      // Use template-level generateOptions if no specific options are provided
      const mergedOptions = {
        ...options,
        generateOptions: options.generateOptions || this.generateOptions,
      };

      this.templates.push(new GenerateTemplate(mergedOptions));
    } else {
      // No options provided, use template-level generateOptions
      this.templates.push(
        new GenerateTemplate({ generateOptions: this.generateOptions }),
      );
    }
    return this;
  }

  addToolResult(toolCallId: string, content: string): this {
    this.templates.push(
      new ToolResultTemplate({
        toolCallId,
        content,
      }),
    );
    return this;
  }

  async execute(session: Session<TInput>): Promise<Session<TOutput>> {
    let currentSession: Session<Record<string, unknown>> =
      session as unknown as Session<Record<string, unknown>>;
    for (const template of this.templates) {
      currentSession = await template.execute(currentSession);
    }
    return currentSession as Session<TOutput>;
  }
}
