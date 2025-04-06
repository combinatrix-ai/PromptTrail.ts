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

/**
 * テンプレート操作を提供する中間基底クラス
 * 共通のテンプレート追加メソッドを実装
 */
export abstract class ComposedTemplate extends Template {
  protected templates: Template[] = [];

  /**
   * システムメッセージテンプレートを追加
   */
  addSystem(content: string): this {
    this.templates.push(new SystemTemplate(content));
    return this;
  }

  /**
   * ユーザーメッセージテンプレートを追加
   */
  addUser(
    contentOrInputSource?:
      | string
      | InputSource
      | {
          inputSource?: InputSource;
          description?: string;
          validate?: (input: string) => Promise<boolean>;
          onInput?: (input: string) => void;
          default?: string;
          validator?: IValidator;
        },
  ): this {
    this.templates.push(new UserTemplate(contentOrInputSource));
    return this;
  }

  /**
   * アシスタントメッセージテンプレートを追加
   */
  addAssistant(contentOrGenerateOptions?: string | GenerateOptions): this {
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
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
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
          inputSource?: InputSource;
          generateOptions?: GenerateOptions;
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
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }): this;
  addLoop(
    arg:
      | LoopTemplate
      | {
          templates: Template[];
          exitCondition: (session: ISession) => boolean;
          inputSource?: InputSource;
          generateOptions?: GenerateOptions;
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
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }): this;
  addLinear(
    arg:
      | LinearTemplate
      | {
          templates: Template[];
          inputSource?: InputSource;
          generateOptions?: GenerateOptions;
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
  addTransformer<TOutput extends Record<string, unknown>>(
    transformer: SessionTransformer<Record<string, unknown>, TOutput>,
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
    session?: ISession,
    options?: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ): Promise<ISession>;
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
      inputSource?: InputSource;
      generateOptions?: GenerateOptions;
    },
  ) {
    super();
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
      inputSource,
      generateOptions,
    } = TemplateUtils.prepareExecutionOptions(this, session, options);

    // Create child session using initWith function
    const childSession = this.options.initWith(validSession);

    const childOptions: {
      inputSource?: InputSource;
      generateOptions?: GenerateOptions | string;
    } = {};

    if (inputSource && !this.options.template.hasOwnInputSource()) {
      childOptions.inputSource = inputSource;
    }

    if (
      generateOptions &&
      !this.options.template.hasOwnGenerateOptionsOrContent()
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
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }) {
    super();
    this.templates = options?.templates || [];
    this.exitCondition = options?.exitCondition;
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

        if (inputSource && !template.hasOwnInputSource()) {
          childOptions.inputSource = inputSource;
        }

        if (generateOptions && !template.hasOwnGenerateOptionsOrContent()) {
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
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }) {
    super();
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
      inputSource,
      generateOptions,
    } = TemplateUtils.prepareExecutionOptions(this, session, options);

    let currentSession = validSession;

    for (const template of this.templates) {
      const childOptions: {
        inputSource?: InputSource;
        generateOptions?: GenerateOptions;
      } = {};

      if (inputSource && !template.hasOwnInputSource()) {
        childOptions.inputSource = inputSource;
      }

      if (generateOptions && !template.hasOwnGenerateOptionsOrContent()) {
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
    inputSource?: InputSource;
    generateOptions?: GenerateOptions;
  }) {
    super(options);
  }
}
