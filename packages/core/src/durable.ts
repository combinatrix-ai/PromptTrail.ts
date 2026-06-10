import type { Message as PromptTrailMessage } from './message';
import {
  ObserverBus,
  normalizeObserver,
  type ExecutionEvent,
  type ObserverContext,
  type ObserverDeliveryBindingOptions,
  type ObserverLike,
} from './execution';
import type { HookDefinition, MiddlewareDefinition } from './interceptors';
import { assistantDeliveryKey } from './runtime_delivery_keys';
import {
  bind as createRuntimeBindingBuilder,
  runtimeBundle as createRuntimeBundle,
  type BindingDefaults,
  type DeliveryTarget,
  type RuntimeBinding,
  type RuntimeBindingEvent,
  type RuntimeBindingLike,
  type RuntimeBundle,
  type RuntimeSource,
} from './runtime_bindings';
import {
  server,
  type RuntimeActivity,
  type RuntimeActivityDriver,
  type RuntimeAdapter,
  type RuntimeDeliveryDriver,
  type RuntimeServer,
  type RuntimeServerErrorContext,
  type RuntimeSourceDriver,
} from './runtime_server';
import { Session, type Attrs, type Vars } from './session';
import {
  executeAgentGraph,
  GraphExecutionSuspended,
  type GraphInboundInput,
} from './graph_executor';
import {
  AgentGraphVersionError,
  createAgentGraphManifest,
  type AgentGraphManifest,
  type AgentGraphNode,
} from './graph';
import type { Agent } from './templates/agent';

export type InboundKind = 'user' | 'system' | 'control';

export interface Inbound {
  offset: number;
  kind: InboundKind;
  content: string;
  attrs?: Attrs;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id: string;
}

export interface DurableRunResult<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  status: 'done' | 'suspended';
  runId: string;
  session: Session<TVars, TAttrs>;
  awaiting?: string;
}

export interface AssistantDeliveryOutboxInput<TAttrs extends Attrs = Attrs> {
  message: PromptTrailMessage<TAttrs> & { type: 'assistant' };
  assistantIndex: number;
  idempotencyKey: string;
  target?: unknown;
}

export interface AssistantDeliveryOutboxEntry<TAttrs extends Attrs = Attrs>
  extends AssistantDeliveryOutboxInput<TAttrs> {
  id: string;
  conversationId: string;
  messageRef: {
    conversationId: string;
    assistantIndex: number;
  };
  platformBinding?: unknown;
  status:
    | 'pending'
    | 'delivering'
    | 'delivered'
    | 'failed'
    /** @deprecated Use delivered. */
    | 'completed'
    /** @deprecated Use failed or omit unresolved delivery entries. */
    | 'skipped';
  attempts: number;
  lastError?: string;
  error?: unknown;
}

export interface PendingAssistantDeliveryOutboxEntry<
  TAttrs extends Attrs = Attrs,
> {
  runId: string;
  entry: AssistantDeliveryOutboxEntry<TAttrs>;
}

export type OnceScope = 'run' | 'conversation';

export interface OnceOptions {
  scope?: OnceScope;
}

export interface OnceBoundary {
  once<T>(
    name: string,
    dep: unknown,
    fn: () => T | Promise<T>,
    options?: OnceOptions,
  ): Promise<T>;
}

interface OnceMemoStore {
  run: Map<string, unknown>;
  conversation: Map<string, unknown>;
}

function createOnceMemoStore(): OnceMemoStore {
  return {
    run: new Map<string, unknown>(),
    conversation: new Map<string, unknown>(),
  };
}

function ensureOnceMemoStore(run: { once?: OnceMemoStore }): OnceMemoStore {
  return (run.once ??= createOnceMemoStore());
}

function createOnceBoundary(
  run: { once?: OnceMemoStore },
  persist: () => void,
): OnceBoundary {
  return {
    async once(name, dep, fn, options) {
      const scope = options?.scope ?? 'run';
      const key = onceMemoKey(name, dep);
      const memo = ensureOnceMemoStore(run)[scope];
      if (memo.has(key)) {
        return memo.get(key) as Awaited<ReturnType<typeof fn>>;
      }
      const result = await fn();
      memo.set(key, result);
      persist();
      return result;
    },
  };
}

function onceMemoKey(name: string, dep: unknown): string {
  return name + ':' + hashOnceDep(dep);
}

function hashOnceDep(dep: unknown): string {
  return fnv1a(stableSerialize(dep));
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (seen.has(value)) {
    return '"[Circular]"';
  }
  seen.add(value);
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (value instanceof Map) {
    return stableSerialize(
      [...value.entries()].sort(([left], [right]) =>
        stableSerialize(left).localeCompare(stableSerialize(right)),
      ),
      seen,
    );
  }
  if (value instanceof Set) {
    return stableSerialize(
      [...value.values()].sort((left, right) =>
        stableSerialize(left).localeCompare(stableSerialize(right)),
      ),
      seen,
    );
  }
  if (Array.isArray(value)) {
    return (
      '[' + value.map((item) => stableSerialize(item, seen)).join(',') + ']'
    );
  }
  const serializable = value as { toJSON?: () => unknown };
  if (typeof serializable.toJSON === 'function') {
    return stableSerialize(serializable.toJSON(), seen);
  }
  const record = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map(
        (key) => JSON.stringify(key) + ':' + stableSerialize(record[key], seen),
      )
      .join(',') +
    '}'
  );
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface StoredRun<TVars extends Vars, TAttrs extends Attrs> {
  agent: PromptTrailRegisteredAgent<TVars, TAttrs>;
  agentName: string;
  graphManifest?: AgentGraphManifest;
  initial: Session<TVars, TAttrs>;
  status: 'open' | 'done';
  result?: Session<TVars, TAttrs>;
  once: OnceMemoStore;
  events?: ExecutionEvent[];
  outbox: AssistantDeliveryOutboxEntry<TAttrs>[];
  inbox: Inbound[];
  graphCursor?: number;
  graphSuspendedAt?: string;
  eventSeq?: number;
  context?: Record<string, unknown>;
}

