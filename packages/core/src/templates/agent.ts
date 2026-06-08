import { Session, type Attrs, type Vars } from '../session';
import type { CodexTurnOptions } from '../codex_app_server';
import type { ClaudeTurnOptions } from '../claude_agent';
import {
  agent as createDurableAgent,
  app as createDurableApp,
  memoryStore,
  type DurableRunStore,
} from '../durable';
import {
  ObserverBus,
  type ExecutionEvent,
  type ObserverDeliveryBindingOptions,
  type ObserverLike,
  type ResolvedExecutionCommand,
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
  extendExecutionRuntimeState,
  type ExecutionRuntimeState,
  type ExecutionDurableBoundary,
  type HookDefinition,
  type MiddlewareDefinition,
  runRuntimeExecutionPhase,
} from '../interceptors';
import { ModelOutput, Source, ValidationOptions } from '../source';
import type { PromptTrailTool } from '../tool';
import { IValidator } from '../validators';
import type { Template } from './base';
import { Fluent } from './composite/chainable';
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

export interface AgentGoalSatisfactionContext<
  TC extends Vars = Vars,
  TM extends Attrs = Attrs,
> {
  session: Session<TC, TM>;
  goal: string;
  attempt: number;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  durable?: ExecutionDurableBoundary;
}

export interface AgentGoalOptions<TC extends Vars = Vars, TM extends Attrs = Attrs> {
  interaction?: 'none' | 'optional' | 'required';
  maxAttempts?: number;
  tools?: readonly string[] | Record<string, PromptTrailTool<any, any>>;
  model?: Source<ModelOutput> | AgentGraphAssistantHandler<TC, TM>;
  durability?: 'materialized' | 'replayable';
  isSatisfied?: (
    context: AgentGoalSatisfactionContext<TC, TM>,
  ) => boolean | Promise<boolean>;
  onUnsatisfied?: 'retry' | 'continue' | 'halt';
}

export interface AgentGraphExecutionOptions<
  TC extends Vars = Vars,
  TM extends Attrs = Attrs,
> extends GraphExecutionOptions<TC, TM>, AgentExecutionOptions {
  version?: string;
}

export interface AgentExecuteOptions<
  TC extends Vars = Vars,
  TM extends Attrs = Attrs,
> extends AgentGraphExecutionOptions<TC, TM> {}

export class AgentTurnGraphBuilder<
  TC extends Vars = Vars,
  TM extends Attrs = Attrs,
> {
  private readonly nodes: AgentGraphNode[] = [];

  inbox(id: string, options?: Record<string, unknown>): this {
    this.nodes.push({ id, type: 'inbox', data: options });
    return this;
  }

  assistant(
    id: string,
    sourceOrHandler?: AgentGraphAssistantInput<TC, TM>,
    options?: Record<string, unknown>,
  ): this {
    this.nodes.push({
      id,
      type: 'assistant',
      data: compactGraphData({
        input: sourceOrHandler,
        options,
      }),
    });
    return this;
  }

  tools(id: string, options?: Record<string, unknown>): this {
    this.nodes.push({ id, type: 'tools', data: options });
    return this;
  }

  repeat(
    id: string,
    condition: (context: { session: Session<TC, TM> }) => boolean,
    builder: (
      loop: AgentTurnGraphBuilder<TC, TM>,
    ) => AgentTurnGraphBuilder<TC, TM>,
    options?: Record<string, unknown>,
  ): this {
    const loop = builder(new AgentTurnGraphBuilder<TC, TM>());
    this.nodes.push({
      id,
      type: 'loop',
      data: compactGraphData({ condition, options }),
      children: loop.build(),
    });
    return this;
  }

  awaitInput(id: string, options?: Record<string, unknown>): this {
    this.nodes.push({ id, type: 'awaitInput', data: options });
    return this;
  }

  patch(
    id: string,
    handler: (session: Session<TC, TM>) => unknown | Promise<unknown>,
  ): this {
    this.nodes.push({ id, type: 'patch', data: { handler } });
    return this;
  }

  build(): AgentGraphNode[] {
    return [...this.nodes];
  }
}

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
 * const agent = Agent.create()
 *   .system('System message')
 *   .user('User message')
 *   .assistant('Assistant message')
 *   .loop(agent => agent.user('Input'), condition)
 *   .subroutine(agent => agent.user('Sub'));
 */
