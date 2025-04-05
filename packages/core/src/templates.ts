import { createMetadata } from './metadata';
import type { InputSource } from './input_source';
import { StaticInputSource, CallbackInputSource } from './input_source';
import { interpolateTemplate } from './utils/template_interpolation';
import type { SessionTransformer } from './utils/session_transformer';
import { z } from 'zod';
import { generateText } from './generate';
import { type GenerateOptions } from './generate_options';
import type { ISession, ISchemaType } from './types';
import { type IValidator } from './validators/base';
import { CustomValidator } from './validators/custom';

/**
 * Base class for all templates
 */
export abstract class Template<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> {
  abstract execute(session: ISession<TInput>): Promise<ISession<TOutput>>;
}

/**
 * Template for system messages
 */
export class SystemTemplate extends Template {
  constructor(private content: string) {
    super();
  }

  async execute(session: ISession): Promise<ISession> {
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
    validator?: IValidator;
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
          validator?: IValidator;
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

  async execute(session: ISession): Promise<ISession> {
    let input: string;
    let updatedSession = session;
    
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
    } else {
      input = await this.options.inputSource.getInput({
        metadata: session.metadata,
      });
    }
    
    if (this.options.onInput) {
      this.options.onInput(input);
    }
    
    if (this.options.validate && !this.options.validator) {
      const validateFn = this.options.validate;
      this.options.validator = new CustomValidator(
        async (content: string) => {
          const isValid = await validateFn(content);
          return isValid 
            ? { isValid: true } 
            : { isValid: false, instruction: 'Validation failed' };
        },
        { description: 'Input validation' }
      );
    }
    
    updatedSession = updatedSession.addMessage({
      type: 'user',
      content: input,
      metadata: createMetadata(),
    });
    
    if (this.options.validator) {
      let attempts = 0;
      let result = await this.options.validator.validate(input, updatedSession);
      
      while (!result.isValid) {
        attempts++;
        
        updatedSession = updatedSession.addMessage({
          type: 'system',
          content: `Validation failed: ${result.isValid ? '' : result.instruction}. Please try again.`,
          metadata: createMetadata(),
        });
        
        input = await this.options.inputSource.getInput({
          metadata: updatedSession.metadata,
        });
        
        if (this.options.onInput) {
          this.options.onInput(input);
        }
        
        updatedSession = updatedSession.addMessage({
          type: 'user',
          content: input,
          metadata: createMetadata(),
        });
        
        result = await this.options.validator.validate(input, updatedSession);
        
        const validator = this.options.validator as { maxAttempts?: number; raiseErrorAfterMaxAttempts?: boolean };
        if (validator.maxAttempts && attempts >= validator.maxAttempts) {
          if (validator.raiseErrorAfterMaxAttempts) {
            throw new Error(`Input validation failed after ${attempts} attempts: ${result.isValid ? '' : result.instruction}`);
          }
          break;
        }
      }
    }
    
    return updatedSession;
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
    maxAttempts?: number;
    raiseError?: boolean;
  };
  constructor(
    contentOrGenerateOptions: string | GenerateOptions,
    validatorOrOptions?: IValidator | {
      validator?: IValidator;
      maxAttempts?: number;
      raiseError?: boolean;
    }
  ) {
    super();
    if (typeof contentOrGenerateOptions === 'string') {
      if (validatorOrOptions && typeof validatorOrOptions === 'object' && !('validate' in validatorOrOptions)) {
        this.options = {
          content: contentOrGenerateOptions,
          validator: validatorOrOptions.validator,
          maxAttempts: validatorOrOptions.maxAttempts,
          raiseError: validatorOrOptions.raiseError,
        };
      } else {
        this.options = {
          content: contentOrGenerateOptions,
          validator: validatorOrOptions as IValidator | undefined,
          maxAttempts: 1,
          raiseError: true,
        };
      }
    } else {
      if (validatorOrOptions && typeof validatorOrOptions === 'object' && !('validate' in validatorOrOptions)) {
        this.options = {
          generateOptions: contentOrGenerateOptions,
          validator: validatorOrOptions.validator,
          maxAttempts: validatorOrOptions.maxAttempts,
          raiseError: validatorOrOptions.raiseError,
        };
      } else {
        this.options = {
          generateOptions: contentOrGenerateOptions,
          validator: validatorOrOptions as IValidator | undefined,
          maxAttempts: 1,
          raiseError: true,
        };
      }
    }
    
    if (this.options.maxAttempts === undefined) {
      this.options.maxAttempts = 1;
    }
    if (this.options.raiseError === undefined) {
      this.options.raiseError = true;
    }
  }