export type PromptTrailRegisteredAgent<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> = Agent<TVars, TAttrs>;

export interface PromptTrailRunOptions<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  agent: string | PromptTrailRegisteredAgent<TVars, TAttrs>;
  runId?: string;
  input?: string | Omit<Inbound, 'offset'>;
  session?: Session<TVars, TAttrs>;
  checkpoint?: CheckpointOption;
  resumable?: boolean;
  context?: Record<string, unknown>;
}

export interface PromptTrailSendOptions {
  agent?: string;
  runId: string;
  input: string | Omit<Inbound, 'offset'>;
  checkpoint?: CheckpointOption;
  resumable?: boolean;
  context?: Record<string, unknown>;
}

export interface InboundRuntimeEvent {
  source: string;
  agent: string;
  runId: string;
  input: string;
  kind?: InboundKind;
  checkpoint?: CheckpointOption;
  resumable?: boolean;
  attrs?: Attrs;
}

export interface EventSource {
  start(
    emit: (event: InboundRuntimeEvent) => Promise<void>,
  ): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export interface DurableRunStore {
  get(runId: string): StoredRun<any, any> | undefined;
  set(runId: string, run: StoredRun<any, any>): void;
  has(runId: string): boolean;
  delete(runId: string): void;
  entries(): Iterable<[string, StoredRun<any, any>]>;
}

export type RunStore = DurableRunStore;

export type CheckpointOption = true | RunStore | { store?: RunStore };

export class MemoryRunStore implements DurableRunStore {
  private runs = new Map<string, StoredRun<any, any>>();

  get(runId: string): StoredRun<any, any> | undefined {
    return this.runs.get(runId);
  }

  set(runId: string, run: StoredRun<any, any>): void {
    this.runs.set(runId, run);
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  entries(): Iterable<[string, StoredRun<any, any>]> {
    return this.runs.entries();
  }
}

export interface PromptTrailAppOptions {
  name?: string;
  store?: DurableRunStore;
  defaults?: BindingDefaults;
  agents?: Record<string, PromptTrailRegisteredAgent<any, any>>;
  sources?: Record<string, EventSource>;
  middleware?: readonly MiddlewareDefinition<any, any>[];
  hooks?: readonly HookDefinition<any, any>[];
  observers?: readonly ObserverLike[];
  strictObservers?: boolean;
  observerDeliveryBindings?: ObserverDeliveryBindingOptions;
  adapters?: readonly RuntimeAdapter[];
  activity?: RuntimeActivity | false;
  errorMessage?:
    | string
    | ((ctx: RuntimeServerErrorContext) => string | undefined);
}

export class PromptTrailApp {
  private readonly name: string;
  private readonly store: DurableRunStore;
  private readonly agents = new Map<string, Agent<any, any>>();
  private readonly sources = new Map<string, EventSource>();
  private readonly runtimeBindings: RuntimeBinding<RuntimeBindingEvent>[] = [];
  private readonly runtimeDefaults: BindingDefaults;
  private readonly middleware: readonly MiddlewareDefinition<any, any>[];
  private readonly hooks: readonly HookDefinition<any, any>[];
  private readonly observerBus: ObserverBus;
  private readonly deliveryObserverBus: ObserverBus;
  private readonly strictObservers?: boolean;
  private readonly observerDeliveryBindingOptions?: ObserverDeliveryBindingOptions;
  private readonly observerBuses: ObserverBus[] = [];
  private readonly deliveryObserverBuses: ObserverBus[] = [];
  private nextObserverBusIndex = 0;
  private readonly defaultCheckpoint?: CheckpointOption;
  private readonly runtimeAdapters: RuntimeAdapter[] = [];
  private readonly runtimeActivity: RuntimeActivity | false | undefined;
  private readonly runtimeErrorMessage:
    | string
    | ((ctx: RuntimeServerErrorContext) => string | undefined)
    | undefined;
  private runtimeServer?: RuntimeServer;
  private runCounter = 0;

  constructor(options: PromptTrailAppOptions = {}) {
    this.name = options.name ?? 'app';
    this.store =
      checkpointOptionStore(options.defaults?.checkpoint) ??
      options.store ??
      new MemoryRunStore();
    this.runtimeDefaults = options.defaults ?? {};
    this.defaultCheckpoint = options.defaults?.checkpoint;
    this.middleware = options.middleware ?? [];
    this.hooks = options.hooks ?? [];
    this.strictObservers = options.strictObservers;
    this.observerDeliveryBindingOptions = options.observerDeliveryBindings;
    this.runtimeAdapters.push(...(options.adapters ?? []));
    this.runtimeActivity = options.activity;
    this.runtimeErrorMessage = options.errorMessage;
    this.observerBus = new ObserverBus(options.observers ?? [], {
      strictObservers: options.strictObservers,
      ...options.observerDeliveryBindings,
    });
    this.deliveryObserverBus = new ObserverBus(options.observers ?? [], {
      strictObservers: options.strictObservers,
      ...options.observerDeliveryBindings,
    });
    for (const [name, registeredAgent] of Object.entries(
      options.agents ?? {},
    )) {
      this.agent(name, registeredAgent);
    }
    for (const [name, source] of Object.entries(options.sources ?? {})) {
      this.sources.set(name, source);
    }
  }

