import type { z } from 'zod';
import { Session, type Vars } from '../session';
import type { CodexTurnOptions } from '../codex_app_server';
import type { ClaudeTurnOptions } from '../claude_agent';
import {
  app as createDurableApp,
  type DurableRunResult,
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
import { Message } from '../message';
import {
  createExecutionRuntimeState,
  type ExecutionDurableBoundary,
  type ExecutionEffectDeclaration,
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
import { GenerateMessages } from './primitives/messages';
import { Structured } from './primitives/structured';
import { System } from './primitives/system';
import { Transform } from './primitives/transform';
import { User } from './primitives/user';
import { ISubroutineTemplateOptions } from './template_types';

type AgentGraphAssistantHandler<TC extends Vars> = (
  session: Session<TC>,
  runtime?: AgentGraphHandlerRuntime,
) => unknown | Promise<unknown>;

type AgentGraphAssistantInput<TC extends Vars> =
  | string
  | Source<ModelOutput>
  | Source<string>
  | AgentGraphAssistantHandler<TC>;

type AgentGraphPureTransformHandler<TC extends Vars> = (
  session: Session<TC>,
) => Session<TC>;

type AgentGraphStructuredFold<
  TSchema extends z.ZodType,
  TC extends Vars = Vars,
> = (obj: z.infer<TSchema>, session: Session<TC>) => Session<any>;

export interface AgentGraphTransformEffectContext {
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  once: ExecutionDurableBoundary['once'];
  idempotencyKey?: string;
}

export interface AgentGraphTransformEffectOptions {
  effect: ExecutionEffectDeclaration;
}

type AgentGraphEffectTransformHandler<TC extends Vars> = (
  session: Session<TC>,
  ctx: AgentGraphTransformEffectContext,
) => Session<TC> | Promise<Session<TC>>;

export interface AgentGraphHandlerRuntime {
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

export type AgentGraphCondition<TC extends Vars = Vars> =
  | boolean
  | ((context: {
      session: Session<TC>;
      context?: Record<string, unknown>;
      signal?: AbortSignal;
    }) => boolean);

export interface AgentGraphLoopOptions {
  maxIterations?: number;
}

export interface AgentGoalSatisfactionContext<TC extends Vars = Vars> {
  session: Session<TC>;
  goal: string;
  attempt: number;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AgentGoalOptions<TC extends Vars = Vars> {
  interaction?: 'none' | 'optional' | 'required';
  maxAttempts?: number;
  tools?: readonly string[] | Record<string, PromptTrailTool<any, any>>;
  model?: Source<ModelOutput> | Source<string> | AgentGraphAssistantHandler<TC>;
  isSatisfied?: (context: AgentGoalSatisfactionContext<TC>) => boolean;
  onUnsatisfied?: 'retry' | 'continue' | 'halt';
}

export interface AgentGraphExecutionOptions<TC extends Vars = Vars>
  extends GraphExecutionOptions<TC>,
    AgentExecutionOptions {
  version?: string;
}

export interface AgentExecuteOptions<TC extends Vars = Vars>
  extends AgentGraphExecutionOptions<TC> {}

export type AgentExecuteOptionsWithCheckpoint<TC extends Vars = Vars> = Omit<
  AgentExecuteOptions<TC>,
  'checkpoint'
> & {
  checkpoint: AgentCheckpointOption;
};

export type AgentExecuteOptionsWithoutCheckpoint<TC extends Vars = Vars> = Omit<
  AgentExecuteOptions<TC>,
  'checkpoint'
> & {
  checkpoint?: undefined;
};

type AgentGraphNodeDraft = Omit<AgentGraphNode, 'id' | 'children'> & {
  id?: string;
  children?: readonly AgentGraphNodeDraft[];
  deriveType?: string;
};

/**
 * Agent class for building and executing templates
 * @template TVars - The context type.
 * @class
 * @public
 * @remarks
 * This class provides a fluent interface for creating and executing templates,
 * allowing for the addition of system, user, and assistant messages,
 * as well as the ability to define loops and subroutines.
 * It serves as a builder for complex template compositions.
 * The templates can be executed in order or as part of a subroutine,
 * enabling flexible and reusable template structures.
 * The class also supports the addition of custom exit conditions for loops
 * and the ability to retain messages or isolate context in subroutines.
 * The Agent class is designed to be extensible and customizable,
 * allowing developers to create sophisticated conversational agents
 * with complex logic and context management.
 * It is a key component of the template system, enabling the creation
 * of dynamic and interactive conversational experiences.
 * @example
 * const agent = Agent.create('assistant')
 *   .system('System message')
 *   .user('User message')
 *   .assistant('Assistant message')
 *   .loop(agent => agent.user('Input'), condition)
 *   .subroutine(agent => agent.user('Sub'));
 */
export class Agent<TC extends Vars = Vars> {
  private constructor(
    private readonly root: Fluent<TC> = new Sequence<TC>(),
    private readonly graphName?: string,
  ) {}

  private readonly graphNodes: AgentGraphNodeDraft[] = [];
  private readonly graphTools: Record<string, PromptTrailTool<any, any>> = {};
  private readonly middleware: MiddlewareDefinition<TC>[] = [];
  private readonly hooks: HookDefinition<TC>[] = [];
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
    options: AgentGraphExecutionOptions<TC> | undefined,
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

  static create<TC extends Vars = Vars>(name: string): Agent<TC>;
  static create<TC extends Vars = Vars>(name?: string) {
    if (!name) {
      throw new Error('Agent.create(name) requires a stable agent name.');
    }
    return new Agent<TC>(new Sequence<TC>(), name);
  }

  /** fluent helpers -------------------------------------------------- */

  add(t: Template<TC>) {
    if (this.isGraphAuthoringMode()) {
      this.graphNodes.push({
        type: 'transform',
        data: { template: t },
      });
      return this;
    }
    this.root.add(t);
    return this;
  }

  use(middleware: MiddlewareDefinition<TC>) {
    this.middleware.push(middleware);
    return this;
  }

  hook(hook: HookDefinition<TC>) {
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
    const rawNodes =
      this.graphNodes.length > 0
        ? finalizeGraphNodeIds(this.graphNodes, {
            legacyLifecycle: this.hasInterceptors(),
          })
        : compileLegacyRootTemplate(this.root as Composite<TC>);
    return createAgentGraph({
      name: this.graphName,
      version,
      nodes: expandIntentToolLoops(
        rawNodes,
        Object.keys(this.graphTools).length > 0,
        true,
      ),
      tools: this.graphTools,
      middleware: this.middleware,
      hooks: this.hooks,
      observers: this.observers,
    });
  }

  checkpoint(options: AgentCheckpointOption = true) {
    this.directCheckpointOptions = options;
    const checkpointStore = checkpointOptionStore(options);
    if (checkpointStore) {
      this.directDurableStore = checkpointStore;
    }
    return this;
  }

  system(contentOrSource: string | Source<string>): this;
  system(id: string, contentOrSource: string | Source<string>): this;
  system(
    idOrContentOrSource: string | Source<string>,
    contentOrSource?: string | Source<string>,
  ) {
    if (this.graphName) {
      this.graphNodes.push({
        id:
          contentOrSource === undefined
            ? undefined
            : (idOrContentOrSource as string),
        type: 'system',
        data: {
          content:
            contentOrSource === undefined
              ? idOrContentOrSource
              : contentOrSource,
        },
      });
      return this;
    }
    const resolvedContent = contentOrSource ?? idOrContentOrSource;
    if (contentOrSource !== undefined) {
      this.graphNodes.push({
        id: idOrContentOrSource as string,
        type: 'system',
        data: { content: contentOrSource },
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
        id:
          contentOrSource === undefined
            ? undefined
            : (idOrContentOrSource as string),
        type: 'user',
        data:
          contentOrSource === undefined
            ? compactGraphData({ input: idOrContentOrSource })
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
  assistant(sourceOrHandler: AgentGraphAssistantInput<TC>): this;
  assistant(
    id: string,
    sourceOrHandler?: AgentGraphAssistantInput<TC>,
    options?: Record<string, unknown>,
  ): this;
  assistant(
    contentOrSource?: AgentGraphAssistantInput<TC>,
    validatorOrOptions?:
      | IValidator
      | ValidationOptions
      | AgentGraphAssistantInput<TC>,
    maybeOptions?: Record<string, unknown>,
  ) {
    if (
      this.graphName ||
      maybeOptions !== undefined ||
      isGraphAssistantInput(validatorOrOptions)
    ) {
      const hasAuthoredId =
        maybeOptions !== undefined ||
        (typeof contentOrSource === 'string' &&
          isGraphAssistantInput(validatorOrOptions));
      const validationOptions = hasAuthoredId
        ? undefined
        : (validatorOrOptions as IValidator | ValidationOptions | undefined);
      this.graphNodes.push({
        id: this.graphName
          ? hasAuthoredId
            ? (contentOrSource as string)
            : undefined
          : (contentOrSource as string),
        type: 'assistant',
        data: compactGraphData({
          input: this.graphName
            ? hasAuthoredId
              ? validatorOrOptions
              : (contentOrSource ?? Source.llm())
            : hasAuthoredId
              ? validatorOrOptions
              : (contentOrSource ?? Source.llm()),
          options: maybeOptions,
          ...graphAssistantValidationData(contentOrSource, validationOptions),
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
        contentOrSource as
          | string
          | Source<ModelOutput>
          | Source<string>
          | undefined,
        validatorOrOptions as IValidator | ValidationOptions | undefined,
      ),
    );
    return this;
  }

  goal(goal: string, options?: AgentGoalOptions<TC>): this;
  goal(id: string, goal: string, options?: AgentGoalOptions<TC>): this;
  goal(
    idOrGoal: string,
    goalOrOptions?: string | AgentGoalOptions<TC>,
    maybeOptions: AgentGoalOptions<TC> = {},
  ): this {
    const hasAuthoredId = typeof goalOrOptions === 'string';
    this.graphNodes.push(
      createGoalGraphNode(
        hasAuthoredId ? idOrGoal : undefined,
        hasAuthoredId ? goalOrOptions : idOrGoal,
        hasAuthoredId
          ? maybeOptions
          : ((goalOrOptions as AgentGoalOptions<TC> | undefined) ?? {}),
      ),
    );
    return this;
  }

  inbox(options?: Record<string, unknown>): this;
  inbox(id: string, options?: Record<string, unknown>): this;
  inbox(
    idOrOptions?: string | Record<string, unknown>,
    maybeOptions?: Record<string, unknown>,
  ): this {
    this.graphNodes.push({
      id: typeof idOrOptions === 'string' ? idOrOptions : undefined,
      type: 'inbox',
      data: typeof idOrOptions === 'string' ? maybeOptions : idOrOptions,
    });
    return this;
  }

  tools(options?: Record<string, unknown>): this;
  tools(id: string, options?: Record<string, unknown>): this;
  tools(
    idOrOptions?: string | Record<string, unknown>,
    maybeOptions?: Record<string, unknown>,
  ): this {
    this.graphNodes.push({
      id: typeof idOrOptions === 'string' ? idOrOptions : undefined,
      type: 'tools',
      data: typeof idOrOptions === 'string' ? maybeOptions : idOrOptions,
    });
    return this;
  }

  awaitInput(options?: Record<string, unknown>): this;
  awaitInput(id: string, options?: Record<string, unknown>): this;
  awaitInput(
    idOrOptions?: string | Record<string, unknown>,
    maybeOptions?: Record<string, unknown>,
  ): this {
    this.graphNodes.push({
      id: typeof idOrOptions === 'string' ? idOrOptions : undefined,
      type: 'awaitInput',
      data: typeof idOrOptions === 'string' ? maybeOptions : idOrOptions,
    });
    return this;
  }

  /**
   * Durable sleep (durability roadmap §3). Suspends the run for `duration` and
   * resumes past the node once the app's timer sweep fires — the wake-at is
   * persisted, so the sleep survives restarts. `duration` is milliseconds or a
   * human string like `'2h'` / `'7d'` / `'1h30m'`. Under ephemeral (non
   * checkpoint) execution it is a real in-process wait.
   */
  sleep(duration: number | string): this;
  sleep(id: string, duration: number | string): this;
  sleep(idOrDuration: string | number, maybeDuration?: number | string): this {
    if (maybeDuration !== undefined) {
      this.graphNodes.push({
        id: idOrDuration as string,
        type: 'sleep',
        data: { duration: maybeDuration },
      });
      return this;
    }
    this.graphNodes.push({
      type: 'sleep',
      data: { duration: idOrDuration },
    });
    return this;
  }

  transform(transform: AgentGraphPureTransformHandler<TC>): this;
  transform(
    options: AgentGraphTransformEffectOptions,
    transform: AgentGraphEffectTransformHandler<TC>,
  ): this;
  transform(id: string, transform: AgentGraphPureTransformHandler<TC>): this;
  transform(
    id: string,
    options: AgentGraphTransformEffectOptions,
    transform: AgentGraphEffectTransformHandler<TC>,
  ): this;
  transform(
    idOrTransform:
      | string
      | AgentGraphPureTransformHandler<TC>
      | AgentGraphTransformEffectOptions,
    optionsOrTransform?:
      | AgentGraphTransformEffectOptions
      | AgentGraphPureTransformHandler<TC>
      | AgentGraphEffectTransformHandler<TC>,
    maybeTransform?: AgentGraphEffectTransformHandler<TC>,
  ) {
    if (typeof idOrTransform === 'string') {
      if (typeof optionsOrTransform === 'function') {
        this.graphNodes.push({
          id: idOrTransform,
          type: 'transform',
          data: { handler: optionsOrTransform },
        });
        return this;
      }
      if (!optionsOrTransform || typeof maybeTransform !== 'function') {
        throw new Error(
          'Graph Agent.transform requires transform(id, handler) or transform(id, { effect }, handler).',
        );
      }
      this.graphNodes.push({
        id: idOrTransform,
        type: 'transform',
        data: { handler: maybeTransform, effect: optionsOrTransform.effect },
      });
      return this;
    }
    if (
      typeof idOrTransform === 'object' &&
      typeof optionsOrTransform === 'function'
    ) {
      this.graphNodes.push({
        type: 'transform',
        data: {
          handler: optionsOrTransform,
          effect: idOrTransform.effect,
        },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      this.graphNodes.push({
        type: 'transform',
        data: { handler: idOrTransform },
      });
      return this;
    }
    this.root.add(
      new Transform(idOrTransform as AgentGraphPureTransformHandler<TC>),
    );
    return this;
  }

  codex(options: CodexTurnOptions<TC>): this;
  codex(id: string, options: CodexTurnOptions<TC>): this;
  codex(
    idOrOptions: string | CodexTurnOptions<TC>,
    maybeOptions?: CodexTurnOptions<TC>,
  ) {
    if (typeof idOrOptions === 'string') {
      if (!maybeOptions) {
        throw new Error('Agent.codex(id, options) requires options.');
      }
      this.graphNodes.push({
        id: idOrOptions,
        type: 'codexTurn',
        data: { template: new CodexTurn(maybeOptions) },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      this.graphNodes.push({
        type: 'codexTurn',
        deriveType: 'codex',
        data: { template: new CodexTurn(idOrOptions) },
      });
      return this;
    }
    this.root.add(new CodexTurn(idOrOptions));
    return this;
  }

  claude(options: ClaudeTurnOptions<TC>): this;
  claude(id: string, options: ClaudeTurnOptions<TC>): this;
  claude(
    idOrOptions: string | ClaudeTurnOptions<TC>,
    maybeOptions?: ClaudeTurnOptions<TC>,
  ) {
    if (typeof idOrOptions === 'string') {
      if (!maybeOptions) {
        throw new Error('Agent.claude(id, options) requires options.');
      }
      this.graphNodes.push({
        id: idOrOptions,
        type: 'claudeTurn',
        data: { template: new ClaudeTurn(maybeOptions) },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      this.graphNodes.push({
        type: 'claudeTurn',
        deriveType: 'claude',
        data: { template: new ClaudeTurn(idOrOptions) },
      });
      return this;
    }
    this.root.add(new ClaudeTurn(idOrOptions));
    return this;
  }

  parallel(template: Parallel<TC>): this;
  parallel(id: string, template: Parallel<TC>): this;
  parallel(idOrTemplate: string | Parallel<TC>, maybeTemplate?: Parallel<TC>) {
    if (typeof idOrTemplate === 'string') {
      if (!maybeTemplate) {
        throw new Error('Agent.parallel(id, template) requires template.');
      }
      this.graphNodes.push({
        id: idOrTemplate,
        type: 'parallel',
        data: { template: maybeTemplate },
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      this.graphNodes.push({
        type: 'parallel',
        data: { template: idOrTemplate },
      });
      return this;
    }
    this.root.add(idOrTemplate);
    return this;
  }

  structured(template: Structured<TC>): this;
  structured<TSchema extends z.ZodType>(schema: TSchema): this;
  structured<TSchema extends z.ZodType>(
    schema: TSchema,
    fold: AgentGraphStructuredFold<TSchema, TC>,
  ): this;
  structured(id: string, template: Structured<TC>): this;
  structured<TSchema extends z.ZodType>(id: string, schema: TSchema): this;
  structured<TSchema extends z.ZodType>(
    id: string,
    schema: TSchema,
    fold: AgentGraphStructuredFold<TSchema, TC>,
  ): this;
  structured(
    idOrValue: string | Structured<TC> | z.ZodType,
    maybeValue?:
      | Structured<TC>
      | z.ZodType
      | AgentGraphStructuredFold<z.ZodType, TC>,
    maybeFold?: AgentGraphStructuredFold<z.ZodType, TC>,
  ) {
    if (typeof idOrValue === 'string') {
      if (!maybeValue) {
        throw new Error(
          'Agent.structured(id, value) requires a Structured template or a schema.',
        );
      }
      if (maybeFold !== undefined && typeof maybeFold !== 'function') {
        throw new Error('Agent.structured fold must be a callback.');
      }
      if (maybeFold && maybeValue instanceof Structured) {
        throw new Error(
          'Agent.structured(id, schema, fold) requires a schema.',
        );
      }
      if (!isStructuredValue<TC>(maybeValue)) {
        throw new Error(
          'Agent.structured(id, value) requires a Structured template or a schema.',
        );
      }
      this.graphNodes.push({
        id: idOrValue,
        type: 'structured',
        data: compactGraphData({
          template: normalizeStructuredValue<TC>(maybeValue),
          fold: maybeFold,
        }),
      });
      return this;
    }
    if (maybeValue !== undefined && typeof maybeValue !== 'function') {
      throw new Error('Agent.structured fold must be a callback.');
    }
    if (maybeValue && idOrValue instanceof Structured) {
      throw new Error('Agent.structured(schema, fold) requires a schema.');
    }
    const template = normalizeStructuredValue<TC>(idOrValue);
    const fold = maybeValue as
      | AgentGraphStructuredFold<z.ZodType, TC>
      | undefined;
    if (this.isGraphAuthoringMode()) {
      this.graphNodes.push({
        type: 'structured',
        data: compactGraphData({ template, fold }),
      });
      return this;
    }
    this.root.add(template);
    if (fold) {
      this.root.add(
        new Transform((session) => {
          const structuredContent = session.getLastMessage()?.structuredContent;
          if (structuredContent === undefined) {
            throw new Error('Structured fold requires structuredContent.');
          }
          const obj = template.parseStructuredContent(structuredContent);
          return fold(obj, session);
        }),
      );
    }
    return this;
  }

  /** Function-based template builders -------------------------------------------------- */

  loop(
    id: string,
    builderFn: (agent: Agent<TC>) => Agent<TC>,
    loopIf: AgentGraphCondition<TC>,
    options?: AgentGraphLoopOptions,
  ): this;
  loop(
    builderFn: (agent: Agent<TC>) => Agent<TC>,
    loopIf?: AgentGraphCondition<TC> | boolean,
    options?: AgentGraphLoopOptions | number,
  ): this;
  loop(
    idOrBuilderFn: string | ((agent: Agent<TC>) => Agent<TC>),
    builderOrLoopIf?:
      | ((agent: Agent<TC>) => Agent<TC>)
      | boolean
      | ((s: Session<TC>) => boolean)
      | AgentGraphCondition<TC>,
    loopIfOrMaxIterations?:
      | AgentGraphCondition<TC>
      | boolean
      | ((s: Session<TC>) => boolean)
      | number
      | AgentGraphLoopOptions,
    maybeOptions?: AgentGraphLoopOptions,
  ): this {
    if (typeof idOrBuilderFn === 'string') {
      const builderFn = builderOrLoopIf as (agent: Agent<TC>) => Agent<TC>;
      const innerAgent = Agent.create<TC>(idOrBuilderFn);
      const builtAgent = builderFn(innerAgent);
      this.graphNodes.push({
        id: idOrBuilderFn,
        type: 'loop',
        data: compactGraphData({
          condition: loopIfOrMaxIterations as AgentGraphCondition<TC>,
          maxIterations: maybeOptions?.maxIterations,
        }),
        children: finalizeGraphNodeIds(builtAgent.graphNodes),
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      const builderFn = idOrBuilderFn;
      const innerAgent = Agent.create<TC>('loop');
      const builtAgent = builderFn(innerAgent);
      const maxIterations =
        typeof loopIfOrMaxIterations === 'number'
          ? loopIfOrMaxIterations
          : isAgentGraphLoopOptions(loopIfOrMaxIterations)
            ? loopIfOrMaxIterations.maxIterations
            : undefined;
      this.graphNodes.push({
        type: 'loop',
        data: compactGraphData({
          condition: builderOrLoopIf as AgentGraphCondition<TC> | undefined,
          maxIterations,
        }),
        children: finalizeGraphNodeIds(builtAgent.graphNodes),
      });
      return this;
    }
    const builderFn = idOrBuilderFn;
    const loopIf = builderOrLoopIf as boolean | ((s: Session<TC>) => boolean);
    const maxIterations = loopIfOrMaxIterations as number | undefined;
    const innerAgent = Agent.create<TC>('loop');
    const builtAgent = builderFn(innerAgent);
    const bodyTemplate = builtAgent.build();

    const loopCondition = typeof loopIf === 'boolean' ? () => loopIf : loopIf;

    this.root.add(
      new Loop({ bodyTemplate, loopIf: loopCondition, maxIterations }),
    );
    return this;
  }

  loopForever(builderFn: (agent: Agent<TC>) => Agent<TC>) {
    return this.loop(builderFn, true);
  }

  conditional(
    id: string,
    condition: AgentGraphCondition<TC>,
    thenBuilderFn: (agent: Agent<TC>) => Agent<TC>,
    elseBuilderFn?: (agent: Agent<TC>) => Agent<TC>,
  ): this;
  conditional(
    condition: (s: Session<TC>) => boolean,
    thenBuilderFn: (agent: Agent<TC>) => Agent<TC>,
    elseBuilderFn?: (agent: Agent<TC>) => Agent<TC>,
  ): this;
  conditional(
    idOrCondition:
      | string
      | ((s: Session<TC>) => boolean)
      | AgentGraphCondition<TC>,
    conditionOrThenBuilder:
      | AgentGraphCondition<TC>
      | ((agent: Agent<TC>) => Agent<TC>),
    thenOrElseBuilder?: (agent: Agent<TC>) => Agent<TC>,
    maybeElseBuilder?: (agent: Agent<TC>) => Agent<TC>,
  ): this {
    if (typeof idOrCondition === 'string') {
      const thenAgent = Agent.create<TC>('then');
      const thenBuilderFn = thenOrElseBuilder;
      if (!thenBuilderFn) {
        throw new Error(
          'Graph Agent.conditional requires conditional(id, condition, thenBuilder).',
        );
      }
      const thenChildren = thenBuilderFn(thenAgent).graphNodes;
      const elseChildren = maybeElseBuilder
        ? maybeElseBuilder(Agent.create<TC>('else')).graphNodes
        : undefined;
      const children = finalizeGraphNodeIds([
        ...thenChildren,
        ...(elseChildren ?? []),
      ]);
      const thenCount = thenChildren.length;
      const thenIds = children.slice(0, thenCount).map((child) => child.id);
      const elseIds =
        elseChildren === undefined
          ? undefined
          : children.slice(thenCount).map((child) => child.id);
      this.graphNodes.push({
        id: idOrCondition,
        type: 'conditional',
        data: compactGraphData({
          condition: conditionOrThenBuilder,
          branches: compactGraphData({
            then: thenIds,
            else: elseIds,
          }),
        }),
        children,
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      const condition = idOrCondition as AgentGraphCondition<TC>;
      const thenBuilderFn = conditionOrThenBuilder as (
        agent: Agent<TC>,
      ) => Agent<TC>;
      const elseBuilderFn = thenOrElseBuilder;
      const thenChildren = thenBuilderFn(Agent.create<TC>('then')).graphNodes;
      const elseChildren = elseBuilderFn
        ? elseBuilderFn(Agent.create<TC>('else')).graphNodes
        : undefined;
      const children = finalizeGraphNodeIds([
        ...thenChildren,
        ...(elseChildren ?? []),
      ]);
      const thenCount = thenChildren.length;
      this.graphNodes.push({
        type: 'conditional',
        data: compactGraphData({
          condition,
          branches: compactGraphData({
            then: children.slice(0, thenCount).map((child) => child.id),
            else:
              elseChildren === undefined
                ? undefined
                : children.slice(thenCount).map((child) => child.id),
          }),
        }),
        children,
      });
      return this;
    }
    const condition = idOrCondition as (s: Session<TC>) => boolean;
    const thenBuilderFn = conditionOrThenBuilder as (
      agent: Agent<TC>,
    ) => Agent<TC>;
    const elseBuilderFn = thenOrElseBuilder;
    const thenAgent = Agent.create<TC>('then');
    const thenTemplate = thenBuilderFn(thenAgent).build();

    let elseTemplate: Template<TC> | undefined;
    if (elseBuilderFn) {
      const elseAgent = Agent.create<TC>('else');
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
    builderFn: (agent: Agent<TC>) => Agent<TC>,
    opts?: ISubroutineTemplateOptions<TC>,
  ): this;
  subroutine(
    id: string,
    builderFn: (agent: Agent<TC>) => Agent<TC>,
    opts?: ISubroutineTemplateOptions<TC>,
  ): this;
  subroutine(
    idOrBuilderFn: string | ((agent: Agent<TC>) => Agent<TC>),
    builderOrOptions?:
      | ((agent: Agent<TC>) => Agent<TC>)
      | ISubroutineTemplateOptions<TC>,
    maybeOptions?: ISubroutineTemplateOptions<TC>,
  ): this {
    if (typeof idOrBuilderFn === 'string') {
      const builderFn = builderOrOptions as (agent: Agent<TC>) => Agent<TC>;
      const innerAgent = Agent.create<TC>(idOrBuilderFn);
      const builtAgent = builderFn(innerAgent);
      this.graphNodes.push({
        id: idOrBuilderFn,
        type: 'scope',
        deriveType: 'subroutine',
        data: graphSubroutineScopeData(maybeOptions),
        children: finalizeGraphNodeIds(builtAgent.graphNodes),
      });
      return this;
    }
    if (this.isGraphAuthoringMode()) {
      const builderFn = idOrBuilderFn;
      const opts = builderOrOptions as
        | ISubroutineTemplateOptions<TC>
        | undefined;
      const innerAgent = Agent.create<TC>('subroutine');
      const builtAgent = builderFn(innerAgent);
      this.graphNodes.push({
        type: 'scope',
        deriveType: 'subroutine',
        data: graphSubroutineScopeData(opts),
        children: finalizeGraphNodeIds(builtAgent.graphNodes),
      });
      return this;
    }
    const builderFn = idOrBuilderFn;
    const opts = builderOrOptions as ISubroutineTemplateOptions<TC> | undefined;
    const innerAgent = Agent.create<TC>('subroutine');
    const builtAgent = builderFn(innerAgent);
    const subroutineTemplate = builtAgent.build();

    this.root.add(new Subroutine(subroutineTemplate, opts));
    return this;
  }

  /** -------------------------------------------------- */

  build(): Template<TC> {
    return this.hasInterceptors() || this.isGraphAuthoringMode()
      ? this.asTemplate()
      : this.root;
  }

  async execute(
    options: AgentExecuteOptionsWithCheckpoint<TC>,
  ): Promise<DurableRunResult<TC>>;
  async execute(
    options?: AgentExecuteOptionsWithoutCheckpoint<TC>,
  ): Promise<Session<TC>>;
  async execute(
    options: AgentExecuteOptions<TC>,
  ): Promise<Session<TC> | DurableRunResult<TC>>;
  async execute(
    options?: AgentExecuteOptions<TC> | Session<TC>,
    runtime?: ExecutionRuntimeState<TC>,
  ): Promise<Session<TC> | DurableRunResult<TC>> {
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

  private asTemplate(): Template<TC> {
    return {
      execute: (session, runtime) => this.executeTemplate(session, runtime),
    };
  }

  private executeTemplate(
    session?: Session<TC>,
    runtime?: ExecutionRuntimeState<TC>,
  ): Promise<Session<TC>> {
    return this.executeInternal(session, runtime) as Promise<Session<TC>>;
  }

  private async executeInternal(
    sessionOrOptions?: Session<TC> | AgentExecuteOptions<TC> | undefined,
    runtimeOrOptions?:
      | ExecutionRuntimeState<TC>
      | AgentExecutionOptions
      | AgentExecutionInternalOptions,
  ): Promise<Session<TC> | DurableRunResult<TC>> {
    if (this.graphNodes.length > 0) {
      const rawOptions =
        sessionOrOptions instanceof Session
          ? { session: sessionOrOptions }
          : (sessionOrOptions as AgentExecuteOptions<TC> | undefined);
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
        ? (sessionOrOptions as AgentExecuteOptions<TC> | undefined)
        : undefined;
    const session = addDirectExecuteInput(
      optionsObject?.session ??
        (sessionOrOptions instanceof Session ? sessionOrOptions : undefined),
      optionsObject?.input,
    );
    assertNoTopLevelStoreOption(optionsObject);
    const parentRuntime = optionsObject
      ? undefined
      : isExecutionRuntimeState<TC>(runtimeOrOptions)
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
          ? createExecutionRuntimeState<TC>({
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
    return {
      runId,
      store,
      returnEnvelope: executionOptions?.checkpoint !== undefined,
    };
  }

  private toLegacyExecutionGraph(): AgentGraph {
    return {
      name: 'direct-agent',
      version: 'legacy-template',
      nodes: expandIntentToolLoops(
        compileLegacyRootTemplate(this.root as Composite<TC>),
        Object.keys(this.graphTools).length > 0,
        true,
      ),
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
    session: Session<TC> | undefined,
    executionOptions:
      | AgentExecutionOptions
      | AgentExecutionInternalOptions
      | undefined,
    durableOptions: ResolvedAgentDirectDurableOptions,
  ): Promise<Session<TC> | DurableRunResult<TC>> {
    return this.executeGraphDirectDurable(
      {
        ...executionOptions,
        session,
      } as AgentExecuteOptions<TC>,
      durableOptions,
    );
  }

  private async executeGraphDirectDurable(
    executionOptions: AgentExecuteOptions<TC> | undefined,
    durableOptions: ResolvedAgentDirectDurableOptions,
  ): Promise<Session<TC> | DurableRunResult<TC>> {
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
    const result = await runtime.executeCheckpointRun<TC>({
      agent: this,
      runId: durableOptions.runId,
      session: executionOptions?.session,
      input: input === undefined ? undefined : graphInputForDurableSend(input),
      context: executionOptions?.context,
    });
    return durableOptions.returnEnvelope ? result : result.session;
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
  returnEnvelope: boolean;
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

function compileLegacyRootTemplate<TC extends Vars>(
  root: Composite<TC>,
): AgentGraphNode[] {
  return compileLegacyCompositeChildren(root, {
    nextIds: new Map<string, number>(),
  });
}

function compileLegacyCompositeChildren<TC extends Vars>(
  composite: Composite<TC>,
  state: LegacyTemplateCompilerState,
): AgentGraphNode[] {
  return composite.getTemplates().flatMap((template, index) => {
    const prepared = composite.ensureTemplateHasContentSource(template);
    return compileLegacyTemplateDirect(prepared, state).map((node) =>
      withLegacyTemplateLifecycle(node, prepared, index),
    );
  });
}

function compileLegacyTemplateDirect<TC extends Vars>(
  template: Template<TC>,
  state: LegacyTemplateCompilerState,
): AgentGraphNode[] {
  return [compileLegacyTemplate(template, state)];
}

function compileLegacyTemplate<TC extends Vars>(
  template: Template<TC>,
  state: LegacyTemplateCompilerState,
): AgentGraphNode {
  if (template instanceof Sequence) {
    return {
      id: nextLegacyNodeId(state, 'sequence'),
      type: 'scope',
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
      type: 'scope',
      data: compactGraphData({
        init: template.getInitFunction(),
        squash: template.getSquashFunction(),
        sessionPolicy: true,
      }),
      children: compileLegacyCompositeChildren(template, state),
    };
  }
  if (template instanceof System) {
    return {
      id: nextLegacyNodeId(state, 'system'),
      type: 'system',
      data: { input: template.getContentSource() },
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
    const descriptor = template.getManifestDescriptor();
    return {
      id: nextLegacyNodeId(state, 'assistant'),
      type: 'assistant',
      data: compactGraphData({
        input: descriptor.contentSource,
        validator: descriptor.validator,
        maxAttempts: descriptor.maxAttempts,
        raiseError: descriptor.raiseError,
        isStaticContent: descriptor.isStaticContent,
      }),
    };
  }
  if (template instanceof GenerateMessages) {
    return {
      id: nextLegacyNodeId(state, 'messages'),
      type: 'transform',
      data: {
        handler: (session: Session<TC>) => {
          let currentSession = session;
          for (const message of template.getGenerateMessages()(session)) {
            currentSession = currentSession.addMessage(message);
          }
          return currentSession;
        },
      },
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

function withLegacyTemplateLifecycle<TC extends Vars>(
  node: AgentGraphNode,
  template: Template<TC>,
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

function wrapLegacyCondition<TC extends Vars>(
  condition: ((session: Session<TC>) => boolean) | undefined,
):
  | ((context: {
      session: Session<TC>;
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

function addDirectExecuteInput<TC extends Vars>(
  session: Session<TC> | undefined,
  input: AgentExecuteOptions<TC>['input'] | undefined,
): Session<TC> | undefined {
  if (input === undefined) {
    return session;
  }
  let current = session ?? Session.create<TC>();
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

function normalizeDirectExecuteInput(
  input: string | GraphInboundInput | readonly GraphInboundInput[],
): GraphInboundInput[] {
  if (typeof input === 'string') {
    return [{ kind: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return [...(input as readonly GraphInboundInput[])];
  }
  return [input as GraphInboundInput];
}

function graphInputForDurableSend(
  input: string | GraphInboundInput | readonly GraphInboundInput[],
):
  | string
  | {
      kind: 'user' | 'system' | 'control';
      content: string;
      attrs?: Readonly<Record<string, unknown>>;
    } {
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
  const inbound = input as GraphInboundInput;
  return {
    kind: inbound.kind ?? 'user',
    content: inbound.content,
    attrs: inbound.attrs,
  };
}

function isExecutionRuntimeState<TC extends Vars>(
  value: unknown,
): value is ExecutionRuntimeState<TC> {
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

function finalizeGraphNodeIds(
  nodes: readonly AgentGraphNodeDraft[],
  options: { legacyLifecycle?: boolean } = {},
): AgentGraphNode[] {
  const authoredIds = new Set(
    nodes.map((node) => node.id).filter((id): id is string => id !== undefined),
  );
  const usedIds = new Set(authoredIds);
  const nextByType = new Map<string, number>();

  return nodes.map((node, index) => {
    const deriveType = graphNodeDeriveType(node);
    let occurrence = (nextByType.get(deriveType) ?? 0) + 1;
    nextByType.set(deriveType, occurrence);

    const id =
      node.id ??
      (() => {
        let candidate = `${deriveType}-${occurrence}`;
        while (usedIds.has(candidate)) {
          occurrence++;
          candidate = `${deriveType}-${occurrence}`;
        }
        return candidate;
      })();
    usedIds.add(id);

    const data =
      options.legacyLifecycle &&
      !graphDataHasKey(node.data, 'legacyTemplateLifecycle')
        ? {
            ...((node.data as Record<string, unknown> | undefined) ?? {}),
            legacyTemplateLifecycle: {
              templateIndex: index,
              templateName: graphNodeTemplateName(node),
            },
          }
        : node.data;

    const finalized: AgentGraphNode = {
      id,
      type: node.type,
      data,
    };
    const metadata =
      node.id === undefined
        ? { ...node.metadata, authoredId: false }
        : node.metadata;
    if (metadata && Object.keys(metadata).length > 0) {
      Object.defineProperty(finalized, 'metadata', {
        value: metadata,
        enumerable: false,
      });
    }
    if (node.children !== undefined) {
      finalized.children = finalizeGraphNodeIds(node.children, options);
    }
    return finalized;
  });
}

function graphNodeDeriveType(node: AgentGraphNodeDraft): string {
  return node.deriveType ?? node.type;
}

function graphNodeTemplateName(node: AgentGraphNodeDraft): string {
  switch (node.deriveType ?? node.type) {
    case 'system':
      return 'System';
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'loop':
      return 'Loop';
    case 'conditional':
      return 'Conditional';
    case 'subroutine':
    case 'scope':
      return 'Subroutine';
    case 'parallel':
      return 'Parallel';
    case 'structured':
      return 'Structured';
    case 'codex':
    case 'codexTurn':
      return 'CodexTurn';
    case 'claude':
    case 'claudeTurn':
      return 'ClaudeTurn';
    case 'transform':
      return 'Transform';
    case 'tools':
      return 'Tools';
    case 'inbox':
      return 'Inbox';
    case 'awaitInput':
      return 'AwaitInput';
    case 'sleep':
      return 'Sleep';
    case 'goal':
      return 'Goal';
    default:
      return 'Template';
  }
}

function graphAssistantValidationData(
  contentOrSource: AgentGraphAssistantInput<any> | undefined,
  validatorOrOptions: IValidator | ValidationOptions | undefined,
): Record<string, unknown> {
  if (!validatorOrOptions) {
    return {};
  }
  if ('validate' in validatorOrOptions) {
    return {
      validator: validatorOrOptions,
      maxAttempts: 1,
      raiseError: true,
      isStaticContent: typeof contentOrSource === 'string',
    };
  }
  return {
    validator: validatorOrOptions.validator,
    maxAttempts: validatorOrOptions.maxAttempts ?? 1,
    raiseError: validatorOrOptions.raiseError ?? true,
    isStaticContent: typeof contentOrSource === 'string',
  };
}

function isAgentGraphLoopOptions(
  value: unknown,
): value is AgentGraphLoopOptions {
  return typeof value === 'object' && value !== null;
}

function normalizeStructuredValue<TC extends Vars>(
  value: Structured<TC> | z.ZodType,
): Structured<TC> {
  return value instanceof Structured ? value : Structured.withSchema<TC>(value);
}

function isStructuredValue<TC extends Vars>(
  value: unknown,
): value is Structured<TC> | z.ZodType {
  return value instanceof Structured || isZodSchema(value);
}

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

function graphSubroutineScopeData<TC extends Vars>(
  options: ISubroutineTemplateOptions<TC> | undefined,
): Record<string, unknown> {
  return {
    init: options?.init,
    squash: options?.squash,
    sessionPolicy: true,
  };
}

function expandIntentToolLoops(
  nodes: readonly AgentGraphNode[],
  hasRegisteredTools: boolean,
  topLevel: boolean,
): AgentGraphNode[] {
  return nodes.flatMap((node, index) => {
    const childExpanded =
      node.children === undefined
        ? node
        : {
            ...node,
            children: expandIntentToolLoops(
              node.children,
              hasRegisteredTools,
              false,
            ),
          };
    const goalExpanded =
      childExpanded.type === 'goal'
        ? expandGoalToolLoop(childExpanded, hasRegisteredTools)
        : childExpanded;

    if (
      topLevel &&
      goalExpanded.type === 'assistant' &&
      hasRegisteredTools &&
      !isManualToolLoopFollower(nodes[index + 1])
    ) {
      return createAutoToolLoopNodes(goalExpanded);
    }

    return [goalExpanded];
  });
}

function createAutoToolLoopNodes(
  assistantNode: AgentGraphNode,
): AgentGraphNode[] {
  return [
    assistantNode,
    {
      id: `${assistantNode.id}-loop`,
      type: 'loop',
      data: { condition: hasPendingToolCalls },
      children: [
        {
          id: `${assistantNode.id}-tools`,
          type: 'tools',
        },
        {
          ...assistantNode,
          children: assistantNode.children,
        },
      ],
    },
  ];
}

function expandGoalToolLoop(
  goalNode: AgentGraphNode,
  hasRegisteredTools: boolean,
): AgentGraphNode {
  if (!hasRegisteredTools && !goalHasToolConfig(goalNode)) {
    return goalNode;
  }
  return {
    ...goalNode,
    children: (goalNode.children ?? []).map((child) => {
      if (child.id !== 'attempts' || child.type !== 'loop') {
        return child;
      }
      const children = child.children ?? [];
      const modelIndex = children.findIndex(
        (candidate) =>
          candidate.id === 'model' && candidate.type === 'assistant',
      );
      const toolsIndex = children.findIndex(
        (candidate) => candidate.id === 'tools' && candidate.type === 'tools',
      );
      if (
        modelIndex === -1 ||
        toolsIndex === -1 ||
        children.some((candidate) => candidate.id === 'model-loop')
      ) {
        return child;
      }
      const modelNode = children[modelIndex];
      const toolsNode = children[toolsIndex];
      return {
        ...child,
        children: [
          ...children.slice(0, modelIndex + 1),
          {
            id: 'model-loop',
            type: 'loop',
            data: { condition: hasPendingToolCalls },
            children: [
              {
                ...toolsNode,
                id: 'model-tools',
              },
              modelNode,
            ],
          },
          ...children.slice(modelIndex + 1).filter((_, childIndex) => {
            return childIndex + modelIndex + 1 !== toolsIndex;
          }),
        ],
      };
    }),
  };
}

function goalHasToolConfig(goalNode: AgentGraphNode): boolean {
  return (goalNode.children ?? []).some(
    (child) =>
      child.id === 'attempts' &&
      child.type === 'loop' &&
      (child.children ?? []).some((attemptChild) => {
        return (
          attemptChild.id === 'tools' &&
          attemptChild.type === 'tools' &&
          graphDataHasKey(attemptChild.data, 'tools')
        );
      }),
  );
}

function graphDataHasKey(data: unknown, key: string): boolean {
  return typeof data === 'object' && data !== null && key in data;
}

function isManualToolLoopFollower(node: AgentGraphNode | undefined): boolean {
  return node?.type === 'tools' || node?.type === 'loop';
}

function hasPendingToolCalls<TC extends Vars>({
  session,
}: {
  session: Session<TC>;
}): boolean {
  return session.hasToolCalls();
}

function compactGraphChildren(
  children: Array<AgentGraphNode | undefined>,
): AgentGraphNode[] {
  return children.filter(
    (child): child is AgentGraphNode => child !== undefined,
  );
}

function isGraphAssistantInput<TC extends Vars>(
  value: unknown,
): value is AgentGraphAssistantInput<TC> {
  return (
    typeof value === 'string' ||
    typeof value === 'function' ||
    value instanceof Source
  );
}

function createGoalGraphNode<TC extends Vars>(
  id: string | undefined,
  goal: string,
  options: AgentGoalOptions<TC>,
): AgentGraphNodeDraft {
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
      type: 'transform',
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
