import { createMetadata } from './metadata';
import type { InputSource } from './input_source';
import { StaticInputSource, CallbackInputSource } from './input_source';
import { interpolateTemplate } from './utils/template_interpolation';
import type { SessionTransformer } from './utils/session_transformer';
import { createTransformerTemplate } from './templates/transformer_template';
import { z } from 'zod';
import { generateText } from './generate';
import { type GenerateOptions } from './generate_options';
import type { Session, SchemaType } from './types';
import { type IValidator } from './validator';

/**
 * Base class for all templates
 */
export abstract class Template<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> {
  abstract execute(session: Session<TInput>): Promise<Session<TOutput>>;
}

/**
 * Template for system messages
 */
export class SystemTemplate extends Template {
  constructor(private content: string) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    const interpolatedContent = interpolateTemplate(
      this.content,
      session.metadata,
    );
    return session.addMessage({
      type: 'system',
      content: interpolatedContent,
      metadata: createMetadata(),
    });
  }
}

/**
 * Template for user messages
 */
export class UserTemplate extends Template {
  private options: {
    inputSource: InputSource;
    description?: string;
    validate?: (input: string) => Promise<boolean>;
    onInput?: (input: string) => void;
    default?: string;
  };

  constructor(
    optionsOrDescription:
      | string
      | InputSource
      | {
          inputSource: InputSource;
          description?: string;
          validate?: (input: string) => Promise<boolean>;
          onInput?: (input: string) => void;
          default?: string;
        },
  ) {
    super();

    if (typeof optionsOrDescription === 'string') {
      this.options = {
        inputSource: new StaticInputSource(optionsOrDescription),
      };
    } else if ('getInput' in optionsOrDescription) {
      this.options = {
        inputSource: optionsOrDescription as InputSource,
      };
    } else {
      // Options object constructor case
      this.options = optionsOrDescription as {
        inputSource: InputSource;
        description?: string;
        validate?: (input: string) => Promise<boolean>;
        onInput?: (input: string) => void;
        default?: string;
      };
    }
  }

  async execute(session: Session): Promise<Session> {
    let input: string;

    if (this.options.inputSource instanceof StaticInputSource) {
      // For static input sources
      input = interpolateTemplate(
        await this.options.inputSource.getInput(),
        session.metadata,
      );
    } else if (this.options.inputSource instanceof CallbackInputSource) {
      input = await this.options.inputSource.getInput({
        metadata: session.metadata,
      });

      if (this.options.validate) {
        let isValid = await this.options.validate(input);
        while (!isValid) {
          input = await this.options.inputSource.getInput({
            metadata: session.metadata,
          });
          isValid = await this.options.validate(input);
        }
      }

      if (this.options.onInput) {
        this.options.onInput(input);
      }
    } else {
      input = await this.options.inputSource.getInput({
        metadata: session.metadata,
      });
    }

    return session.addMessage({
      type: 'user',
      content: input,
      metadata: createMetadata(),
    });
  }
}

/**
 * Template for assistant messages
 */
export class AssistantTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> extends Template<TInput, TOutput> {
  private options: {
    content?: string;
    generateOptions?: GenerateOptions;
    validator?: IValidator;
  };
  constructor(
    contentOrGenerateOptions: string | GenerateOptions,
    validator?: IValidator
  ) {
    super();
    if (typeof contentOrGenerateOptions === 'string') {
      this.options = {
        content: contentOrGenerateOptions,
        validator,
      };
    } else {
      this.options = {
        generateOptions: contentOrGenerateOptions,
        validator,
      };
    }
  }