  agent(registeredAgent: PromptTrailRegisteredAgent<any, any>): this;
  agent(
    name: string,
    registeredAgent: PromptTrailRegisteredAgent<any, any>,
  ): this;
  agent(
    nameOrAgent: string | PromptTrailRegisteredAgent<any, any>,
    maybeAgent?: PromptTrailRegisteredAgent<any, any>,
  ): this {
    const registeredAgent =
      typeof nameOrAgent === 'string' ? maybeAgent : nameOrAgent;
    if (!registeredAgent) {
      throw new Error('PromptTrail.app.agent requires an Agent instance.');
    }
    const name =
      typeof nameOrAgent === 'string'
        ? nameOrAgent
        : registeredAgentName(registeredAgent);
    this.agents.set(name, registeredAgent);
    return this;
  }

  source(source: RuntimeSourceDriver): this;
  source(name: string, source: EventSource): this;
  source(
    nameOrSource: string | RuntimeSourceDriver,
    maybeSource?: EventSource,
  ): this {
    if (typeof nameOrSource !== 'string') {
      return this.adapter({
        name: `source:${nameOrSource.type}`,
        sources: [nameOrSource],
      });
    }
    if (!maybeSource) {
      throw new Error('PromptTrail.app.source requires an EventSource.');
    }
    this.sources.set(nameOrSource, maybeSource);
    return this;
  }

  delivery(driver: RuntimeDeliveryDriver): this {
    return this.adapter({
      name: `delivery:${driver.platform}`,
      deliveries: [driver],
    });
  }

  activity(driver: RuntimeActivityDriver): this {
    return this.adapter({
      name: `activity:${driver.platform}`,
      activities: [driver],
    });
  }

  adapter(adapter: RuntimeAdapter): this {
    this.runtimeAdapters.push(adapter);
    return this;
  }

  bind<TEvent extends RuntimeBindingEvent>(
    source: RuntimeSource<TEvent>,
    configure: (
      binding: ReturnType<typeof createRuntimeBindingBuilder<TEvent>>,
    ) => RuntimeBindingLike<TEvent> | void,
  ): this {
    const builder = createRuntimeBindingBuilder(source);
    const bindingLike = configure(builder) ?? builder;
    const compiled = createRuntimeBundle({
      name: this.name,
      agents: this.registeredAgents(),
      bindings: [bindingLike],
    });
    for (const [name, registeredAgent] of Object.entries(compiled.agents)) {
      this.agent(name, registeredAgent);
    }
    this.runtimeBindings.push(...compiled.bindings);
    return this;
  }

  bundle(name = this.name): RuntimeBundle {
    return createRuntimeBundle({
      name,
      agents: this.registeredAgents(),
      defaults: this.runtimeDefaults,
      bindings: this.runtimeBindings,
    });
  }

  observe(observer: ObserverLike): this {
    this.registerObserver(observer);
    return this;
  }

  registerObserver(
    observer: ObserverLike,
    observerDeliveryBindings?: ObserverDeliveryBindingOptions,
    observerNamespace?: string,
  ): () => void {
    const namespace = this.resolveObserverNamespace(
      observerDeliveryBindings,
      observerNamespace,
    );
    const disposeObserver = this.registerObserverOn(
      this.observerBus,
      this.observerBuses,
      observer,
      observerDeliveryBindings,
      namespace,
    );
    const disposeDeliveryObserver = this.registerObserverOn(
      this.deliveryObserverBus,
      this.deliveryObserverBuses,
      observer,
      observerDeliveryBindings,
      namespace,
    );
    return () => {
      disposeObserver();
      disposeDeliveryObserver();
    };
  }

  registerRuntimeObserver(
    observer: ObserverLike,
    observerDeliveryBindings?: ObserverDeliveryBindingOptions,
    observerNamespace?: string,
  ): () => void {
    const namespace = this.resolveObserverNamespace(
      observerDeliveryBindings,
      observerNamespace,
    );
    return this.registerObserverOn(
      this.observerBus,
      this.observerBuses,
      observer,
      observerDeliveryBindings,
      namespace,
    );
  }

  async emitRuntimeDeliveryEvent(
    event: ExecutionEvent,
    context: ObserverContext,
  ): Promise<void> {
    await this.deliveryObserverBus.emit(event, context);
    for (const bus of this.deliveryObserverBuses) {
      await bus.emit(event, context);
    }
  }

  private registerObserverOn(
    observerBus: ObserverBus,
    observerBuses: ObserverBus[],
    observer: ObserverLike,
    observerDeliveryBindings?: ObserverDeliveryBindingOptions,
    observerNamespace?: string,
  ): () => void {
    if (observerDeliveryBindings) {
      if (!observerNamespace) {
        throw new Error(
          'PromptTrail observer delivery binding registration requires a namespace.',
        );
      }
      const normalized = normalizeObserver(observer);
      const namespacedObserver = normalized.name
        ? normalized
        : {
            ...normalized,
            name: observerNamespace,
          };
      const bus = new ObserverBus([namespacedObserver], {
        strictObservers: this.strictObservers,
        ...observerDeliveryBindings,
      });
      observerBuses.push(bus);
      return () => {
        const index = observerBuses.indexOf(bus);
        if (index >= 0) {
          observerBuses.splice(index, 1);
        }
      };
    }
    return observerBus.add(observer);
  }

