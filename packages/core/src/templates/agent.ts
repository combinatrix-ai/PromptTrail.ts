import { Session, type Attrs, type Vars } from '../session';
import type { CodexTurnOptions } from '../codex_app_server';
import type { ClaudeTurnOptions } from '../claude_agent';
import {
  app as createDurableApp,
  type DurableRunStore,
  type RunStore,
} from '../durable';
import {
  type ObserverDeliveryBindingOptions,
  type ObserverLike,
} from '../execution';
import {
  createAgentGraph,
  type AgentGraph,
  type AgentGraphNode,
} from '../graph';
import {
  executeAgentGraph,
  type GraphInboundInput,
  type GraphExecutionOptions,
} from '../graph_executor';
import { Message, type Message as PromptTrailMessage } from '../message';
import {
  createExecutionRuntimeState,
  type ExecutionRuntimeState,
  type HookDefinition,
  type MiddlewareDefinition,
} from '../interceptors';
import { ModelOutput, Source, ValidationOptions } from '../source';
import type { PromptTrailTool } from '../tool';
import { IValidator } from '../validators';
import type { Template } from './base';
import { Fluent } from './composite/chainable';
import { Composite } from './composite/composite';
import { Loop } from './composite/loop';
import { Parallel } from './composite/parallel';
import { Sequence } from './composite/sequence';
import { Subroutine } from './composite/subroutine';
import { Assistant } from './primitives/assistant';
import { ClaudeTurn } from './primitives/claude_turn';
import { CodexTurn } from './primitives/codex_turn';
import { Conditional } from './primitives/conditional';
import {
  GenerateMessages,
  type GenerateMessagesFn,
} from './primitives/messages';
import { Structured } from './primitives/structured';
import { System } from './primitives/system';
import { Transform } from './primitives/transform';
import { User } from './primitives/user';
import { ISubroutineTemplateOptions } from './template_types';

type AgentGraphAssistantHandler<TC extends Vars, TM extends Attrs> = (
  session: Session<TC, TM>,
  runtime?: AgentGraphHandlerRuntime,
) => unknown | Promise<unknown>;

type AgentGraphAssistantInput<TC extends Vars, TM extends Attrs> =
  | string
  | Source<ModelOutput>
  | Source<string>
  | AgentGraphAssistantHandler<TC, TM>;

type AgentGraphMessagesHandler<TC extends Vars, TM extends Attrs> = (
  session: Session<TC, TM>,
  runtime?: AgentGraphHandlerRuntime,
) =>
  | PromptTrailMessage<TM>
  | readonly PromptTrailMessage<TM>[]
  | Promise<PromptTrailMessage<TM> | readonly PromptTrailMessage<TM>[]>;

type AgentGraphPatchHandler<TC extends Vars, TM extends Attrs> = (
  session: Session<TC, TM>,
  runtime?: AgentGraphHandlerRuntime,
) => Session<TC, TM> | void | Promise<Session<TC, TM> | void>;

export interface AgentGraphHandlerRuntime {
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

export type AgentGraphCondition<
  TC extends Vars = Vars,
  TM extends Attrs = Attrs,
> =
  | boolean
  | ((context: {
      session: Session<TC, TM>;
      context?: Record<string, unknown>;
      signal?: AbortSignal;
    }) => boolean);

export interface AgentGraphLoopOptions {
  maxIterations?: number;
}

export interface AgentGoalSatisfactionContext<
  TC extends Vars = Vars,
  TM extends Attrs = Attrs,
> {
  session: Session<TC, TM>;
  goal: string;
  attempt: number;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AgentGoalOptions<
  TC extends Vars = Vars,
  TM extends Attrs = Attrs,
> {
  interaction?: 'none' | 'optional' | 'required';
  maxAttempts?: number;
  tools?: readonly string[] | Record<string, PromptTrailTool<any, any>>;
  model?: Source<ModelOutput> | AgentGraphAssistantHandler<TC, TM>;
  isSatisfied?: (
    context: AgentGoalSatisfactionContext<TC, TM>,
  ) => boolean | Promise<boolean>;
  onUnsatisfied?: 'retry' | 'continue' | 'halt';
}

export interface AgentGraphExecutionOptions<
  TC extends Vars = Vars,
  TM extends Attrs = Attrs,
> extends GraphExecutionOptions<TC, TM>,
    AgentExecutionOptions {
  version?: string;
}

export interface AgentExecuteOptions<
  TC extends Vars = Vars,
  TM extends Attrs = Attrs,
> extends AgentGraphExecutionOptions<TC, TM> {}

/**
 * Agent class for building and executing templates
 * @template TAttrs - The metadata type.
 * @template TVars - The context type.
 * @class
 * @public
 * @remarks
 * This class provides a fluent interface for creating and executing templates,
 * allowing for the addition of system, user, and assistant messages,
 * as well as the ability to define loops and subroutines.
 * It serves as a builder for complex template compositions.
 * The templates can be executed in a sequence or as part of a subroutine,
 * enabling flexible and reusable template structures.
 * The class also supports the addition of custom exit conditions for loops
 * and the ability to retain messages or isolate context in subroutines.
 * The Agent class is designed to be extensible and customizable,
 * allowing developers to create sophisticated conversational agents
 * with complex logic and context management.
 * It is a key component of the template system, enabling the creation
 * of dynamic and interactive conversational experiences.
 * @example
 * const agent = Agent.quick()
 *   .system('System message')
 *   .user('User message')
 *   .assistant('Assistant message')
 *   .loop(agent => agent.user('Input'), condition)
 *   .subroutine(agent => agent.user('Sub'));
 */
export class Agent<TC extends Vars = Vars, TM extends Attrs = Attrs> {
  private constructor(
    private readonly root: Fluent<TM, TC> = new Sequence<TM, TC>(),
    private readonly graphName?: string,
    private readonly quickMode = false,
  ) {}

  private readonly graphNodes: AgentGraphNode[] = [];
  private readonly graphTools: Record<string, PromptTrailTool<any, any>> = {};
  private readonly middleware: MiddlewareDefinition<TC, TM>[] = [];
  private readonly hooks: HookDefinition<TC, TM>[] = [];
  private readonly observers: ObserverLike[] = [];
  private directCheckpointOptions?: AgentCheckpointOption;
  private directDurableStore?: DurableRunStore;
  private directDurableRunId?: string;

  private isGraphAuthoringMode(): boolean {
    return this.graphName !== undefined || this.graphNodes.length > 0;
  }

  get name(): string | undefined {
    return this.graphName;
  }

  private hasInterceptors(): boolean {
    return (
      this.middleware.length > 0 ||
      this.hooks.length > 0 ||
      this.observers.length > 0
    );
  }

  private assertGraphExecutionSupported(
    options: AgentGraphExecutionOptions<TC, TM> | undefined,
  ): void {
    const rawOptions = options as Record<string, unknown> | undefined;
    const unsupportedOption = ['runId'].find((key) => {
      if (!rawOptions || !(key in rawOptions)) {
        return false;
      }
      return (
        rawOptions.checkpoint === undefined && !this.directCheckpointOptions
      );
    });
    if (unsupportedOption) {
      throw new Error(
        `Graph Agent.execute option ${unsupportedOption} requires checkpoint execution.`,
      );
    }
  }

  /** Static factory methods -------------------------------------------------- */

  static create<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    name: string,
  ): Agent<TC, TM>;
  static create<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    name?: string,
  ) {
    if (!name) {
      throw new Error('Agent.create(name) requires a stable agent name.');
    }
    return new Agent<TC, TM>(new Sequence<TM, TC>(), name);
  }