  async execute(session: Session<TInput>): Promise<Session<TOutput>> {
    if (this.options.content) {
      // For fixed content responses
      const interpolatedContent = interpolateTemplate(
        this.options.content,
        session.metadata,
      );
      
      if (this.options.validator) {
        const result = await this.options.validator.validate(interpolatedContent, session.metadata as any);
        if (!result.isValid) {
          throw new Error(`Assistant content validation failed: ${result.instruction || 'Invalid content'}`);
        }
      }
      
      return session.addMessage({
        type: 'assistant',
        content: interpolatedContent,
        metadata: createMetadata(),
      }) as unknown as Session<TOutput>;
    }

    if (!this.options.generateOptions) {
      throw new Error('generateOptions is required for AssistantTemplate');
    }

    // Use the generateText function
    // Cast session to any to avoid type issues with the generateText function
    const response = await generateText(
      session as any,
      this.options.generateOptions,
    );

    if (this.options.validator && response.type === 'assistant' && response.content) {
      const result = await this.options.validator.validate(response.content, session.metadata as any);
      if (!result.isValid) {
        throw new Error(`Assistant response validation failed: ${result.instruction || 'Invalid content'}`);
      }
    }
    
    // Add the assistant message to the session
    let updatedSession = session.addMessage(
      response,
    ) as unknown as Session<TOutput>;

    // Check if the response has tool calls directly in the message
    const toolCalls =
      response.type === 'assistant' ? response.toolCalls : undefined;

    if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
      // Execute each tool call and add the result as a tool_result message
      for (const toolCall of toolCalls) {
        const toolName = toolCall.name;
        const toolArgs = toolCall.arguments;
        const toolCallId = toolCall.id;

        // Get the tool from the generateOptions
        const tools = this.options.generateOptions.tools || {};
        const tool = tools[toolName] as any; // Cast to any to avoid type issues

        if (tool && typeof tool.execute === 'function') {
          try {
            // Execute the tool
            const result = await tool.execute(toolArgs, { toolCallId });

            // Add the tool result to the session
            const resultStr =
              typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2);

            // Create a tool result template and execute it
            const toolResultTemplate = new ToolResultTemplate({
              toolCallId,
              content: resultStr,
            });

            // Cast to any to avoid type issues
            updatedSession = (await toolResultTemplate.execute(
              updatedSession as any,
            )) as any;
          } catch (error) {
            // If the tool execution fails, add an error message as the tool result
            const errorMessage =
              error instanceof Error
                ? error.message
                : 'Unknown error occurred during tool execution';

            const toolResultTemplate = new ToolResultTemplate({
              toolCallId,
              content: `Error: ${errorMessage}`,
            });

            // Cast to any to avoid type issues
            updatedSession = (await toolResultTemplate.execute(
              updatedSession as any,
            )) as any;
          }
        }
      }
    }

    return updatedSession;
  }
}

/**
 * Template for tool results
 */
export class ToolResultTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> extends Template<TInput, TOutput> {
  constructor(
    private options: {
      toolCallId: string;
      content: string;
    },
  ) {
    super();
  }

  async execute(session: Session<TInput>): Promise<Session<TOutput>> {
    const metadata = createMetadata<{ toolCallId: string }>();
    metadata.set('toolCallId', this.options.toolCallId);

    return session.addMessage({
      type: 'tool_result',
      content: this.options.content,
      metadata,
      result: this.options.content, // Add the result property
    }) as unknown as Session<TOutput>;
  }
}

/**
 * Template for conditional execution based on a condition
 */
export class IfTemplate extends Template {
  constructor(
    private options: {
      condition: (session: Session) => boolean;
      thenTemplate: Template;
      elseTemplate?: Template;
    },
  ) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    if (this.options.condition(session)) {
      return this.options.thenTemplate.execute(session);
    } else if (this.options.elseTemplate) {
      return this.options.elseTemplate.execute(session);
    }
    return session; // If no else template and condition is false, return session unchanged
  }
}

/**
 * Shared constructor type for mixins
 */
type Constructor<T = {}> = new (...args: any[]) => T;

/**
 * Mixin functions for adding functionality to Templates have child classes
 */
function WithAssistant<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addAssistant(contentOrGenerateOptions: string | GenerateOptions): this {
      this.templates.push(new AssistantTemplate(contentOrGenerateOptions));
      return this;
    }
  };
}

function WithUser<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addUser(contentOrInputSource: string | InputSource): this {
      this.templates.push(new UserTemplate(contentOrInputSource));
      return this;
    }
  };
}

function WithSystem<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addSystem(content: string): this {
      this.templates.push(new SystemTemplate(content));
      return this;
    }
  };
}

function WithLoop<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addLoop(loop: LoopTemplate): this {
      this.templates.push(loop);
      return this;
    }
  };
}

function WithIf<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addIf(options: {
      condition: (session: Session) => boolean;
      thenTemplate: Template;
      elseTemplate?: Template;
    }): this {
      this.templates.push(new IfTemplate(options));
      return this;
    }
  };
}

function WithTransformer<
  TBase extends Constructor<{ templates: Template[] }>,
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
>(Base: TBase) {
  return class extends Base {
    addTransformer<TNewOutput extends Record<string, unknown>>(
      transformer: SessionTransformer<TOutput, TNewOutput>,
    ): LinearTemplate {
      // Cast the transformer to the expected type to avoid TypeScript errors
      const castTransformer = transformer as unknown as SessionTransformer<
        Record<string, unknown>,
        Record<string, unknown>
      >;
      this.templates.push(
        createTransformerTemplate(castTransformer) as Template,
      );
      return this as unknown as LinearTemplate;
    }
  };
}

