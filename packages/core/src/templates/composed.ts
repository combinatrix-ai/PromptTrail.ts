import type { GenerateOptions } from '../generate_options';
import type { InputSource } from '../input_source';
import type { ISession } from '../types';
import type { SessionTransformer } from '../utils';
import type { IValidator } from '../validators';
import {
  AssistantTemplate,
  IfTemplate,
  SystemTemplate,
  Template,
  TemplateUtils,
  TransformerTemplate,
  UserTemplate,
} from './basic';
import { ContentSource } from '../content_source';

/**
 * テンプレート操作を提供する中間基底クラス
 * 共通のテンプレート追加メソッドを実装
 */
export abstract class ComposedTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
  TContentType = unknown,
> extends Template<TInput, TOutput, TContentType> {
  protected templates: Template[] = [];

  /**
   * システムメッセージテンプレートを追加
   */
  addSystem(content: string | ContentSource<string>): this {
    this.templates.push(new SystemTemplate(content));
    return this;
  }

  /**
   * ユーザーメッセージテンプレートを追加
   */
  addUser(
    contentOrSource?:
      | string
      | InputSource
      | ContentSource<string>
      | {
          inputSource?: InputSource;
          contentSource?: ContentSource<string>;
          description?: string;
          validate?: (input: string) => Promise<boolean>;
          onInput?: (input: string) => void;
          default?: string;
          validator?: IValidator;
        },
  ): this {
    this.templates.push(new UserTemplate(contentOrSource));
    return this;
  }

  /**
   * アシスタントメッセージテンプレートを追加
   */
  addAssistant(contentOrGenerateOptions?: string | GenerateOptions | ContentSource<any>): this {
    this.templates.push(new AssistantTemplate(contentOrGenerateOptions));
    return this;
  }

  /**
   * 条件付きテンプレートを追加
   */
  addIf(template: IfTemplate): this;
  addIf(options: {
    condition: (session: ISession) => boolean;
    thenTemplate: Template;
    elseTemplate?: Template;
  }): this;
  addIf(
    arg:
      | IfTemplate
      | {
          condition: (session: ISession) => boolean;
          thenTemplate: Template;
          elseTemplate?: Template;
        },
  ): this {
    const template = arg instanceof IfTemplate ? arg : new IfTemplate(arg);
    this.templates.push(template);
    return this;
  }

  /**
   * サブルーチンテンプレートを追加
   */
  addSubroutine(template: SubroutineTemplate): this;
  addSubroutine(options: {
    template: Template;
    initWith: (parentSession: ISession) => ISession;
    squashWith?: (parentSession: ISession, childSession: ISession) => ISession;
    contentSource?: ContentSource<unknown>;
    inputSource?: InputSource; // For backward compatibility
    generateOptions?: GenerateOptions; // For backward compatibility
  }): this;
  addSubroutine(
    arg:
      | SubroutineTemplate
      | {
          template: Template;
          initWith: (parentSession: ISession) => ISession;
          squashWith?: (
            parentSession: ISession,
            childSession: ISession,
          ) => ISession;
          contentSource?: ContentSource<unknown>;
          inputSource?: InputSource; // For backward compatibility
          generateOptions?: GenerateOptions; // For backward compatibility
        },
  ): this {
    const template =
      arg instanceof SubroutineTemplate ? arg : new SubroutineTemplate(arg);
    this.templates.push(template);
    return this;
  }

  /**
   * ループテンプレートを追加
   */
  addLoop(template: LoopTemplate): this;
  addLoop(options: {
    templates: Template[];
    exitCondition: (session: ISession) => boolean;
    contentSource?: ContentSource<unknown>;
    inputSource?: InputSource; // For backward compatibility
    generateOptions?: GenerateOptions; // For backward compatibility
  }): this;
  addLoop(
    arg:
      | LoopTemplate
      | {
          templates: Template[];
          exitCondition: (session: ISession) => boolean;
          contentSource?: ContentSource<unknown>;
          inputSource?: InputSource; // For backward compatibility
          generateOptions?: GenerateOptions; // For backward compatibility
        },
  ): this {
    const template = arg instanceof LoopTemplate ? arg : new LoopTemplate(arg);
    this.templates.push(template);
    return this;
  }

  /**
   * Linearテンプレートを追加
   */
  addLinear(template: LinearTemplate): this;
  addLinear(options: {
    templates: Template[];
    contentSource?: ContentSource<unknown>;
    inputSource?: InputSource; // For backward compatibility
    generateOptions?: GenerateOptions; // For backward compatibility
  }): this;
  addLinear(
    arg:
      | LinearTemplate
      | {
          templates: Template[];
          contentSource?: ContentSource<unknown>;
          inputSource?: InputSource; // For backward compatibility
          generateOptions?: GenerateOptions; // For backward compatibility
        },
  ): this {
    const template =
      arg instanceof LinearTemplate ? arg : new LinearTemplate(arg);
    this.templates.push(template);
    return this;
  }

  /**
   * トランスフォーマーテンプレートを追加
   */
  addTransformer(
    transformer: SessionTransformer<Record<string, unknown>, Record<string, unknown>>,
  ): this {
    this.templates.push(new TransformerTemplate(transformer));
    return this;
  }

  /**
   * 任意のテンプレートを追加
   */
  addTemplate(template: Template): this {
    this.templates.push(template);
    return this;
  }

  /**
   * テンプレートの取得
   */
  getTemplates(): Template[] {
    return this.templates;
  }

  /**
   * テンプレートの設定
   */
  setTemplates(templates: Template[]): this {
    this.templates = templates;
    return this;
  }

  /**
   * テンプレートの実行（サブクラスで実装）
   */
  abstract execute(
    session?: ISession<TInput>,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions | string;
    },
  ): Promise<ISession<TOutput>>;
}