  static quick<TC extends Vars = Vars, TM extends Attrs = Attrs>(): Agent<
    TC,
    TM
  > {
    return new Agent<TC, TM>(new Sequence<TM, TC>(), undefined, true);
  }

  /** fluent helpers -------------------------------------------------- */

  add(t: Template<TM, TC>) {
    if (this.isGraphAuthoringMode()) {
      throw new Error(
        'Graph Agent.add does not support legacy templates after graph authoring starts.',
      );
    }
    this.root.add(t);
    return this;
  }

  use(middleware: MiddlewareDefinition<TC, TM>) {
    this.middleware.push(middleware);
    return this;
  }

  hook(hook: HookDefinition<TC, TM>) {
    this.hooks.push(hook);
    return this;
  }

  observe(observer: ObserverLike) {
    this.observers.push(observer);
    return this;
  }

  tool(name: string, tool: PromptTrailTool<any, any>) {
    this.graphTools[name] = tool;
    return this;
  }

  toGraph(version?: string): AgentGraph {
    if (!this.graphName) {
      throw new Error('Agent.toGraph requires Agent.create(name).');
    }
    return createAgentGraph({
      name: this.graphName,
      version,
      nodes:
        this.graphNodes.length > 0
          ? this.graphNodes
          : compileLegacyRootTemplate(this.root as Composite<TM, TC>),
      tools: this.graphTools,
      middleware: this.middleware,
      hooks: this.hooks,
      observers: this.observers,
    });
  }

  checkpoint(options: AgentCheckpointOption = true) {
    if (this.quickMode) {
      throw new Error('Agent.quick() does not support checkpoint execution.');
    }
    this.directCheckpointOptions = options;
    const checkpointStore = checkpointOptionStore(options);
    if (checkpointStore) {
      this.directDurableStore = checkpointStore;
    }
    return this;
  }