function WithSchema<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    async addSchema<TSchema extends SchemaType | z.ZodType>(
      schema: TSchema,
      options: {
        generateOptions: GenerateOptions;
        maxAttempts?: number;
        functionName?: string;
      },
    ): Promise<this> {
      // Import SchemaTemplate dynamically to avoid circular dependency
      // Use dynamic import for ESM compatibility
      const SchemaTemplateModule = await import('./templates/schema_template');
      const { SchemaTemplate } = SchemaTemplateModule;

      this.templates.push(
        new SchemaTemplate({
          generateOptions: options.generateOptions,
          schema: schema,
          maxAttempts: options?.maxAttempts,
          functionName: options?.functionName,
        }),
      );

      return this;
    }
  };
}

function WithSubroutine<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    addSubroutine(options: {
      template: Template;
      initWith: (parentSession: Session) => Session;
      squashWith?: (parentSession: Session, childSession: Session) => Session;
    }): this {
      this.templates.push(new SubroutineTemplate(options));
      return this;
    }
  };
}

/**
 * Template for linear sequence of templates
 */
export class LinearTemplate extends WithSchema(
  WithTransformer(
    WithSubroutine(
      WithIf(
        WithLoop(
          WithSystem(
            WithUser(
              WithAssistant(
                class {
                  templates: Template[] = [];

                  constructor(options?: { templates?: Template[] }) {
                    this.templates = options?.templates || [];
                  }

                  async execute(session: Session<any>): Promise<Session<any>> {
                    let currentSession: Session<any> = session;
                    for (const template of this.templates) {
                      currentSession = await template.execute(currentSession);
                    }
                    return currentSession;
                  }
                },
              ),
            ),
          ),
        ),
      ),
    ),
  ),
) {}

// Agent class is alias for LinearTemplate
export class Agent extends LinearTemplate {
  constructor(options?: { templates?: Template[] }) {
    super(options);
  }
}

/**
 * Template for looping sequence of templates
 */
export class LoopTemplate extends WithSchema(
  WithTransformer(
    WithSubroutine(
      WithIf(
        WithLoop(
          WithSystem(
            WithUser(
              WithAssistant(
                class {
                  templates: Template[] = [];
                  exitCondition?: (session: Session) => boolean;

                  constructor(options?: {
                    templates?: Template[];
                    exitCondition?: (session: Session) => boolean;
                  }) {
                    this.templates = options?.templates || [];
                    this.exitCondition = options?.exitCondition;
                  }

                  setExitCondition(
                    condition: (session: Session) => boolean,
                  ): this {
                    this.exitCondition = condition;
                    return this;
                  }

                  async execute(session: Session): Promise<Session> {
                    if (!this.exitCondition) {
                      throw new Error(
                        'Exit condition not set for LoopTemplate',
                      );
                    }

                    let currentSession = session;

                    do {
                      for (const template of this.templates) {
                        currentSession = await template.execute(currentSession);
                      }
                    } while (!this.exitCondition(currentSession));

                    return currentSession;
                  }
                },
              ),
            ),
          ),
        ),
      ),
    ),
  ),
) {}

/**
 * Template for nested conversations with separate session context
 */
export class SubroutineTemplate extends WithSchema(
  WithTransformer(
    WithSubroutine(
      WithIf(
        WithLoop(
          WithSystem(
            WithUser(
              WithAssistant(
                class {
                  templates: Template[] = [];
                  template!: Template;
                  initWith!: (parentSession: Session) => Session;
                  squashWith?: (
                    parentSession: Session,
                    childSession: Session,
                  ) => Session;

                  constructor(options: {
                    template: Template;
                    initWith: (parentSession: Session) => Session;
                    squashWith?: (
                      parentSession: Session,
                      childSession: Session,
                    ) => Session;
                  }) {
                    this.template = options.template;
                    this.initWith = options.initWith;
                    this.squashWith = options.squashWith;
                  }

                  async execute(session: Session): Promise<Session> {
                    // Create child session using initWith function
                    const childSession = this.initWith(session);

                    // Execute the template with child session
                    const resultSession =
                      await this.template.execute(childSession);

                    // If squashWith is provided, merge results back to parent session
                    if (this.squashWith) {
                      return this.squashWith(session, resultSession);
                    }

                    // Otherwise just return parent session unchanged
                    return session;
                  }
                },
              ),
            ),
          ),
        ),
      ),
    ),
  ),
) {}