/**
 * Template for nested conversations with separate session context
 */
export class SubroutineTemplate extends ComposedTemplate {
  constructor(
    private options: {
      template: Template;
      initWith: (parentSession: ISession) => ISession;
      squashWith?: (
        parentSession: ISession,
        childSession: ISession,
      ) => ISession;
      contentSource?: ContentSource<unknown>;
      inputSource?: InputSource; // For backward compatibility
      generateOptions?: GenerateOptions; // For backward compatibility
    },
  ) {
    super();
    this.contentSource = options.contentSource;
    // For backward compatibility
    this.inputSource = options.inputSource;
    this.generateOptionsOrContent = options.generateOptions;
  }

  async execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    const {
      session: validSession,
      contentSource,
      inputSource,
      generateOptions,
    } = TemplateUtils.prepareExecutionOptions(this, session, options);

    // Create child session using initWith function
    const childSession = this.options.initWith(validSession);

    const childOptions: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions | string;
    } = {};

    // Propagate contentSource if template doesn't have its own
    if (contentSource && !this.options.template.hasOwnContentSource?.()) {
      // We can't directly pass contentSource since the execute method doesn't accept it
      // This will be handled by the template's execute method
    }

    // For backward compatibility
    if (inputSource && !this.options.template.hasOwnInputSource?.()) {
      childOptions.inputSource = inputSource;
    }

    if (
      generateOptions &&
      !this.options.template.hasOwnGenerateOptionsOrContent?.()
    ) {
      childOptions.generateOptions = generateOptions;
    }

    // Execute the template with child session
    const resultSession = await this.options.template.execute(
      childSession,
      childOptions,
    );

    // If squashWith is provided, merge results back to parent session
    if (this.options.squashWith) {
      return this.options.squashWith(validSession, resultSession);
    }

    // Otherwise just return parent session unchanged
    return validSession;
  }
}

/**
 * Class for looping sequences of templates
 */