  system(content: string): this;
  system(id: string, content: string): this;
  system(idOrContent: string, content?: string) {
    if (this.graphName) {
      if (content === undefined) {
        throw new Error('Graph Agent.system requires system(id, content).');
      }
      this.graphNodes.push({
        id: idOrContent,
        type: 'system',
        data: { content },
      });
      return this;
    }
    const resolvedContent = content ?? idOrContent;
    if (content !== undefined) {
      this.graphNodes.push({
        id: idOrContent,
        type: 'system',
        data: { content },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error('Graph Agent.system requires system(id, content).');
    }
    this.root.add(new System(resolvedContent));
    return this;
  }

  user(contentOrSource?: string | Source<string>): this;
  user(id: string, contentOrSource?: string | Source<string>): this;
  user(
    idOrContentOrSource?: string | Source<string>,
    contentOrSource?: string | Source<string>,
  ) {
    if (this.graphName) {
      this.graphNodes.push({
        id: idOrContentOrSource as string,
        type: 'user',
        data:
          contentOrSource === undefined
            ? undefined
            : { input: contentOrSource },
      });
      return this;
    }
    if (contentOrSource !== undefined) {
      this.graphNodes.push({
        id: idOrContentOrSource as string,
        type: 'user',
        data: { input: contentOrSource },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error('Graph Agent.user requires user(id, contentOrSource).');
    }
    this.root.add(new User(idOrContentOrSource));
    return this;
  }

  assistant(
    contentOrSource?: string | Source<ModelOutput> | Source<string>,
    validatorOrOptions?: IValidator | ValidationOptions,
  ): this;
  assistant(
    id: string,
    sourceOrHandler?: AgentGraphAssistantInput<TC, TM>,
    options?: Record<string, unknown>,
  ): this;
  assistant(
    contentOrSource?: string | Source<ModelOutput> | Source<string>,
    validatorOrOptions?:
      | IValidator
      | ValidationOptions
      | AgentGraphAssistantInput<TC, TM>,
    maybeOptions?: Record<string, unknown>,
  ) {
    if (
      this.graphName ||
      maybeOptions !== undefined ||
      isGraphAssistantInput(validatorOrOptions)
    ) {
      this.graphNodes.push({
        id: contentOrSource as string,
        type: 'assistant',
        data: compactGraphData({
          input: validatorOrOptions,
          options: maybeOptions,
        }),
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error(
        'Graph Agent.assistant requires assistant(id, sourceOrHandler).',
      );
    }
    this.root.add(
      new Assistant(
        contentOrSource,
        validatorOrOptions as IValidator | ValidationOptions | undefined,
      ),
    );
    return this;
  }

  goal(id: string, goal: string, options: AgentGoalOptions<TC, TM> = {}): this {
    this.graphNodes.push(createGoalGraphNode(id, goal, options));
    return this;
  }

  inbox(id: string, options?: Record<string, unknown>): this {
    this.graphNodes.push({ id, type: 'inbox', data: options });
    return this;
  }

  tools(id: string, options?: Record<string, unknown>): this {
    this.graphNodes.push({ id, type: 'tools', data: options });
    return this;
  }

  awaitInput(id: string, options?: Record<string, unknown>): this {
    this.graphNodes.push({ id, type: 'awaitInput', data: options });
    return this;
  }

  patch(handler: AgentGraphPatchHandler<TC, TM>): this;
  patch(id: string, handler: AgentGraphPatchHandler<TC, TM>): this;
  patch(
    idOrHandler: string | AgentGraphPatchHandler<TC, TM>,
    handler?: AgentGraphPatchHandler<TC, TM>,
  ) {
    if (this.graphName || handler !== undefined) {
      if (typeof idOrHandler !== 'string' || !handler) {
        throw new Error('Graph Agent.patch requires patch(id, handler).');
      }
      this.graphNodes.push({
        id: idOrHandler,
        type: 'patch',
        data: { handler },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error('Graph Agent.patch requires patch(id, handler).');
    }
    this.root.add(
      new Transform(async (session) => {
        const result = await (idOrHandler as AgentGraphPatchHandler<TC, TM>)(
          session,
        );
        return result ?? session;
      }),
    );
    return this;
  }

  transform(transform: (s: Session<TC, TM>) => Session<TC, TM>): this;
  transform(
    id: string,
    transform: (s: Session<TC, TM>) => Session<TC, TM>,
  ): this;
  transform(
    idOrTransform: string | ((s: Session<TC, TM>) => Session<TC, TM>),
    maybeTransform?: (s: Session<TC, TM>) => Session<TC, TM>,
  ) {
    if (typeof idOrTransform === 'string') {
      if (!maybeTransform) {
        throw new Error(
          'Graph Agent.transform requires transform(id, handler).',
        );
      }
      this.graphNodes.push({
        id: idOrTransform,
        type: 'transform',
        data: { handler: maybeTransform },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error('Graph Agent.transform requires transform(id, handler).');
    }
    this.root.add(new Transform(idOrTransform));
    return this;
  }

  messages(generateMessages: GenerateMessagesFn<TM, TC>): this;
  messages(
    id: string,
    generateMessages: AgentGraphMessagesHandler<TC, TM>,
  ): this;
  messages(
    idOrGenerateMessages:
      | string
      | GenerateMessagesFn<TM, TC>
      | AgentGraphMessagesHandler<TC, TM>,
    generateMessages?: AgentGraphMessagesHandler<TC, TM>,
  ) {
    if (this.graphName || generateMessages !== undefined) {
      if (typeof idOrGenerateMessages !== 'string' || !generateMessages) {
        throw new Error('Graph Agent.messages requires messages(id, handler).');
      }
      this.graphNodes.push({
        id: idOrGenerateMessages,
        type: 'messages',
        data: { handler: generateMessages },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error('Graph Agent.messages requires messages(id, handler).');
    }
    this.root.add(
      new GenerateMessages(idOrGenerateMessages as GenerateMessagesFn<TM, TC>),
    );
    return this;
  }

  codex(options: CodexTurnOptions<TM, TC>): this;
  codex(id: string, options: CodexTurnOptions<TM, TC>): this;
  codex(
    idOrOptions: string | CodexTurnOptions<TM, TC>,
    maybeOptions?: CodexTurnOptions<TM, TC>,
  ) {
    if (typeof idOrOptions === 'string') {
      if (!maybeOptions) {
        throw new Error('Graph Agent.codex requires codex(id, options).');
      }
      this.graphNodes.push({
        id: idOrOptions,
        type: 'codexTurn',
        data: { template: new CodexTurn(maybeOptions) },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error('Graph Agent.codex requires codex(id, options).');
    }
    this.root.add(new CodexTurn(idOrOptions));
    return this;
  }

  claude(options: ClaudeTurnOptions<TM, TC>): this;
  claude(id: string, options: ClaudeTurnOptions<TM, TC>): this;
  claude(
    idOrOptions: string | ClaudeTurnOptions<TM, TC>,
    maybeOptions?: ClaudeTurnOptions<TM, TC>,
  ) {
    if (typeof idOrOptions === 'string') {
      if (!maybeOptions) {
        throw new Error('Graph Agent.claude requires claude(id, options).');
      }
      this.graphNodes.push({
        id: idOrOptions,
        type: 'claudeTurn',
        data: { template: new ClaudeTurn(maybeOptions) },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error('Graph Agent.claude requires claude(id, options).');
    }
    this.root.add(new ClaudeTurn(idOrOptions));
    return this;
  }

  parallel(template: Parallel<TM, TC>): this;
  parallel(id: string, template: Parallel<TM, TC>): this;
  parallel(
    idOrTemplate: string | Parallel<TM, TC>,
    maybeTemplate?: Parallel<TM, TC>,
  ) {
    if (typeof idOrTemplate === 'string') {
      if (!maybeTemplate) {
        throw new Error(
          'Graph Agent.parallel requires parallel(id, template).',
        );
      }
      this.graphNodes.push({
        id: idOrTemplate,
        type: 'parallel',
        data: { template: maybeTemplate },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error('Graph Agent.parallel requires parallel(id, template).');
    }
    this.root.add(idOrTemplate);
    return this;
  }

  structured(template: Structured<TM, TC>): this;
  structured(id: string, template: Structured<TM, TC>): this;
  structured(
    idOrTemplate: string | Structured<TM, TC>,
    maybeTemplate?: Structured<TM, TC>,
  ) {
    if (typeof idOrTemplate === 'string') {
      if (!maybeTemplate) {
        throw new Error(
          'Graph Agent.structured requires structured(id, template).',
        );
      }
      this.graphNodes.push({
        id: idOrTemplate,
        type: 'structured',
        data: { template: maybeTemplate },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error(
        'Graph Agent.structured requires structured(id, template).',
      );
    }
    this.root.add(idOrTemplate);
    return this;
  }

  /** Function-based template builders -------------------------------------------------- */

  loop(
    id: string,
    builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    loopIf: AgentGraphCondition<TC, TM>,
    options?: AgentGraphLoopOptions,
  ): this;
  loop(
    builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    loopIf: boolean | ((s: Session<TC, TM>) => boolean),
    maxIterations?: number,
  ): this;
  loop(
    idOrBuilderFn: string | ((agent: Agent<TC, TM>) => Agent<TC, TM>),
    builderOrLoopIf:
      | ((agent: Agent<TC, TM>) => Agent<TC, TM>)
      | boolean
      | ((s: Session<TC, TM>) => boolean)
      | AgentGraphCondition<TC, TM>,
    loopIfOrMaxIterations?:
      | AgentGraphCondition<TC, TM>
      | boolean
      | ((s: Session<TC, TM>) => boolean)
      | number,
    maybeOptions?: AgentGraphLoopOptions,
  ): this {
    if (typeof idOrBuilderFn === 'string') {
      const builderFn = builderOrLoopIf as (
        agent: Agent<TC, TM>,
      ) => Agent<TC, TM>;
      const innerAgent = Agent.create<TC, TM>(idOrBuilderFn);
      const builtAgent = builderFn(innerAgent);
      this.graphNodes.push({
        id: idOrBuilderFn,
        type: 'loop',
        data: compactGraphData({
          condition: loopIfOrMaxIterations as AgentGraphCondition<TC, TM>,
          maxIterations: maybeOptions?.maxIterations,
        }),
        children: builtAgent.graphNodes,
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error(
        'Graph Agent.loop requires loop(id, builder, condition).',
      );
    }
    const builderFn = idOrBuilderFn;
    const loopIf = builderOrLoopIf as
      | boolean
      | ((s: Session<TC, TM>) => boolean);
    const maxIterations = loopIfOrMaxIterations as number | undefined;
    const innerAgent = Agent.quick<TC, TM>();
    const builtAgent = builderFn(innerAgent);
    const bodyTemplate = builtAgent.build();

    const loopCondition = typeof loopIf === 'boolean' ? () => loopIf : loopIf;

    this.root.add(
      new Loop({ bodyTemplate, loopIf: loopCondition, maxIterations }),
    );
    return this;
  }

  loopForever(builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>) {
    return this.loop(builderFn, true);
  }

  conditional(
    id: string,
    condition: AgentGraphCondition<TC, TM>,
    thenBuilderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    elseBuilderFn?: (agent: Agent<TC, TM>) => Agent<TC, TM>,
  ): this;
  conditional(
    condition: (s: Session<TC, TM>) => boolean,
    thenBuilderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    elseBuilderFn?: (agent: Agent<TC, TM>) => Agent<TC, TM>,
  ): this;
  conditional(
    idOrCondition:
      | string
      | ((s: Session<TC, TM>) => boolean)
      | AgentGraphCondition<TC, TM>,
    conditionOrThenBuilder:
      | AgentGraphCondition<TC, TM>
      | ((agent: Agent<TC, TM>) => Agent<TC, TM>),
    thenOrElseBuilder?: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    maybeElseBuilder?: (agent: Agent<TC, TM>) => Agent<TC, TM>,
  ): this {
    if (typeof idOrCondition === 'string') {
      const thenAgent = Agent.create<TC, TM>('then');
      const thenBuilderFn = thenOrElseBuilder;
      if (!thenBuilderFn) {
        throw new Error(
          'Graph Agent.conditional requires conditional(id, condition, thenBuilder).',
        );
      }
      const thenChildren = thenBuilderFn(thenAgent).graphNodes;
      const elseChildren = maybeElseBuilder
        ? maybeElseBuilder(Agent.create<TC, TM>('else')).graphNodes
        : undefined;
      this.graphNodes.push({
        id: idOrCondition,
        type: 'conditional',
        data: compactGraphData({
          condition: conditionOrThenBuilder,
          branches: compactGraphData({
            then: thenChildren.map((child) => child.id),
            else: elseChildren?.map((child) => child.id),
          }),
        }),
        children: compactGraphChildren([
          ...thenChildren,
          ...(elseChildren ?? []),
        ]),
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error(
        'Graph Agent.conditional requires conditional(id, condition, thenBuilder).',
      );
    }
    const condition = idOrCondition as (s: Session<TC, TM>) => boolean;
    const thenBuilderFn = conditionOrThenBuilder as (
      agent: Agent<TC, TM>,
    ) => Agent<TC, TM>;
    const elseBuilderFn = thenOrElseBuilder;
    const thenAgent = Agent.quick<TC, TM>();
    const thenTemplate = thenBuilderFn(thenAgent).build();

    let elseTemplate: Template<TM, TC> | undefined;
    if (elseBuilderFn) {
      const elseAgent = Agent.quick<TC, TM>();
      elseTemplate = elseBuilderFn(elseAgent).build();
    }

    this.root.add(
      new Conditional({
        condition: condition,
        thenTemplate: thenTemplate,
        elseTemplate: elseTemplate,
      }),
    );
    return this;
  }

  subroutine(
    builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    opts?: ISubroutineTemplateOptions<TM, TC>,
  ): this;
  subroutine(
    id: string,
    builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    opts?: ISubroutineTemplateOptions<TM, TC>,
  ): this;
  subroutine(
    idOrBuilderFn: string | ((agent: Agent<TC, TM>) => Agent<TC, TM>),
    builderOrOptions?:
      | ((agent: Agent<TC, TM>) => Agent<TC, TM>)
      | ISubroutineTemplateOptions<TM, TC>,
    maybeOptions?: ISubroutineTemplateOptions<TM, TC>,
  ): this {
    if (typeof idOrBuilderFn === 'string') {
      const builderFn = builderOrOptions as (
        agent: Agent<TC, TM>,
      ) => Agent<TC, TM>;
      const innerAgent = Agent.create<TC, TM>(idOrBuilderFn);
      const builtAgent = builderFn(innerAgent);
      this.graphNodes.push({
        id: idOrBuilderFn,
        type: 'subroutine',
        data: maybeOptions,
        children: builtAgent.graphNodes,
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error(
        'Graph Agent.subroutine requires subroutine(id, builder).',
      );
    }
    const builderFn = idOrBuilderFn;
    const opts = builderOrOptions as
      | ISubroutineTemplateOptions<TM, TC>
      | undefined;
    const innerAgent = Agent.quick<TC, TM>();
    const builtAgent = builderFn(innerAgent);
    const subroutineTemplate = builtAgent.build();

    this.root.add(new Subroutine(subroutineTemplate, opts));
    return this;
  }

  sequence(
    id: string,
    builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
  ): this;
  sequence(builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>): this;
  sequence(
    idOrBuilderFn: string | ((agent: Agent<TC, TM>) => Agent<TC, TM>),
    maybeBuilderFn?: (agent: Agent<TC, TM>) => Agent<TC, TM>,
  ): this {
    if (typeof idOrBuilderFn === 'string') {
      if (!maybeBuilderFn) {
        throw new Error('Graph Agent.sequence requires sequence(id, builder).');
      }
      const innerAgent = Agent.create<TC, TM>(idOrBuilderFn);
      const builtAgent = maybeBuilderFn(innerAgent);
      this.graphNodes.push(...builtAgent.graphNodes);
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      throw new Error('Graph Agent.sequence requires sequence(id, builder).');
    }
    const builderFn = idOrBuilderFn;
    const innerAgent = Agent.quick<TC, TM>();
    const builtAgent = builderFn(innerAgent);
    const sequenceTemplate = builtAgent.build();

    this.root.add(sequenceTemplate);
    return this;
  }

  /** -------------------------------------------------- */

  build(): Template<TM, TC> {
    return this.hasInterceptors() ? this.asTemplate() : this.root;
  }

  async execute(
    options?: AgentExecuteOptions<TC, TM>,
  ): Promise<Session<TC, TM>>;
  async execute(
    options?: AgentExecuteOptions<TC, TM> | Session<TC, TM>,
    runtime?: ExecutionRuntimeState<TC, TM>,
  ): Promise<Session<TC, TM>> {
    if (options instanceof Session && arguments.length === 1) {
      throw new Error(
        'Agent.execute takes a single options object. Use execute({ session, ...options }) instead of positional arguments.',
      );
    }
    if (
      arguments.length > 1 &&
      runtime !== undefined &&
      !isExecutionRuntimeState(runtime)
    ) {
      throw new Error(
        'Agent.execute takes a single options object. Use execute({ session, ...options }) instead of positional arguments.',
      );
    }
    return this.executeInternal(options, runtime);
  }

  private asTemplate(): Template<TM, TC> {
    return {
      execute: (session, runtime) => this.executeTemplate(session, runtime),
    };
  }

  private executeTemplate(
    session?: Session<TC, TM>,
    runtime?: ExecutionRuntimeState<TC, TM>,
  ): Promise<Session<TC, TM>> {
    return this.executeInternal(session, runtime);
  }

  private async executeInternal(
    sessionOrOptions?:
      | Session<TC, TM>
      | AgentExecuteOptions<TC, TM>
      | undefined,
    runtimeOrOptions?:
      | ExecutionRuntimeState<TC, TM>
      | AgentExecutionOptions
      | AgentExecutionInternalOptions,
  ): Promise<Session<TC, TM>> {
    if (this.graphNodes.length > 0) {
      const rawOptions =
        sessionOrOptions instanceof Session
          ? { session: sessionOrOptions }
          : (sessionOrOptions as AgentExecuteOptions<TC, TM> | undefined);
      const options = rawOptions;
      assertNoTopLevelStoreOption(options);
      this.assertGraphExecutionSupported(options);
      const durableOptions = this.resolveDirectDurableOptions(options);
      if (durableOptions) {
        return this.executeGraphDirectDurable(options, durableOptions);
      }
      return executeAgentGraph(this.toGraph(options?.version), options);
    }
    const optionsObject =
      runtimeOrOptions === undefined && !(sessionOrOptions instanceof Session)
        ? (sessionOrOptions as AgentExecuteOptions<TC, TM> | undefined)
        : undefined;
    const session = addDirectExecuteInput(
      optionsObject?.session ??
        (sessionOrOptions instanceof Session ? sessionOrOptions : undefined),
      optionsObject?.input,
    );
    assertNoTopLevelStoreOption(optionsObject);
    const parentRuntime = optionsObject
      ? undefined
      : isExecutionRuntimeState<TC, TM>(runtimeOrOptions)
        ? runtimeOrOptions
        : undefined;
    const executionOptions = optionsObject
      ? optionsObject
      : parentRuntime
        ? undefined
        : (runtimeOrOptions as AgentExecutionInternalOptions | undefined);
    if (!parentRuntime) {
      const durableOptions = this.resolveDirectDurableOptions(executionOptions);
      if (durableOptions) {
        return this.executeDirectDurable(
          session,
          executionOptions,
          durableOptions,
        );
      }
      return executeAgentGraph(this.toLegacyExecutionGraph(), {
        session,
        context: executionOptions?.context,
        signal: executionOptions?.signal,
        observers: executionOptions?.observers,
        observerDeliveryBindings: executionOptions?.observerDeliveryBindings,
        strictObservers: executionOptions?.strictObservers,
        eventScopeId:
          (executionOptions as AgentExecutionInternalOptions | undefined)
            ?.eventScopeId ?? createDirectAgentEventScopeId(),
        runEventSource: 'agent',
        unsupportedCommandLabel: 'Agent.execute',
      });
    }
    const eventScopeId =
      parentRuntime?.eventScopeId ??
      (executionOptions as AgentExecutionInternalOptions | undefined)
        ?.eventScopeId ??
      createDirectAgentEventScopeId();
    const executionObservers = [
      ...this.observers,
      ...(executionOptions?.observers ?? []),
    ];
    if (
      this.middleware.length === 0 &&
      this.hooks.length === 0 &&
      executionObservers.length === 0
    ) {
      const runtime =
        parentRuntime ??
        (executionOptions
          ? createExecutionRuntimeState<TC, TM>({
              context: executionOptions.context,
              eventScopeId,
              signal: executionOptions.signal,
            })
          : undefined);
      return session
        ? this.root.execute(session, runtime)
        : this.root.execute(undefined, runtime);
    }

    return executeAgentGraph(this.toLegacyExecutionGraph(), {
      session,
      runtime: parentRuntime,
      context: executionOptions?.context,
      signal: executionOptions?.signal,
      observers: executionOptions?.observers,
      observerDeliveryBindings: executionOptions?.observerDeliveryBindings,
      strictObservers: executionOptions?.strictObservers,
      eventScopeId,
      runEventSource: 'agent',
      unsupportedCommandLabel: 'Agent.execute',
    });
  }

  private resolveDirectDurableOptions(
    executionOptions:
      | AgentExecutionOptions
      | AgentExecutionInternalOptions
      | undefined,
  ): ResolvedAgentDirectDurableOptions | undefined {
    const authored =
      executionOptions?.checkpoint !== undefined
        ? executionOptions.checkpoint
        : this.directCheckpointOptions;
    if (this.quickMode && authored !== undefined && authored !== false) {
      throw new Error('Agent.quick() does not support checkpoint execution.');
    }
    if (authored === undefined || authored === false) {
      return undefined;
    }
    const store = checkpointOptionStore(authored) ?? this.directDurableStore;
    if (!store) {
      throw new Error(
        'Agent.execute({ checkpoint: true }) requires checkpoint: store. Pass execute({ checkpoint: store }) or agent.checkpoint({ store }).',
      );
    }
    const runId = executionOptions?.runId ?? this.ensureDirectDurableRunId();
    return { runId, store };
  }

  private toLegacyExecutionGraph(): AgentGraph {
    return {
      name: 'direct-agent',
      version: 'legacy-template',
      nodes: compileLegacyRootTemplate(this.root as Composite<TM, TC>),
      edges: [],
      tools: this.graphTools,
      middleware: this.middleware,
      hooks: this.hooks,
      observers: this.observers,
    };
  }

  private ensureDirectDurableRunId(): string {
    return (this.directDurableRunId ??= createDirectDurableRunId());
  }

  private async executeDirectDurable(
    session: Session<TC, TM> | undefined,
    executionOptions:
      | AgentExecutionOptions
      | AgentExecutionInternalOptions
      | undefined,
    durableOptions: ResolvedAgentDirectDurableOptions,
  ): Promise<Session<TC, TM>> {
    return this.executeGraphDirectDurable(
      {
        ...executionOptions,
        session,
      } as AgentExecuteOptions<TC, TM>,
      durableOptions,
    );
  }

  private async executeGraphDirectDurable(
    executionOptions: AgentExecuteOptions<TC, TM> | undefined,
    durableOptions: ResolvedAgentDirectDurableOptions,
  ): Promise<Session<TC, TM>> {
    const runtime = createDurableApp({
      store: durableOptions.store,
      defaults: {
        checkpoint: true,
      },
      observers: executionOptions?.observers,
      strictObservers: executionOptions?.strictObservers,
      observerDeliveryBindings: executionOptions?.observerDeliveryBindings,
    });
    const input = executionOptions?.input;
    const result = await runtime.executeCheckpointRun<TC, TM>({
      agent: this,
      runId: durableOptions.runId,
      session: executionOptions?.session,
      input: input === undefined ? undefined : graphInputForDurableSend(input),
      context: executionOptions?.context,
    });
    return result.session;
  }

  private legacySystem(content: string): this {
    this.root.add(new System(content));
    return this;
  }

  private legacyUser(contentOrSource?: string | Source<string>): this {
    this.root.add(new User(contentOrSource));
    return this;
  }

  private legacyAssistant(
    contentOrSource?: string | Source<ModelOutput> | Source<string>,
    validatorOrOptions?: IValidator | ValidationOptions,
  ): this {
    this.root.add(new Assistant(contentOrSource, validatorOrOptions));
    return this;
  }
}

export interface AgentExecutionOptions {
  runId?: string;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  checkpoint?: AgentCheckpointOption;
  observers?: readonly ObserverLike[];
  observerDeliveryBindings?: ObserverDeliveryBindingOptions;
  strictObservers?: boolean;
}

interface AgentExecutionInternalOptions
  extends Omit<AgentExecutionOptions, 'checkpoint'> {
  eventScopeId?: string;
  checkpoint?: AgentCheckpointOption | false;
}

export type AgentCheckpointOption = true | RunStore | { store?: RunStore };

export type AgentCheckpointOptions = AgentCheckpointOption;

interface ResolvedAgentDirectDurableOptions {
  runId: string;
  store: DurableRunStore;
}

function checkpointOptionStore(
  option: AgentCheckpointOption,
): RunStore | undefined {
  if (option === true) {
    return undefined;
  }
  if (isRunStore(option)) {
    return option;
  }
  return option.store;
}

function isRunStore(value: unknown): value is RunStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    'get' in value &&
    'has' in value &&
    'create' in value &&
    'patch' in value &&
    'appendInbox' in value &&
    'appendSessionDelta' in value &&
    'recordOnce' in value &&
    'upsertOutbox' in value &&
    'delete' in value &&
    'entries' in value
  );
}

function assertNoTopLevelStoreOption(options: unknown): void {
  if (typeof options === 'object' && options !== null && 'store' in options) {
    throw new Error(
      'Agent.execute option store has been removed. Use checkpoint: store instead.',
    );
  }
}

interface LegacyTemplateCompilerState {
  nextIds: Map<string, number>;
}

function compileLegacyRootTemplate<TM extends Attrs, TC extends Vars>(
  root: Composite<TM, TC>,
): AgentGraphNode[] {
  return compileLegacyCompositeChildren(root, {
    nextIds: new Map<string, number>(),
  });
}

function compileLegacyCompositeChildren<TM extends Attrs, TC extends Vars>(
  composite: Composite<TM, TC>,
  state: LegacyTemplateCompilerState,
): AgentGraphNode[] {
  return composite.getTemplates().flatMap((template, index) => {
    const prepared = composite.ensureTemplateHasContentSource(template);
    return compileLegacyTemplateDirect(prepared, state).map((node) =>
      withLegacyTemplateLifecycle(node, prepared, index),
    );
  });
}

function compileLegacyTemplateDirect<TM extends Attrs, TC extends Vars>(
  template: Template<TM, TC>,
  state: LegacyTemplateCompilerState,
): AgentGraphNode[] {
  return [compileLegacyTemplate(template, state)];
}

function compileLegacyTemplate<TM extends Attrs, TC extends Vars>(
  template: Template<TM, TC>,
  state: LegacyTemplateCompilerState,
): AgentGraphNode {
  if (template instanceof Sequence) {
    return {
      id: nextLegacyNodeId(state, 'sequence'),
      type: 'transform',
      data: { kind: 'legacySequence' },
      children: compileLegacyCompositeChildren(template, state),
    };
  }
  if (template instanceof Loop) {
    return {
      id: nextLegacyNodeId(state, 'loop'),
      type: 'loop',
      data: compactGraphData({
        condition: wrapLegacyCondition(template.getLoopCondition()),
        maxIterations: template.getMaxIterations(),
        legacyNoCondition: template.getLoopCondition() === undefined,
        legacyWarnOnMaxIterations: true,
      }),
      children: compileLegacyCompositeChildren(template, state),
    };
  }
  if (template instanceof Conditional) {
    const thenChildren = compileLegacyTemplateDirect(
      template.getThenTemplate(),
      state,
    );
    const elseChildren = template.getElseTemplate()
      ? compileLegacyTemplateDirect(template.getElseTemplate()!, state)
      : undefined;
    return {
      id: nextLegacyNodeId(state, 'conditional'),
      type: 'conditional',
      data: compactGraphData({
        condition: wrapLegacyCondition(template.getCondition()),
        branches: compactGraphData({
          then: thenChildren.map((child) => child.id),
          else: elseChildren?.map((child) => child.id),
        }),
      }),
      children: compactGraphChildren([
        ...thenChildren,
        ...(elseChildren ?? []),
      ]),
    };
  }
  if (template instanceof Subroutine) {
    return {
      id: isStableLegacyNodeId(template.id)
        ? template.id
        : nextLegacyNodeId(state, 'subroutine'),
      type: 'subroutine',
      data: compactGraphData({
        initWith: template.getInitFunction(),
        squashWith: template.getSquashFunction(),
        retainMessages: template.getRetainMessages(),
        isolatedContext: template.getIsolatedContext(),
      }),
      children: compileLegacyCompositeChildren(template, state),
    };
  }
  if (template instanceof System) {
    // Route through transform → executeTemplateNode so the runtime Source is
    // resolved and the system message is added exactly as the legacy path did.
    return {
      id: nextLegacyNodeId(state, 'system'),
      type: 'transform',
      data: { template },
    };
  }
  if (template instanceof User) {
    return {
      id: nextLegacyNodeId(state, 'user'),
      type: 'user',
      data: compactGraphData({
        input: template.getContentSource(),
        legacyRequireContent: true,
      }),
    };
  }
  if (template instanceof Assistant) {
    // Route through transform → executeTemplateNode so validator / retry
    // semantics and the full runtime are preserved.
    return {
      id: nextLegacyNodeId(state, 'assistant'),
      type: 'transform',
      data: { template },
    };
  }
  if (template instanceof GenerateMessages) {
    return {
      id: nextLegacyNodeId(state, 'messages'),
      type: 'messages',
      data: { handler: template.getGenerateMessages() },
    };
  }
  if (template instanceof Transform) {
    return {
      id: nextLegacyNodeId(state, 'transform'),
      type: 'transform',
      data: { handler: template.getTransformFn() },
    };
  }
  if (template instanceof Structured) {
    return {
      id: nextLegacyNodeId(state, 'structured'),
      type: 'structured',
      data: { template },
    };
  }
  if (template instanceof Parallel) {
    return {
      id: nextLegacyNodeId(state, 'parallel'),
      type: 'parallel',
      data: { template },
    };
  }
  if (template instanceof CodexTurn) {
    return {
      id: nextLegacyNodeId(state, 'codexTurn'),
      type: 'codexTurn',
      data: { template },
    };
  }
  if (template instanceof ClaudeTurn) {
    return {
      id: nextLegacyNodeId(state, 'claudeTurn'),
      type: 'claudeTurn',
      data: { template },
    };
  }
  // Catch-all: unknown template type. Store as template so executeTemplateNode
  // calls template.execute(session, runtime) with the full runtime context.
  return {
    id: nextLegacyNodeId(state, 'transform'),
    type: 'transform',
    data: { template },
  };
}

function withLegacyTemplateLifecycle<TM extends Attrs, TC extends Vars>(
  node: AgentGraphNode,
  template: Template<TM, TC>,
  templateIndex: number,
): AgentGraphNode {
  return {
    ...node,
    data: {
      ...((node.data as Record<string, unknown> | undefined) ?? {}),
      legacyTemplateLifecycle: {
        templateIndex,
        templateName: template.constructor.name,
      },
    },
  };
}

function wrapLegacyCondition<TC extends Vars, TM extends Attrs>(
  condition: ((session: Session<TC, TM>) => boolean) | undefined,
):
  | ((context: {
      session: Session<TC, TM>;
      context?: Record<string, unknown>;
      signal?: AbortSignal;
    }) => boolean)
  | undefined {
  if (!condition) {
    return undefined;
  }
  return ({ session }) => condition(session);
}

function nextLegacyNodeId(
  state: LegacyTemplateCompilerState,
  kind: string,
): string {
  const next = state.nextIds.get(kind) ?? 0;
  state.nextIds.set(kind, next + 1);
  return `${kind}${next}`;
}

function isStableLegacyNodeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    /^[A-Za-z][A-Za-z0-9_-]*$/.test(value)
  );
}

function createDirectDurableRunId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `direct-agent:${random}`;
}

function createDirectAgentEventScopeId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `direct-agent:${random}`;
}

function addDirectExecuteInput<TC extends Vars, TM extends Attrs>(
  session: Session<TC, TM> | undefined,
  input: AgentExecuteOptions<TC, TM>['input'] | undefined,
): Session<TC, TM> | undefined {
  if (input === undefined) {
    return session;
  }
  let current = session ?? Session.create<TC, TM>();
  const inputs = normalizeDirectExecuteInput(input);
  for (const inbound of inputs) {
    if (inbound.kind === 'control') {
      continue;
    }
    current = current.addMessage(
      inbound.kind === 'system'
        ? Message.system(inbound.content, inbound.attrs)
        : Message.user(inbound.content, inbound.attrs),
    );
  }
  return current;
}

function normalizeDirectExecuteInput<TAttrs extends Attrs>(
  input:
    | string
    | GraphInboundInput<TAttrs>
    | readonly GraphInboundInput<TAttrs>[],
): GraphInboundInput<TAttrs>[] {
  if (typeof input === 'string') {
    return [{ kind: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return [...(input as readonly GraphInboundInput<TAttrs>[])];
  }
  return [input as GraphInboundInput<TAttrs>];
}

function graphInputForDurableSend<TAttrs extends Attrs>(
  input:
    | string
    | GraphInboundInput<TAttrs>
    | readonly GraphInboundInput<TAttrs>[],
):
  | string
  | { kind: 'user' | 'system' | 'control'; content: string; attrs?: TAttrs } {
  if (typeof input === 'string') {
    return input;
  }
  if (Array.isArray(input)) {
    if (input.length !== 1) {
      throw new Error(
        'Durable Agent.execute accepts a single input per call. Use resume/send for additional inputs.',
      );
    }
    return graphInputForDurableSend(input[0]);
  }
  const inbound = input as GraphInboundInput<TAttrs>;
  return {
    kind: inbound.kind ?? 'user',
    content: inbound.content,
    attrs: inbound.attrs,
  };
}

function isExecutionRuntimeState<TC extends Vars, TM extends Attrs>(
  value: unknown,
): value is ExecutionRuntimeState<TC, TM> {
  return (
    !!value &&
    typeof value === 'object' &&
    'middlewareState' in value &&
    'version' in value
  );
}

function compactGraphData(
  data: Record<string, unknown | undefined>,
): Record<string, unknown> | undefined {
  const compact = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function compactGraphChildren(
  children: Array<AgentGraphNode | undefined>,
): AgentGraphNode[] {
  return children.filter(
    (child): child is AgentGraphNode => child !== undefined,
  );
}

function isGraphAssistantInput<TC extends Vars, TM extends Attrs>(
  value: unknown,
): value is AgentGraphAssistantInput<TC, TM> {
  return (
    typeof value === 'string' ||
    typeof value === 'function' ||
    value instanceof Source
  );
}

function createGoalGraphNode<TC extends Vars, TM extends Attrs>(
  id: string,
  goal: string,
  options: AgentGoalOptions<TC, TM>,
): AgentGraphNode {
  const interaction = options.interaction ?? 'none';
  const attemptChildren: AgentGraphNode[] = [
    {
      id: 'model',
      type: 'assistant',
      data: compactGraphData({ input: options.model ?? Source.llm() }),
    },
    {
      id: 'tools',
      type: 'tools',
      data: compactGraphData({ tools: options.tools }),
    },
    {
      id: 'check',
      type: 'patch',
      data: compactGraphData({
        kind: 'goalSatisfaction',
        isSatisfied: options.isSatisfied,
      }),
    },
  ];

  if (interaction !== 'none') {
    attemptChildren.push({
      id: 'interaction',
      type: 'awaitInput',
      data: { required: interaction === 'required' },
    });
  }

  return {
    id,
    type: 'goal',
    data: compactGraphData({
      goal,
      interaction,
      maxAttempts: options.maxAttempts,
      onUnsatisfied: options.onUnsatisfied ?? 'retry',
    }),
    children: [
      {
        id: 'prompt',
        type: 'user',
        data: { content: goal },
      },
      {
        id: 'attempts',
        type: 'loop',
        data: compactGraphData({
          kind: 'goalAttempts',
          maxAttempts: options.maxAttempts,
          onUnsatisfied: options.onUnsatisfied ?? 'retry',
        }),
        children: attemptChildren,
      },
    ],
  };
}