  private resolveObserverNamespace(
    observerDeliveryBindings: ObserverDeliveryBindingOptions | undefined,
    observerNamespace: string | undefined,
  ): string | undefined {
    if (!observerDeliveryBindings || observerNamespace) {
      return observerNamespace;
    }
    return `appObserver:${this.nextObserverBusIndex++}`;
  }

  async start(): Promise<void> {
    if (this.runtimeAdapters.length > 0) {
      if (!this.runtimeServer) {
        this.runtimeServer = server({
          bundle: this.bundle(),
          runtime: this,
          adapters: this.runtimeAdapters,
          activity: this.runtimeActivity,
          strictObservers: this.strictObservers,
          observerDeliveryBindings: this.observerDeliveryBindingOptions,
          errorMessage: this.runtimeErrorMessage,
        });
      }
      await this.runtimeServer.start();
    }
    for (const source of this.sources.values()) {
      await source.start((event) => this.handleEvent(event));
    }
  }

  async stop(): Promise<void> {
    await this.runtimeServer?.stop();
    this.runtimeServer = undefined;
    for (const source of this.sources.values()) {
      await source.stop?.();
    }
  }

  async run<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    options: PromptTrailRunOptions<TVars, TAttrs>,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    return this.startRun(options);
  }

  async executeCheckpointRun<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(options: {
    agent: Agent<TVars, TAttrs>;
    runId: string;
    input?: string | Omit<Inbound, 'offset'>;
    session?: Session<TVars, TAttrs>;
    context?: Record<string, unknown>;
  }): Promise<DurableRunResult<TVars, TAttrs>> {
    const existing = this.store.get(options.runId);
    if (existing) {
      existing.agent = options.agent;
      existing.agentName = options.agent.toGraph().name;
      this.store.set(options.runId, existing);
    }
    if (!this.store.has(options.runId)) {
      return this.run<TVars, TAttrs>({
        agent: options.agent,
        runId: options.runId,
        session: options.session,
        input: options.input,
        checkpoint: true,
        context: options.context,
      });
    }
    if (options.input === undefined) {
      return this.resume<TVars, TAttrs>(options.runId);
    }
    return this.send<TVars, TAttrs>({
      runId: options.runId,
      input: options.input,
      checkpoint: true,
      context: options.context,
    });
  }

  async send<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    options: PromptTrailSendOptions,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const checkpoint =
      options.checkpoint ??
      (options.resumable ? true : undefined) ??
      this.defaultCheckpoint;
    this.assertAppCheckpointStore(checkpoint);
    const existing = this.store.get(options.runId);
    if (!existing) {
      if (!options.agent) {
        throw new Error(`Unknown durable run: ${options.runId}`);
      }
      return this.startRun<TVars, TAttrs>({
        agent: options.agent,
        runId: options.runId,
        input: options.input,
        checkpoint,
        context: options.context,
      });
    }

    if (options.context) {
      existing.context = cloneDurableRuntimeValue(options.context);
    }
    if (
      existing.status === 'done' &&
      !graphHasInboundConsumer(existing.agent.toGraph().nodes)
    ) {
      throw new Error(
        `Cannot send input to completed graph run: ${options.runId}. Start a new run or include an inbound consumer before completion.`,
      );
    }
    this.append(options.runId, normalizeInbound(options.input));
    return this.resume<TVars, TAttrs>(options.runId);
  }