export class LoopTemplate extends ComposedTemplate {
  private exitCondition?: (session: ISession) => boolean;

  constructor(options?: {
    templates?: Template[];
    exitCondition?: (session: ISession) => boolean;
    contentSource?: ContentSource<unknown>;
    inputSource?: InputSource; // For backward compatibility
    generateOptions?: GenerateOptions; // For backward compatibility
  }) {
    super();
    this.templates = options?.templates || [];
    this.exitCondition = options?.exitCondition;
    this.contentSource = options?.contentSource;
    // For backward compatibility
    this.inputSource = options?.inputSource;
    this.generateOptionsOrContent = options?.generateOptions;
  }

  // Add method to set exit condition
  setExitCondition(condition: (session: ISession) => boolean): this {
    this.exitCondition = condition;
    return this;
  }

  async execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    const {
      session: validSession,
      contentSource,
      inputSource,
      generateOptions,
    } = TemplateUtils.prepareExecutionOptions(this, session, options);

    if (!this.exitCondition) {
      throw new Error('Exit condition not set for LoopTemplate');
    }

    let currentSession = validSession;

    do {
      for (const template of this.templates) {
        const childOptions: {
          inputSource?: InputSource;
          generateOptions?: GenerateOptions | string;
        } = {};

        // Propagate contentSource if template doesn't have its own
        if (contentSource && !template.hasOwnContentSource?.()) {
          // We can't directly pass contentSource since the execute method doesn't accept it
          // This will be handled by the template's execute method
        }

        // For backward compatibility
        if (inputSource && !template.hasOwnInputSource?.()) {
          childOptions.inputSource = inputSource;
        }

        if (generateOptions && !template.hasOwnGenerateOptionsOrContent?.()) {
          childOptions.generateOptions = generateOptions;
        }

        currentSession = await template.execute(currentSession, childOptions);
      }
    } while (!this.exitCondition(currentSession));

    return currentSession;
  }
}

/**
 * Linear template composition with fluent API for creating template chains
 */
export class LinearTemplate extends ComposedTemplate {
  constructor(options?: {
    templates?: Template[];
    contentSource?: ContentSource<unknown>;
    inputSource?: InputSource; // For backward compatibility
    generateOptions?: GenerateOptions; // For backward compatibility
  }) {
    super();
    this.contentSource = options?.contentSource;
    // For backward compatibility
    this.inputSource = options?.inputSource;
    this.generateOptionsOrContent = options?.generateOptions;

    // Add initial templates if provided
    if (options?.templates) {
      for (const template of options.templates) {
        this.addTemplate(template);
      }
    }
  }

  async execute(
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession> {
    const {
      session: validSession,
      contentSource,
      inputSource,
      generateOptions,
    } = TemplateUtils.prepareExecutionOptions(this, session, options);

    let currentSession = validSession;

    for (const template of this.templates) {
      const childOptions: {
        inputSource?: InputSource;
        generateOptions?: GenerateOptions;
      } = {};

      // Propagate contentSource if template doesn't have its own
      if (contentSource && !template.hasOwnContentSource?.()) {
        // We can't directly pass contentSource since the execute method doesn't accept it
        // This will be handled by the template's execute method
      }

      // For backward compatibility
      if (inputSource && !template.hasOwnInputSource?.()) {
        childOptions.inputSource = inputSource;
      }

      if (generateOptions && !template.hasOwnGenerateOptionsOrContent?.()) {
        childOptions.generateOptions = generateOptions as GenerateOptions;
      }

      currentSession = await template.execute(currentSession, childOptions);
    }

    return currentSession;
  }
}

// Alias for LinearTemplate
export class Agent extends LinearTemplate {
  constructor(options?: {
    templates?: Template[];
    contentSource?: ContentSource<unknown>;
    inputSource?: InputSource; // For backward compatibility
    generateOptions?: GenerateOptions; // For backward compatibility
  }) {
    super(options);
  }
}