  async execute(session: ISession<TInput>): Promise<ISession<TOutput>> {
    if (this.options.content) {
      // For fixed content responses
      const interpolatedContent = interpolateTemplate(
        this.options.content,
        session.metadata,
      );
      
      if (this.options.validator) {
        const result = await this.options.validator.validate(interpolatedContent, session as ISession);
        if (!result.isValid) {
          if (this.options.raiseError) {
            throw new Error(`Assistant content validation failed: ${result.instruction || 'Invalid content'}`);
          }
        }
      }
      
      return session.addMessage({
        type: 'assistant',
        content: interpolatedContent,
        metadata: createMetadata(),
      }) as unknown as ISession<TOutput>;
    }

    if (!this.options.generateOptions) {
      throw new Error('generateOptions is required for AssistantTemplate');
    }

    let attempts = 0;
    let lastValidationError: string | undefined;
    
    while (attempts < (this.options.maxAttempts || 1)) {
      attempts++;
      
      // Cast session to any to avoid type issues with the generateText function
      const response = await generateText(
        session as ISession,
        this.options.generateOptions,
      );
      
      if (!this.options.validator || response.type !== 'assistant' || !response.content) {
        // Add the assistant message to the session
        return session.addMessage(
          response,
        ) as unknown as ISession<TOutput>;
      }
      
      const result = await this.options.validator.validate(response.content, session as ISession);
      if (result.isValid) {
        return session.addMessage(
          response,
        ) as unknown as ISession<TOutput>;
      }
      
      lastValidationError = result.instruction || 'Invalid content';
      
      if (attempts >= (this.options.maxAttempts || 1) && this.options.raiseError) {
        throw new Error(`Assistant response validation failed after ${attempts} attempts: ${lastValidationError}`);
      }
    }
    
    const finalResponse = await generateText(
      session as ISession,
      this.options.generateOptions,
    );
    
    // Add the assistant message to the session
    let updatedSession = session.addMessage(
      finalResponse,
    ) as unknown as ISession<TOutput>;

    const toolCalls =
      finalResponse.type === 'assistant' ? finalResponse.toolCalls : undefined;

    if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
      // Execute each tool call and add the result as a tool_result message
      for (const toolCall of toolCalls) {
        const toolName = toolCall.name;
        const toolArgs = toolCall.arguments;
        const toolCallId = toolCall.id;

        // Get the tool from the generateOptions
        const tools = this.options.generateOptions.tools || {};
        const tool = tools[toolName] as { execute: (args: Record<string, unknown>, context: { toolCallId: string }) => Promise<unknown> }; // Cast to specific type

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
              updatedSession as ISession<Record<string, unknown>>,
            )) as ISession<TOutput>;
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
              updatedSession as ISession<Record<string, unknown>>,
            )) as ISession<TOutput>;
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

  async execute(session: ISession<TInput>): Promise<ISession<TOutput>> {
    const metadata = createMetadata<{ toolCallId: string }>();
    metadata.set('toolCallId', this.options.toolCallId);

    return session.addMessage({
      type: 'tool_result',
      content: this.options.content,
      metadata,
      result: this.options.content, // Add the result property
    }) as unknown as ISession<TOutput>;
  }
}

/**
 * Template for conditional execution based on a condition
 */
export class IfTemplate extends Template {
  constructor(
    private options: {
      condition: (session: ISession) => boolean;
      thenTemplate: Template;
      elseTemplate?: Template;
    },
  ) {
    super();
  }

  async execute(session: ISession): Promise<ISession> {
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T = Record<string, unknown>> = new (...args: any[]) => T;

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
      condition: (session: ISession) => boolean;
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
        new TransformerTemplate(castTransformer),
      );
      return this as unknown as LinearTemplate;
    }
  };
}

function WithSchema<TBase extends Constructor<{ templates: Template[] }>>(
  Base: TBase,
) {
  return class extends Base {
    async addSchema<TSchema extends ISchemaType | z.ZodType>(
      schema: TSchema,
      options: {
        generateOptions: GenerateOptions;
        maxAttempts?: number;
        functionName?: string;
      },
    ): Promise<this> {
      // Import SchemaTemplate dynamically to avoid circular dependency
      // Use dynamic import for ESM compatibility
      const SchemaTemplateModule = await import('./schema_template');
      const { SchemaTemplate } = SchemaTemplateModule;

      this.templates.push(
        new SchemaTemplate({
          generateOptions: options.generateOptions,
          schema: schema as z.ZodType,
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
      initWith: (parentSession: ISession) => ISession;
      squashWith?: (parentSession: ISession, childSession: ISession) => ISession;
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

                  async execute(session: ISession<Record<string, unknown>>): Promise<ISession<Record<string, unknown>>> {
                    let currentSession: ISession<Record<string, unknown>> = session;
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
                  exitCondition?: (session: ISession) => boolean;

                  constructor(options?: {
                    templates?: Template[];
                    exitCondition?: (session: ISession) => boolean;
                  }) {
                    this.templates = options?.templates || [];
                    this.exitCondition = options?.exitCondition;
                  }

                  setExitCondition(
                    condition: (session: ISession) => boolean,
                  ): this {
                    this.exitCondition = condition;
                    return this;
                  }

                  async execute(session: ISession): Promise<ISession> {
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
                  initWith!: (parentSession: ISession) => ISession;
                  squashWith?: (
                    parentSession: ISession,
                    childSession: ISession,
                  ) => ISession;

                  constructor(options: {
                    template: Template;
                    initWith: (parentSession: ISession) => ISession;
                    squashWith?: (
                      parentSession: ISession,
                      childSession: ISession,
                    ) => ISession;
                  }) {
                    this.template = options.template;
                    this.initWith = options.initWith;
                    this.squashWith = options.squashWith;
                  }

                  async execute(session: ISession): Promise<ISession> {
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

/**
 * Template that applies a transformer to a session
 */
export class TransformerTemplate extends Template {
  constructor(private transformer: SessionTransformer<
    Record<string, unknown>,
    Record<string, unknown>
  >) {
    super();
  }

  async execute(session: ISession): Promise<ISession> {
    return this.transformer.transform(session);
  }
}
