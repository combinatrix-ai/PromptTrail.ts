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
      | ContentSource<string>
      | {
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
  addAssistant(contentOrSource?: string | ContentSource<any>): this {
    if (contentOrSource === undefined) {
      // Create an empty AssistantTemplate that will use the parent's contentSource
      this.templates.push(new AssistantTemplate(''));
    } else {
      this.templates.push(new AssistantTemplate(contentOrSource));
    }
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
  }): this;
  addLoop(
    arg:
      | LoopTemplate
      | {
          templates: Template[];
          exitCondition: (session: ISession) => boolean;
          contentSource?: ContentSource<unknown>;
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
  }): this;
  addLinear(
    arg:
      | LinearTemplate
      | {
          templates: Template[];
          contentSource?: ContentSource<unknown>;
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
    },
  ) {
    super();
    this.contentSource = options.contentSource;
  }

  async execute(
    session?: ISession,
  ): Promise<ISession> {
    const {
      session: validSession,
      contentSource,
    } = TemplateUtils.prepareExecutionOptions(this, session);

    // Create child session using initWith function
    const childSession = this.options.initWith(validSession);

    // If the template doesn't have its own content source but we do, we need to
    // create a new template instance with our content source
    let templateToExecute = this.options.template;
    if (contentSource && !templateToExecute.hasOwnContentSource()) {
      // Create a copy of the template with our content source
      const templateCopy = Object.create(templateToExecute);
      templateCopy.contentSource = contentSource;
      templateToExecute = templateCopy;
    }

    // Execute the template with child session
    const resultSession = await templateToExecute.execute(childSession);

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
  }) {
    super();
    this.templates = options?.templates || [];
    this.exitCondition = options?.exitCondition;
    this.contentSource = options?.contentSource;
  }

  // Add method to set exit condition
  setExitCondition(condition: (session: ISession) => boolean): this {
    this.exitCondition = condition;
    return this;
  }

  async execute(
    session?: ISession,
  ): Promise<ISession> {
    const {
      session: validSession,
      contentSource,
    } = TemplateUtils.prepareExecutionOptions(this, session);

    if (!this.exitCondition) {
      throw new Error('Exit condition not set for LoopTemplate');
    }

    let currentSession = validSession;

    do {
      for (const template of this.templates) {
        // If the template doesn't have its own content source but we do, we need to
        // create a new template instance with our content source
        let templateToExecute = template;
        if (contentSource && !templateToExecute.hasOwnContentSource()) {
          // Create a copy of the template with our content source
          const templateCopy = Object.create(templateToExecute);
          templateCopy.contentSource = contentSource;
          templateToExecute = templateCopy;
        }

        currentSession = await templateToExecute.execute(currentSession);
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
  }) {
    super();
    this.contentSource = options?.contentSource;

    // Add initial templates if provided
    if (options?.templates) {
      for (const template of options.templates) {
        this.addTemplate(template);
      }
    }
  }

  async execute(
    session?: ISession,
  ): Promise<ISession> {
    const {
      session: validSession,
      contentSource,
    } = TemplateUtils.prepareExecutionOptions(this, session);

    let currentSession = validSession;

    for (const template of this.templates) {
      // If the template doesn't have its own content source but we do, we need to
      // create a new template instance with our content source
      let templateToExecute = template;
      if (contentSource && !templateToExecute.hasOwnContentSource()) {
        // Create a copy of the template with our content source
        const templateCopy = Object.create(templateToExecute);
        templateCopy.contentSource = contentSource;
        templateToExecute = templateCopy;
      }

      currentSession = await templateToExecute.execute(currentSession);
    }

    return currentSession;
  }
}

// Alias for LinearTemplate
export class Agent extends LinearTemplate {
  constructor(options?: {
    templates?: Template[];
    contentSource?: ContentSource<unknown>;
  }) {
    super(options);
  }
}