  async resume<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    runId: string,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const run = this.getRun<TVars, TAttrs>(runId);
    this.assertGraphRunManifest(runId, run);
    if (
      run.status === 'done' &&
      run.result &&
      run.inbox.length <= (run.graphCursor ?? run.inbox.length)
    ) {
      return { status: 'done', runId, session: run.result };
    }
    return this.resumeAgentRun(
      runId,
      run as StoredRun<TVars, TAttrs> & {
        agent: Agent<TVars, TAttrs>;
      },
    );
  }

  prepareAssistantDeliveries<TAttrs extends Attrs = Attrs>(
    runId: string,
    deliveries: readonly AssistantDeliveryOutboxInput<TAttrs>[],
  ): AssistantDeliveryOutboxEntry<TAttrs>[] {
    const run = this.store.get(runId);
    if (!run) {
      return deliveries.map((delivery) =>
        createAssistantDeliveryOutboxEntry(runId, delivery),
      );
    }
    const outbox = (run.outbox ??=
      []) as AssistantDeliveryOutboxEntry<TAttrs>[];
    for (const delivery of deliveries) {
      const existing = outbox.find(
        (entry) => entry.idempotencyKey === delivery.idempotencyKey,
      );
      if (!existing) {
        outbox.push(createAssistantDeliveryOutboxEntry(runId, delivery));
      } else {
        Object.assign(
          existing,
          completeAssistantDeliveryOutboxMetadata(runId, existing),
        );
      }
    }
    this.store.set(runId, run);
    return outbox.filter(
      (entry) =>
        deliveries.some(
          (delivery) => delivery.idempotencyKey === entry.idempotencyKey,
        ) && isRetryableAssistantDeliveryStatus(entry.status),
    );
  }

  markAssistantDelivery(
    runId: string,
    idempotencyKey: string,
    status: AssistantDeliveryOutboxEntry['status'],
    error?: unknown,
    platformBinding?: unknown,
  ): void {
    const run = this.store.get(runId);
    if (!run) {
      return;
    }
    const entry = (run.outbox ?? []).find(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    if (!entry) {
      return;
    }
    entry.status = status;
    entry.attempts ??= 0;
    if (status === 'delivering') {
      entry.attempts += 1;
      entry.error = undefined;
      entry.lastError = undefined;
    } else if (status === 'failed') {
      entry.error = error;
      entry.lastError = errorMessage(error);
    } else if (
      status === 'delivered' ||
      status === 'completed' ||
      status === 'skipped'
    ) {
      entry.error = undefined;
      entry.lastError = undefined;
    } else {
      entry.error = error;
      entry.lastError = error === undefined ? undefined : errorMessage(error);
    }
    if (platformBinding !== undefined) {
      entry.platformBinding = cloneDurableRuntimeValue(platformBinding);
    }
    this.store.set(runId, run);
  }

  assistantDeliveryOutbox(
    runId: string,
  ): readonly AssistantDeliveryOutboxEntry[] {
    const run = this.store.get(runId);
    if (!run) {
      return [];
    }
    this.materializeAssistantDeliveriesForRun(runId, run);
    if (this.backfillAssistantDeliveryOutboxMetadata(runId, run)) {
      this.store.set(runId, run);
    }
    return run ? [...(run.outbox ?? [])] : [];
  }

  events(runId: string): readonly ExecutionEvent[] {
    const run = this.store.get(runId);
    return run ? [...(run.events ?? [])] : [];
  }

  async replayEvents(
    runId: string,
    observers?: readonly ObserverLike[],
  ): Promise<readonly ExecutionEvent[]> {
    const run = this.getRun(runId);
    const events = (run.events ?? []).map((event) => ({
      ...event,
      replay: 'replayed' as const,
    }));
    if (observers) {
      const bus = new ObserverBus(observers, {
        strictObservers: this.strictObservers,
        ...this.observerDeliveryBindingOptions,
      });
      const context = observerContextFromRunContext(run.context);
      for (const event of events) {
        await bus.emit(event, context);
      }
      return events;
    }
    for (const event of events) {
      await this.emitReplayedObservers(run, event);
    }
    return events;
  }

  pendingAssistantDeliveryOutbox(): PendingAssistantDeliveryOutboxEntry[] {
    this.materializePendingAssistantDeliveries();
    const pending: PendingAssistantDeliveryOutboxEntry[] = [];
    for (const [runId, run] of this.store.entries()) {
      const changed = this.backfillAssistantDeliveryOutboxMetadata(runId, run);
      for (const entry of run.outbox ?? []) {
        if (isRetryableAssistantDeliveryStatus(entry.status)) {
          pending.push({ runId, entry });
        }
      }
      if (changed) {
        this.store.set(runId, run);
      }
    }
    return pending;
  }

  private backfillAssistantDeliveryOutboxMetadata<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(runId: string, run: StoredRun<TVars, TAttrs>): boolean {
    let changed = false;
    for (const entry of run.outbox ?? []) {
      const completed = completeAssistantDeliveryOutboxMetadata(runId, entry);
      if (
        entry.id !== completed.id ||
        entry.conversationId !== completed.conversationId ||
        entry.messageRef !== completed.messageRef
      ) {
        Object.assign(entry, completed);
        changed = true;
      }
    }
    return changed;
  }

  materializePendingAssistantDeliveries(): void {
    for (const [runId, run] of this.store.entries()) {
      this.materializeAssistantDeliveriesForRun(runId, run);
    }
  }

  private materializeAssistantDeliveriesForRun<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(runId: string, run: StoredRun<TVars, TAttrs>): void {
    const target = deliveryTargetFromContext(run.context);
    if (!target || !run.result) {
      return;
    }
    const deliveries = run.result.messages
      .filter(
        (
          message,
        ): message is PromptTrailMessage<TAttrs> & {
          type: 'assistant';
        } => message.type === 'assistant',
      )
      .map((message, index) => ({
        message,
        assistantIndex: index,
        idempotencyKey: assistantDeliveryKey(runId, index, target),
        target,
      }));
    this.prepareAssistantDeliveries(runId, deliveries);
  }

  private async handleEvent(event: InboundRuntimeEvent): Promise<void> {
    await this.send({
      agent: event.agent,
      runId: event.runId,
      input: {
        kind: event.kind ?? 'user',
        content: event.input,
        attrs: event.attrs,
      },
      checkpoint: event.checkpoint,
      resumable: event.resumable,
    });
  }

  private async startRun<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(
    options: PromptTrailRunOptions<TVars, TAttrs>,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const checkpoint =
      options.checkpoint ??
      (options.resumable ? true : undefined) ??
      this.defaultCheckpoint;
    this.assertAppCheckpointStore(checkpoint);
    const durable = checkpoint !== undefined;
    const agent = this.resolveAgent(options.agent);
    if (!agent) {
      throw new Error(`Unknown agent: ${String(options.agent)}`);
    }
    if (durable) {
      const graph = agent.toGraph();
      const graphManifest = createAgentGraphManifest(graph);
      const runId = options.runId ?? `${graph.name}-${++this.runCounter}`;
      const run: StoredRun<TVars, TAttrs> = {
        agent,
        agentName: graph.name,
        graphManifest,
        initial: options.session ?? Session.create<TVars, TAttrs>(),
        status: 'open',
        once: createOnceMemoStore(),
        events: [],
        outbox: [],
        inbox: [],
        graphCursor: 0,
        eventSeq: 0,
        context: cloneDurableRuntimeValue(options.context),
      };
      this.store.set(runId, run);
      if (options.input !== undefined) {
        this.append(runId, normalizeInbound(options.input));
      }
      return this.resume<TVars, TAttrs>(runId);
    }
    return this.executeAgentRun(agent, options);
  }

  private assertAppCheckpointStore(
    checkpoint: CheckpointOption | undefined,
  ): void {
    const store = checkpointOptionStore(checkpoint);
    if (store && store !== this.store) {
      throw new Error(
        'App checkpoint store overrides are not supported yet. Configure the store on PromptTrail.app({ store }) and use checkpoint: true.',
      );
    }
  }

  private async executeAgentRun<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(
    agent: Agent<TVars, TAttrs>,
    options: PromptTrailRunOptions<TVars, TAttrs>,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const graph = agent.toGraph();
    const runId = options.runId ?? `${graph.name}-${++this.runCounter}`;
    let eventSeq = 0;
    const emitGraphRunEvent = async (
      type: 'run.started' | 'run.completed' | 'run.suspended' | 'error',
      event: Partial<ExecutionEvent> = {},
    ) => {
      const seq = eventSeq++;
      await this.observerBus.emit(
        {
          id: `${runId}:${seq}:${type}`,
          type,
          at: new Date().toISOString(),
          seq,
          conversationId: runId,
          runId,
          replay: 'live',
          source: 'app',
          ...event,
          idempotencyKey:
            event.idempotencyKey ?? runEventIdempotencyKey(runId, seq, type),
        },
        observerContextFromRunContext(options.context),
      );
    };
    await emitGraphRunEvent('run.started', { sessionVersion: 0 });
    try {
      const session = await agent.execute({
        session: options.session,
        input:
          options.input === undefined
            ? undefined
            : graphInboundFromAppInput(options.input),
        context: options.context,
      });
      await emitGraphRunEvent('run.completed', {
        sessionVersion: session.messages.length,
      });
      return { status: 'done', runId, session };
    } catch (error) {
      if (error instanceof GraphExecutionSuspended) {
        const session =
          (error.session as Session<TVars, TAttrs> | undefined) ??
          options.session ??
          Session.create<TVars, TAttrs>();
        await emitGraphRunEvent('run.suspended', {
          stepId: error.nodePath,
          sessionVersion: session.messages.length,
        });
        return {
          status: 'suspended',
          runId,
          awaiting: error.nodePath,
          session,
        };
      }
      await emitGraphRunEvent('error', {
        sessionVersion: 0,
        raw: { error },
      });
      throw error;
    }
  }

  private async resumeAgentRun<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(
    runId: string,
    run: StoredRun<TVars, TAttrs> & { agent: Agent<TVars, TAttrs> },
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const graph = run.agent.toGraph();
    const cursor = run.graphCursor ?? 0;
    const isContinuation = run.result !== undefined;
    // Continuation skips replay the deterministic prefix once, then let loop
    // children execute normally for any later iteration in the same resume.
    const skipNodePaths = isContinuation
      ? collectGraphContinuationSkipNodes(
          graph.nodes,
          graph.name,
          run.graphSuspendedAt,
        )
      : undefined;
    const inbox = run.inbox
      .slice(cursor)
      .map((input) => graphInboundFromStoredInbound<TAttrs>(input));
    run.graphCursor = run.inbox.length;
    this.persistRun(runId, run);

    try {
      const session = await executeAgentGraph<TVars, TAttrs>(
        {
          ...graph,
          middleware: [
            ...graph.middleware,
            ...(this.middleware as readonly MiddlewareDefinition<
              TVars,
              TAttrs
            >[]),
          ],
          hooks: [
            ...graph.hooks,
            ...(this.hooks as readonly HookDefinition<TVars, TAttrs>[]),
          ],
        },
        {
          session: run.result ?? run.initial,
          input: inbox,
          context: cloneDurableRuntimeValue(run.context),
          eventScopeId: runId,
          nextEventSeq: () => this.nextRunEventSeq(runId, run),
          durableToolExecution: (_context, execute) => {
            return execute(
              createOnceBoundary(run, () => this.persistRun(runId, run)),
            );
          },
          observerDeliveryBindings: this.observerDeliveryBindingOptions,
          strictObservers: this.strictObservers,
          resumeFromNode: run.graphSuspendedAt,
          skipNode: skipNodePaths
            ? (_node, nodePath) => {
                if (!skipNodePaths.has(nodePath)) {
                  return false;
                }
                skipNodePaths.delete(nodePath);
                return true;
              }
            : undefined,
          observers: [
            async (event) => {
              await this.emitObservers(run, event);
              this.persistRun(runId, run);
            },
          ],
        },
      );
      run.status = 'done';
      run.result = session;
      run.graphSuspendedAt = undefined;
      this.materializeAssistantDeliveriesForRun(runId, run);
      this.persistRun(runId, run);
      return { status: 'done', runId, session };
    } catch (error) {
      if (error instanceof GraphExecutionSuspended) {
        const session =
          (error.session as Session<TVars, TAttrs> | undefined) ??
          run.result ??
          run.initial;
        run.result = session;
        run.graphSuspendedAt = error.nodePath;
        this.persistRun(runId, run);
        return {
          status: 'suspended',
          runId,
          awaiting: error.nodePath,
          session,
        };
      }
      run.graphCursor = cursor;
      this.persistRun(runId, run);
      throw error;
    }
  }

  private assertGraphRunManifest<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(runId: string, run: StoredRun<TVars, TAttrs>): void {
    const graph = run.agent.toGraph();
    const manifest = createAgentGraphManifest(graph);
    if (!run.graphManifest) {
      run.graphManifest = manifest;
      this.persistRun(runId, run);
      return;
    }
    if (run.graphManifest.hash !== manifest.hash) {
      throw new AgentGraphVersionError(
        run.graphManifest.hash,
        manifest.hash,
        graph.name,
      );
    }
  }

  private async emitRunEvent<TVars extends Vars, TAttrs extends Attrs>(
    run: StoredRun<TVars, TAttrs>,
    runId: string,
    type: 'run.started' | 'run.completed' | 'run.suspended' | 'error',
    options: Partial<ExecutionEvent> = {},
  ): Promise<void> {
    const seq = this.nextRunEventSeq(runId, run);
    await this.emitObservers(run, {
      id: `${runId}:${seq}:${type}`,
      type,
      at: new Date().toISOString(),
      seq,
      conversationId: runId,
      runId,
      replay: 'live',
      source: 'app',
      ...options,
      idempotencyKey:
        options.idempotencyKey ?? runEventIdempotencyKey(runId, seq, type),
    });
    this.persistRun(runId, run);
  }

  private async emitObservers<TVars extends Vars, TAttrs extends Attrs>(
    run: StoredRun<TVars, TAttrs>,
    event: ExecutionEvent,
  ): Promise<void> {
    if ((event.replay ?? 'live') === 'live') {
      (run.events ??= []).push({ ...event });
    }
    await this.emitObserverBuses(run, event);
  }

  private async emitReplayedObservers<TVars extends Vars, TAttrs extends Attrs>(
    run: StoredRun<TVars, TAttrs>,
    event: ExecutionEvent,
  ): Promise<void> {
    await this.emitObserverBuses(run, event);
  }

  private async emitObserverBuses<TVars extends Vars, TAttrs extends Attrs>(
    run: StoredRun<TVars, TAttrs>,
    event: ExecutionEvent,
  ): Promise<void> {
    const context = observerContextFromRunContext(run.context);
    await this.observerBus.emit(event, context);
    for (const bus of this.observerBuses) {
      await bus.emit(event, context);
    }
  }

  private registeredAgents(): Record<string, PromptTrailRegisteredAgent> {
    return Object.fromEntries(this.agents.entries());
  }

  private nextRunEventSeq<TVars extends Vars, TAttrs extends Attrs>(
    runId: string,
    run: StoredRun<TVars, TAttrs>,
  ): number {
    const seq = run.eventSeq ?? 0;
    run.eventSeq = seq + 1;
    this.persistRun(runId, run);
    return seq;
  }

  private append(runId: string, message: Omit<Inbound, 'offset'>): void {
    const run = this.getRun(runId);
    run.inbox.push({ ...message, offset: run.inbox.length });
    if (run.status === 'done') {
      run.status = 'open';
    }
    this.persistRun(runId, run);
  }

  private persistRun<TVars extends Vars, TAttrs extends Attrs>(
    runId: string,
    run: StoredRun<TVars, TAttrs>,
  ): void {
    if (!this.store.has(runId)) {
      return;
    }
    this.store.set(runId, run);
  }

  private resolveAgent<TVars extends Vars, TAttrs extends Attrs>(
    registeredAgent: string | PromptTrailRegisteredAgent<TVars, TAttrs>,
  ): Agent<TVars, TAttrs> | undefined {
    if (typeof registeredAgent === 'string') {
      return this.agents.get(registeredAgent) as
        | Agent<TVars, TAttrs>
        | undefined;
    }
    return registeredAgent;
  }

  private getRun<TVars extends Vars, TAttrs extends Attrs>(
    runId: string,
  ): StoredRun<TVars, TAttrs> {
    const run = this.store.get(runId);
    if (!run) {
      throw new Error(`Unknown durable run: ${runId}`);
    }
    return run as StoredRun<TVars, TAttrs>;
  }
}