export class Agent<TC extends Vars = Vars, TM extends Attrs = Attrs>
  implements Template<TM, TC>, Fluent<TM, TC>
{
  private constructor(
    private readonly root: Fluent<TM, TC> = new Sequence<TM, TC>(),
    private readonly graphName?: string,
  ) {}

  private readonly graphNodes: AgentGraphNode[] = [];
  private readonly graphTools: Record<string, PromptTrailTool<any, any>> = {};
  private readonly middleware: MiddlewareDefinition<TC, TM>[] = [];
  private readonly hooks: HookDefinition<TC, TM>[] = [];
  private readonly observers: ObserverLike[] = [];
  private directDurableOptions?: AgentDirectDurableOptions | false;
  private directDurableStore?: DurableRunStore;
  private directDurableRunId?: string;

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
    if (this.directDurableOptions) {
      throw new Error(
        'Graph Agent.execute does not support durable execution yet.',
      );
    }
    if (this.hasInterceptors()) {
      throw new Error(
        'Graph Agent.execute does not support middleware, hooks, or observers yet.',
      );
    }

    const rawOptions = options as Record<string, unknown> | undefined;
    const unsupportedOption = [
      'durable',
      'store',
      'observers',
    ].find((key) => rawOptions && key in rawOptions);
    if (unsupportedOption) {
      throw new Error(
        `Graph Agent.execute does not support option ${unsupportedOption} yet.`,
      );
    }
  }

  /** Static factory methods -------------------------------------------------- */

  static create<TC extends Vars = Vars, TM extends Attrs = Attrs>(): Agent<
    TC,
    TM
  >;
  static create<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    name: string,
  ): Agent<TC, TM>;
  static create<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    name?: string,
  ) {
    return new Agent<TC, TM>(new Sequence<TM, TC>(), name);
  }

  static system<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    content: string,
  ) {
    return new Agent<TC, TM>().legacySystem(content);
  }

  static user<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    contentOrSource?: string | Source<string>,
  ) {
    return new Agent<TC, TM>().legacyUser(contentOrSource);
  }

  static assistant<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    contentOrSource?: string | Source<ModelOutput> | Source<string>,
    validatorOrOptions?: IValidator | ValidationOptions,
  ) {
    return new Agent<TC, TM>().legacyAssistant(
      contentOrSource,
      validatorOrOptions,
    );
  }

  /** fluent helpers -------------------------------------------------- */

  add(t: Template<TM, TC>) {
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
      nodes: this.graphNodes,
      tools: this.graphTools,
      middleware: this.middleware,
      hooks: this.hooks,
      observers: this.observers,
    });
  }

  durable(options: AgentDirectDurableOptions | boolean = true) {
    this.directDurableOptions =
      typeof options === 'boolean'
        ? options
          ? { runId: this.ensureDirectDurableRunId() }
          : false
        : {
            ...options,
            runId: options.runId ?? this.ensureDirectDurableRunId(),
          };
    if (typeof options === 'object' && options.store) {
      this.directDurableStore = options.store;
    }
    return this;
  }

  system(content: string): this;
  system(id: string, content: string): this;
  system(idOrContent: string, content?: string) {
    if (this.graphName) {
      this.graphNodes.push({
        id: idOrContent,
        type: 'system',
        data: content === undefined ? undefined : { content },
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
      this.root.add(new User(contentOrSource));
      return this;
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

  transform(transform: (s: Session<TC, TM>) => Session<TC, TM>) {
    this.root.add(new Transform(transform));
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
    this.root.add(
      new GenerateMessages(idOrGenerateMessages as GenerateMessagesFn<TM, TC>),
    );
    return this;
  }

  turn(
    id: string,
    builder: (
      turn: AgentTurnGraphBuilder<TC, TM>,
    ) => AgentTurnGraphBuilder<TC, TM>,
  ): this {
    const turn = builder(new AgentTurnGraphBuilder<TC, TM>());
    this.graphNodes.push({
      id,
      type: 'turn',
      children: turn.build(),
    });
    return this;
  }

  codexTurn(options: CodexTurnOptions<TM, TC>) {
    this.root.add(new CodexTurn(options));
    return this;
  }

  claudeTurn(options: ClaudeTurnOptions<TM, TC>) {
    this.root.add(new ClaudeTurn(options));
    return this;
  }

  parallel(template: Parallel<TM, TC>) {
    this.root.add(template);
    return this;
  }

  structured(template: Structured<TM, TC>) {
    this.root.add(template);
    return this;
  }

  /** Function-based template builders -------------------------------------------------- */

  loop(
    builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    loopIf: boolean | ((s: Session<TC, TM>) => boolean),
    maxIterations?: number,
  ) {
    const innerAgent = Agent.create<TC, TM>();
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
    condition: (s: Session<TC, TM>) => boolean,
    thenBuilderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    elseBuilderFn?: (agent: Agent<TC, TM>) => Agent<TC, TM>,
  ) {
    const thenAgent = Agent.create<TC, TM>();
    const thenTemplate = thenBuilderFn(thenAgent).build();

    let elseTemplate: Template<TM, TC> | undefined;
    if (elseBuilderFn) {
      const elseAgent = Agent.create<TC, TM>();
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
      const innerAgent = Agent.create<TC, TM>();
      const builtAgent = builderFn(innerAgent);
      this.graphNodes.push({
        id: idOrBuilderFn,
        type: 'subroutine',
        data: maybeOptions,
        children: builtAgent.graphNodes,
      });
      return this;
    }
    const builderFn = idOrBuilderFn;
    const opts = builderOrOptions as
      | ISubroutineTemplateOptions<TM, TC>
      | undefined;
    const innerAgent = Agent.create<TC, TM>();
    const builtAgent = builderFn(innerAgent);
    const subroutineTemplate = builtAgent.build();

    this.root.add(new Subroutine(subroutineTemplate, opts));
    return this;
  }

  sequence(builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>) {
    const innerAgent = Agent.create<TC, TM>();
    const builtAgent = builderFn(innerAgent);
    const sequenceTemplate = builtAgent.build();

    this.root.add(sequenceTemplate);
    return this;
  }

  /** -------------------------------------------------- */

  build() {
    return this.hasInterceptors() ? this : this.root;
  }

  async execute(options?: AgentExecuteOptions<TC, TM>): Promise<Session<TC, TM>>;
  async execute(
    session?: Session<TC, TM> | undefined,
    runtimeOrOptions?: ExecutionRuntimeState<TC, TM> | AgentExecutionOptions,
  ): Promise<Session<TC, TM>>;
  async execute(
    sessionOrOptions?:
      | Session<TC, TM>
      | AgentExecuteOptions<TC, TM>
      | undefined,
    runtimeOrOptions?: ExecutionRuntimeState<TC, TM> | AgentExecutionOptions,
  ): Promise<Session<TC, TM>> {
    if (this.graphNodes.length > 0) {
      const options =
        sessionOrOptions instanceof Session
          ? { session: sessionOrOptions }
          : (sessionOrOptions as AgentExecuteOptions<TC, TM> | undefined);
      this.assertGraphExecutionSupported(options);
      return executeAgentGraph(
        this.toGraph(options?.version),
        options,
      );
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
    }
    const eventScopeId =
      parentRuntime?.eventScopeId ??
      (executionOptions as AgentExecutionInternalOptions | undefined)
        ?.eventScopeId ??
      createDirectAgentEventScopeId();
    if (!this.hasInterceptors()) {
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

    const observerBus = new ObserverBus(this.observers, {
      strictObservers: executionOptions?.strictObservers,
      ...executionOptions?.observerDeliveryBindings,
    });
    let seq = 0;
    let current = session ?? Session.create<TC, TM>();
    const runtime =
      parentRuntime ??
      createExecutionRuntimeState<TC, TM>({
        context: executionOptions?.context,
        emitEvent: (event) => observerBus.emit(event),
        eventScopeId,
        nextEventSeq: () => seq++,
        signal: executionOptions?.signal,
      });
    const previousParentEmitEvent = parentRuntime?.emitEvent;
    // Child agents run sequentially under the current template runtime, so this
    // temporary fan-out keeps nested observers attached to the shared event seq.
    if (parentRuntime && this.observers.length > 0) {
      parentRuntime.emitEvent = async (event) => {
        await previousParentEmitEvent?.(event);
        await observerBus.emit(event);
      };
    }
    const nextSeq = () => runtime.nextEventSeq?.() ?? seq++;
    const emitEvent = (event: ExecutionEvent) =>
      runtime.emitEvent?.(event) ?? observerBus.emit(event);

    let eventSeq = nextSeq();
    await emitEvent({
      id: `agent:${eventSeq}`,
      type: 'run.started',
      at: new Date().toISOString(),
      seq: eventSeq,
      replay: 'live',
      idempotencyKey: directAgentEventIdempotencyKey(
        eventScopeId,
        eventSeq,
        'run.started',
      ),
    });

    try {
      const before = await runRuntimeExecutionPhase(runtime, {
        phase: 'beforeAgent',
        session: current,
        middleware: this.middleware,
        hooks: this.hooks,
      });
      current = before.session;
      if (before.command.type !== 'none') {
        return await handleDirectAgentCommand(before.command, current, {
          emitCompleted: async () => {
            eventSeq = nextSeq();
            await emitEvent({
              id: `agent:${eventSeq}`,
              type: 'run.completed',
              at: new Date().toISOString(),
              seq: eventSeq,
              replay: 'live',
              idempotencyKey: directAgentEventIdempotencyKey(
                eventScopeId,
                eventSeq,
                'run.completed',
              ),
            });
          },
        });
      }

      const childRuntime = extendExecutionRuntimeState(runtime, {
        middleware: this.middleware,
        hooks: this.hooks,
      });
      current = await this.root.execute(current, childRuntime);
      runtime.middlewareState = childRuntime.middlewareState;
      runtime.version = childRuntime.version;

      const after = await runRuntimeExecutionPhase(runtime, {
        phase: 'afterAgent',
        session: current,
        middleware: this.middleware,
        hooks: this.hooks,
      });
      current = after.session;
      if (after.command.type !== 'none') {
        return await handleDirectAgentCommand(after.command, current, {
          emitCompleted: async () => {
            eventSeq = nextSeq();
            await emitEvent({
              id: `agent:${eventSeq}`,
              type: 'run.completed',
              at: new Date().toISOString(),
              seq: eventSeq,
              replay: 'live',
              idempotencyKey: directAgentEventIdempotencyKey(
                eventScopeId,
                eventSeq,
                'run.completed',
              ),
            });
          },
        });
      }

      eventSeq = nextSeq();
      await emitEvent({
        id: `agent:${eventSeq}`,
        type: 'run.completed',
        at: new Date().toISOString(),
        seq: eventSeq,
        replay: 'live',
        idempotencyKey: directAgentEventIdempotencyKey(
          eventScopeId,
          eventSeq,
          'run.completed',
        ),
      });
      return current;
    } catch (error) {
      eventSeq = nextSeq();
      await emitEvent({
        id: `agent:${eventSeq}`,
        type: 'run.failed',
        at: new Date().toISOString(),
        seq: eventSeq,
        replay: 'live',
        idempotencyKey: directAgentEventIdempotencyKey(
          eventScopeId,
          eventSeq,
          'run.failed',
        ),
        error,
      });
      throw error;
    } finally {
      if (parentRuntime && this.observers.length > 0) {
        parentRuntime.emitEvent = previousParentEmitEvent;
      }
    }
  }

  private resolveDirectDurableOptions(
    executionOptions: AgentExecutionOptions | undefined,
  ): ResolvedAgentDirectDurableOptions | undefined {
    const authored =
      executionOptions?.durable !== undefined
        ? executionOptions.durable
        : this.directDurableOptions;
    if (authored === undefined || authored === false) {
      return undefined;
    }
    const options = authored === true ? {} : authored;
    const store =
      options.store ??
      this.directDurableStore ??
      (this.directDurableStore = memoryStore());
    const runId = options.runId ?? this.ensureDirectDurableRunId();
    return { runId, store };
  }

  private ensureDirectDurableRunId(): string {
    return (this.directDurableRunId ??= createDirectDurableRunId());
  }

  private async executeDirectDurable(
    session: Session<TC, TM> | undefined,
    executionOptions: AgentExecutionOptions | undefined,
    durableOptions: ResolvedAgentDirectDurableOptions,
  ): Promise<Session<TC, TM>> {
    const durableAgent = createDurableAgent<TC, TM>('direct-agent').patch(
      'agent',
      async (current) => ({
        session: await this.execute(current, {
          context: executionOptions?.context,
          eventScopeId: durableOptions.runId,
          observerDeliveryBindings: executionOptions?.observerDeliveryBindings,
          strictObservers: executionOptions?.strictObservers,
          signal: executionOptions?.signal,
          durable: false,
        }),
      }),
    );
    const durableRuntime = createDurableApp({
      durable: {
        store: durableOptions.store,
        defaultDurable: true,
      },
    });
    const result = durableOptions.store.has(durableOptions.runId)
      ? await durableRuntime.resume<TC, TM>(durableOptions.runId)
      : await durableRuntime.run<TC, TM>({
          agent: durableAgent,
          runId: durableOptions.runId,
          session,
          durable: true,
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

function directAgentEventIdempotencyKey(
  eventScopeId: string,
  seq: number,
  type: string,
): string {
  return `${eventScopeId}:agent:${seq}:${type}`;
}

export interface AgentExecutionOptions {
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  durable?: boolean | AgentDirectDurableOptions;
  observerDeliveryBindings?: ObserverDeliveryBindingOptions;
  strictObservers?: boolean;
}

interface AgentExecutionInternalOptions extends AgentExecutionOptions {
  eventScopeId?: string;
}

export interface AgentDirectDurableOptions {
  runId?: string;
  store?: DurableRunStore;
}

interface ResolvedAgentDirectDurableOptions {
  runId: string;
  store: DurableRunStore;
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
  input: string | GraphInboundInput<TAttrs> | readonly GraphInboundInput<TAttrs>[],
): GraphInboundInput<TAttrs>[] {
  if (typeof input === 'string') {
    return [{ kind: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return [...(input as readonly GraphInboundInput<TAttrs>[])];
  }
  return [input as GraphInboundInput<TAttrs>];
}

function isExecutionRuntimeState<TC extends Vars, TM extends Attrs>(
  value: ExecutionRuntimeState<TC, TM> | AgentExecutionOptions | undefined,
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
        durability: options.durability ?? 'materialized',
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

async function handleDirectAgentCommand<TC extends Vars, TM extends Attrs>(
  command: ResolvedExecutionCommand,
  session: Session<TC, TM>,
  options: { emitCompleted: () => Promise<void> },
): Promise<Session<TC, TM>> {
  if (command.type === 'none') {
    return session;
  }
  if (command.type === 'halt') {
    await options.emitCompleted();
    return session;
  }
  throw new Error(
    `Agent.execute does not support execution command ${command.type} yet.`,
  );
}