function normalizeInbound(
  input: string | Omit<Inbound, 'offset'>,
): Omit<Inbound, 'offset'> {
  return typeof input === 'string' ? { kind: 'user', content: input } : input;
}

function deliveryTargetFromContext(
  context: Record<string, unknown> | undefined,
): DeliveryTarget | undefined {
  const delivery = context?.delivery;
  if (
    delivery &&
    typeof delivery === 'object' &&
    'platform' in delivery &&
    typeof (delivery as { platform?: unknown }).platform === 'string'
  ) {
    return delivery as DeliveryTarget;
  }
  return undefined;
}

function observerContextFromRunContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    runContext: cloneDurableRuntimeValue(context),
    delivery: cloneDurableRuntimeValue(deliveryTargetFromContext(context)),
  };
}

function isRetryableAssistantDeliveryStatus(
  status: AssistantDeliveryOutboxEntry['status'],
): boolean {
  return status === 'pending' || status === 'delivering' || status === 'failed';
}

function createAssistantDeliveryOutboxEntry<TAttrs extends Attrs>(
  conversationId: string,
  delivery: AssistantDeliveryOutboxInput<TAttrs>,
): AssistantDeliveryOutboxEntry<TAttrs> {
  return completeAssistantDeliveryOutboxMetadata(conversationId, {
    ...delivery,
    target: cloneDurableRuntimeValue(delivery.target),
    status: 'pending',
    attempts: 0,
  });
}

function completeAssistantDeliveryOutboxMetadata<TAttrs extends Attrs>(
  conversationId: string,
  entry: AssistantDeliveryOutboxInput<TAttrs> &
    Partial<
      Pick<
        AssistantDeliveryOutboxEntry<TAttrs>,
        'id' | 'conversationId' | 'messageRef' | 'platformBinding'
      >
    > &
    Pick<
      AssistantDeliveryOutboxEntry<TAttrs>,
      'status' | 'attempts' | 'lastError' | 'error'
    >,
): AssistantDeliveryOutboxEntry<TAttrs> {
  return {
    ...entry,
    id: entry.id ?? entry.idempotencyKey,
    conversationId: entry.conversationId ?? conversationId,
    messageRef: entry.messageRef ?? {
      conversationId,
      assistantIndex: entry.assistantIndex,
    },
  };
}

function cloneDurableRuntimeValue<T>(value: T): T {
  if (!value || typeof value !== 'object') {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    if (Array.isArray(value)) {
      return [...value] as T;
    }
    return { ...(value as Record<string, unknown>) } as T;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registeredAgentName(agent: PromptTrailRegisteredAgent): string {
  if (typeof agent.name === 'string' && agent.name.length > 0) {
    return agent.name;
  }
  throw new Error('PromptTrail.app.agent requires Agent.create(name).');
}

function graphInboundFromAppInput<TAttrs extends Attrs>(
  input: string | Omit<Inbound, 'offset'>,
): GraphInboundInput<TAttrs> {
  if (typeof input === 'string') {
    return { kind: 'user', content: input };
  }
  return {
    kind: input.kind,
    content: input.content,
    attrs: input.attrs as TAttrs | undefined,
  };
}

function graphInboundFromStoredInbound<TAttrs extends Attrs>(
  input: Inbound,
): GraphInboundInput<TAttrs> {
  return {
    kind: input.kind,
    content: input.content,
    attrs: input.attrs as TAttrs | undefined,
  };
}

function skipGraphContinuationBootstrapNode(node: {
  type: string;
  data?: unknown;
}): boolean {
  return node.type === 'system' || isStaticGraphUserNode(node);
}

function collectGraphContinuationSkipNodes(
  nodes: readonly AgentGraphNode[],
  graphName: string,
  suspendedAt?: string,
): Set<string> {
  const skipNodePaths = new Set<string>();
  let reachedContinuationEntry = false;

  const visit = (
    children: readonly AgentGraphNode[],
    parentPath: string,
  ): void => {
    for (const child of children) {
      if (reachedContinuationEntry) {
        return;
      }
      const nodePath = `${parentPath}/${child.id}`;
      if (
        (suspendedAt && nodePath === suspendedAt) ||
        (!suspendedAt && isGraphInboundConsumerNode(child))
      ) {
        reachedContinuationEntry = true;
        return;
      }
      if (
        skipGraphContinuationBootstrapNode(child) ||
        (child.children ?? []).length === 0
      ) {
        skipNodePaths.add(nodePath);
      }
      visit(child.children ?? [], nodePath);
    }
  };

  visit(nodes, graphName);
  return skipNodePaths;
}

function isGraphInboundConsumerNode(node: AgentGraphNode): boolean {
  return (
    node.type === 'inbox' ||
    node.type === 'awaitInput' ||
    (node.type === 'user' && !isStaticGraphUserNode(node))
  );
}

function graphHasInboundConsumer(nodes: readonly AgentGraphNode[]): boolean {
  return nodes.some(
    (node) =>
      isGraphInboundConsumerNode(node) ||
      graphHasInboundConsumer(node.children ?? []),
  );
}

function isStaticGraphUserNode(node: {
  type: string;
  data?: unknown;
}): boolean {
  return (
    node.type === 'user' &&
    typeof node.data === 'object' &&
    node.data !== null &&
    ('input' in node.data || 'content' in node.data)
  );
}

function runEventIdempotencyKey(
  runId: string,
  seq: number,
  type: string,
): string {
  return `${runId}:run:${seq}:${type}`;
}

function checkpointOptionStore(
  option: CheckpointOption | undefined,
): RunStore | undefined {
  if (option === undefined || option === true) {
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
    'set' in value &&
    'has' in value &&
    'delete' in value &&
    'entries' in value
  );
}

export function memoryStore(): DurableRunStore {
  return new MemoryRunStore();
}

export function app(options: PromptTrailAppOptions = {}): PromptTrailApp {
  return new PromptTrailApp(options);
}

export function manualSource(): EventSource & {
  emit(event: InboundRuntimeEvent): Promise<void>;
} {
  let emitEvent: ((event: InboundRuntimeEvent) => Promise<void>) | undefined;
  return {
    start(emit) {
      emitEvent = emit;
    },
    async emit(event) {
      if (!emitEvent) {
        throw new Error('Manual source has not been started');
      }
      await emitEvent(event);
    },
  };
}

export const PromptTrail = {
  app,
  runtimeBundle: createRuntimeBundle,
  server,
};
