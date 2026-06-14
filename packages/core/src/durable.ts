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
  on as createRuntimeBindingBuilder,
  runtimeBundle as createRuntimeBundle,
  type BindingDefaults,
  type DeliveryTarget,
  type RuntimeBinding,
  type TriggerEvent,
  type RuntimeBindingLike,
  type RuntimeBundle,
  type Trigger,
} from './runtime_bindings';
import {
  server,
  type RuntimePresence,
  type RuntimePresenceDriver,
  type RuntimeAdapter,
  type RuntimeDeliveryDriver,
  type RuntimeServer,
  type RuntimeServerErrorContext,
  type RuntimeGatewayDriver,
} from './runtime_server';
import { Session, type Vars } from './session';
import {
  executeAgentGraph,
  GraphExecutionSuspended,
  type GraphInboundInput,
} from './graph_executor';
import {
  AgentGraphVersionError,
  createAgentGraphManifest,
  type AgentGraphManifest,
} from './graph';
import type { ProviderSessionBinding } from './provider_session';
import type { Agent } from './templates/agent';
import {
  beginCheckpointGraphExecution,
  computeCheckpointContinuationSkipNodes,
  createCheckpointContinuationSkipPredicate,
  createCheckpointOnceBoundary,
  createCheckpointOnceMemoStore,
  graphHasInboundConsumer,
  recordCheckpointGraphCompletion,
  recordCheckpointGraphSuspension,
  restoreCheckpointGraphCursor,
  type CheckpointOnceBoundary,
  type CheckpointOnceMemoEntry,
  type CheckpointOnceMemoStore,
  type CheckpointOnceOptions,
  type CheckpointOnceScope,
} from './checkpoint_continuation';

export type InboundKind = 'user' | 'system' | 'control';

export interface Inbound {
  offset: number;
  kind: InboundKind;
  content: string;
  attrs?: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id: string;
}

export interface DurableRunResult<TVars extends Vars = Vars> {
  status: 'done' | 'suspended';
  runId: string;
  session: Session<TVars>;
  awaiting?: string;
}

export interface AssistantDeliveryOutboxInput {
  message: PromptTrailMessage & { type: 'assistant' };
  assistantIndex: number;
  idempotencyKey: string;
  target?: unknown;
}

export interface AssistantDeliveryOutboxEntry
  extends AssistantDeliveryOutboxInput {
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

export interface PendingAssistantDeliveryOutboxEntry {
  runId: string;
  entry: AssistantDeliveryOutboxEntry;
}

export type OnceScope = CheckpointOnceScope;

export interface OnceOptions extends CheckpointOnceOptions {}

export interface OnceBoundary extends CheckpointOnceBoundary {}

type OnceMemoStore = CheckpointOnceMemoStore;

export interface StoredRun<TVars extends Vars> {
  agent: PromptTrailRegisteredAgent<TVars>;
  agentName: string;
  graphManifest?: AgentGraphManifest;
  initial: Session<TVars>;
  status: 'open' | 'done';
  result?: Session<TVars>;
  once: OnceMemoStore;
  outbox: AssistantDeliveryOutboxEntry[];
  inbox: Inbound[];
  providerSessions?: Record<string, ProviderSessionBinding>;
  graphCursor?: number;
  graphSuspendedAt?: string;
  context?: Record<string, unknown>;
}

export interface SessionCheckpointDelta<_TVars extends Vars = Vars> {
  fromVersion: number;
  toVersion: number;
  appendedMessages: readonly PromptTrailMessage[];
  varsSet?: Record<string, unknown>;
  varsDeleted?: readonly string[];
  /**
   * Set when the session rewrote (rather than appended to) its message
   * history since the last persisted version — e.g. a hook or middleware
   * patch with `replaceMessages`. The delta is then a full snapshot:
   * `appendedMessages` REPLACES the stored history and `varsSet` carries the
   * complete vars, so stores must not splice it onto previously stored
   * messages.
   */
  rewrite?: boolean;
}

export type StoredRunPatch = Partial<
  Pick<
    StoredRun<any>,
    | 'status'
    | 'graphCursor'
    | 'graphSuspendedAt'
    | 'context'
    | 'agentName'
    | 'graphManifest'
  >
>;

export type PromptTrailRegisteredAgent<TVars extends Vars = Vars> =
  Agent<TVars>;

export interface PromptTrailRunOptions<TVars extends Vars = Vars> {
  agent: string | PromptTrailRegisteredAgent<TVars>;
  runId?: string;
  input?: string | Omit<Inbound, 'offset'>;
  session?: Session<TVars>;
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
  attrs?: Readonly<Record<string, unknown>>;
}

export interface AppGateway {
  start(
    emit: (event: InboundRuntimeEvent) => Promise<void>,
  ): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export interface DurableRunStore {
  /**
   * Reads are now async so networked store backends (Postgres, Redis, libsql)
   * can serve from the backend or a lazy cache rather than hydrating all runs
   * at construction. The in-memory and SQLite implementations still serve from
   * a hydrated Map, so the overhead is a resolved Promise. Writes were already
   * async; this completes the async-on-all-sides contract.
   *
   * Note: `entries()` returns `Promise<Iterable>` (not `AsyncIterable`) to
   * preserve snapshot semantics — callers await the call once and then iterate
   * the materialized snapshot synchronously.
   */
  get(runId: string): Promise<StoredRun<any> | undefined>;
  has(runId: string): Promise<boolean>;
  entries(): Promise<Iterable<[string, StoredRun<any>]>>;
  create(runId: string, run: StoredRun<any>): Promise<void>;
  patch(runId: string, patch: StoredRunPatch): Promise<void>;
  appendInbox(runId: string, inbound: Inbound): Promise<void>;
  appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
  ): Promise<void>;
  recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
  ): Promise<void>;
  upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
  ): Promise<void>;
  recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
  ): Promise<void>;
  delete(runId: string): Promise<void>;
}

export type RunStore = DurableRunStore;

export type CheckpointOption = true | RunStore | { store?: RunStore };

export class MemoryRunStore implements DurableRunStore {
  private runs = new Map<string, StoredRun<any>>();

  async get(runId: string): Promise<StoredRun<any> | undefined> {
    return this.runs.get(runId);
  }

  async create(runId: string, run: StoredRun<any>): Promise<void> {
    this.runs.set(runId, run);
  }

  async has(runId: string): Promise<boolean> {
    return this.runs.has(runId);
  }

  async patch(runId: string, patch: StoredRunPatch): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    Object.assign(run, patch);
  }

  async appendInbox(runId: string, inbound: Inbound): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    if (run.inbox[inbound.offset]) {
      return;
    }
    run.inbox.push(inbound);
  }

  async appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    applySessionCheckpointDelta(run, delta);
  }

  async recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.once[scope].set(key, value);
  }

  async upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    const outbox = (run.outbox ??= []);
    const index = outbox.findIndex(
      (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
    );
    if (index >= 0) {
      outbox[index] = entry;
    } else {
      outbox.push(entry);
    }
  }

  async recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.providerSessions = {
      ...(run.providerSessions ?? {}),
      [nodePath]: binding,
    };
  }

  async delete(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  async entries(): Promise<Iterable<[string, StoredRun<any>]>> {
    return this.runs.entries();
  }
}

export interface PromptTrailAppOptions {
  name?: string;
  store?: DurableRunStore;
  defaults?: BindingDefaults;
  agents?: Record<string, PromptTrailRegisteredAgent<any>>;
  gateways?: Record<string, AppGateway>;
  middleware?: readonly MiddlewareDefinition<any>[];
  hooks?: readonly HookDefinition<any>[];
  observers?: readonly ObserverLike[];
  strictObservers?: boolean;
  observerDeliveryBindings?: ObserverDeliveryBindingOptions;
  adapters?: readonly RuntimeAdapter[];
  presence?: RuntimePresence | false;
  errorMessage?:
    | string
    | ((ctx: RuntimeServerErrorContext) => string | undefined);
}

export class PromptTrailApp {
  private readonly name: string;
  private readonly store: DurableRunStore;
  private readonly agents = new Map<string, Agent<any>>();
  private readonly gateways = new Map<string, AppGateway>();
  private readonly runtimeBindings: RuntimeBinding<TriggerEvent>[] = [];
  private readonly runtimeDefaults: BindingDefaults;
  private readonly middleware: readonly MiddlewareDefinition<any>[];
  private readonly hooks: readonly HookDefinition<any>[];
  private readonly observerBus: ObserverBus;
  private readonly deliveryObserverBus: ObserverBus;
  private readonly strictObservers?: boolean;
  private readonly observerDeliveryBindingOptions?: ObserverDeliveryBindingOptions;
  private readonly observerBuses: ObserverBus[] = [];
  private readonly deliveryObserverBuses: ObserverBus[] = [];
  private nextObserverBusIndex = 0;
  private readonly defaultCheckpoint?: CheckpointOption;
  private readonly runtimeAdapters: RuntimeAdapter[] = [];
  private readonly runtimePresence: RuntimePresence | false | undefined;
  private readonly runtimeErrorMessage:
    | string
    | ((ctx: RuntimeServerErrorContext) => string | undefined)
    | undefined;
  private runtimeServer?: RuntimeServer;
  private runCounter = 0;
  // Event idempotency keys embed this sequence, so it must stay monotonic
  // across resumes of the same run within this process — the lifetime of the
  // in-memory delivery-binding stores that dedupe on those keys. It is not
  // persisted; durable cross-restart sequencing is the async store's job
  // (change list §1.6).
  private readonly runEventSeqs = new Map<string, number>();
  private readonly persistedSessions = new Map<
    string,
    {
      version: number;
      messageCount: number;
      vars: Record<string, unknown>;
    }
  >();

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
    this.runtimePresence = options.presence;
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
    for (const [name, gateway] of Object.entries(options.gateways ?? {})) {
      this.gateways.set(name, gateway);
    }
  }

  agent(registeredAgent: PromptTrailRegisteredAgent<any>): this;
  agent(name: string, registeredAgent: PromptTrailRegisteredAgent<any>): this;
  agent(
    nameOrAgent: string | PromptTrailRegisteredAgent<any>,
    maybeAgent?: PromptTrailRegisteredAgent<any>,
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
    if (this.defaultCheckpoint !== undefined) {
      createAgentGraphManifest(registeredAgent.toGraph());
    }
    this.agents.set(name, registeredAgent);
    return this;
  }

  gateway(gateway: RuntimeGatewayDriver): this;
  gateway(name: string, gateway: AppGateway): this;
  gateway(
    nameOrGateway: string | RuntimeGatewayDriver,
    maybeGateway?: AppGateway,
  ): this {
    if (typeof nameOrGateway !== 'string') {
      return this.adapter({
        name: `gateway:${nameOrGateway.type}`,
        gateways: [nameOrGateway],
      });
    }
    if (!maybeGateway) {
      throw new Error('PromptTrail.app.gateway requires an AppGateway.');
    }
    this.gateways.set(nameOrGateway, maybeGateway);
    return this;
  }

  delivery(driver: RuntimeDeliveryDriver): this {
    return this.adapter({
      name: `delivery:${driver.platform}`,
      deliveries: [driver],
    });
  }

  presence(driver: RuntimePresenceDriver): this {
    return this.adapter({
      name: `presence:${driver.platform}`,
      presences: [driver],
    });
  }

  adapter(adapter: RuntimeAdapter): this {
    this.runtimeAdapters.push(adapter);
    return this;
  }

  on<TEvent extends TriggerEvent>(
    trigger: Trigger<TEvent>,
    configure: (
      binding: ReturnType<typeof createRuntimeBindingBuilder<TEvent>>,
    ) => RuntimeBindingLike<TEvent> | void,
  ): this {
    const builder = createRuntimeBindingBuilder(trigger);
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
          presence: this.runtimePresence,
          strictObservers: this.strictObservers,
          observerDeliveryBindings: this.observerDeliveryBindingOptions,
          errorMessage: this.runtimeErrorMessage,
        });
      }
      await this.runtimeServer.start();
    }
    for (const gateway of this.gateways.values()) {
      await gateway.start((event) => this.handleEvent(event));
    }
  }

  async stop(): Promise<void> {
    await this.runtimeServer?.stop();
    this.runtimeServer = undefined;
    for (const gateway of this.gateways.values()) {
      await gateway.stop?.();
    }
  }

  async run<TVars extends Vars = Vars>(
    options: PromptTrailRunOptions<TVars>,
  ): Promise<DurableRunResult<TVars>> {
    return this.startRun(options);
  }

  async executeCheckpointRun<TVars extends Vars = Vars>(options: {
    agent: Agent<TVars>;
    runId: string;
    input?: string | Omit<Inbound, 'offset'>;
    session?: Session<TVars>;
    context?: Record<string, unknown>;
  }): Promise<DurableRunResult<TVars>> {
    const existing = await this.store.get(options.runId);
    if (existing) {
      existing.agent = options.agent;
      existing.agentName = options.agent.toGraph().name;
      await this.store.patch(options.runId, {
        agentName: existing.agentName,
      });
    }
    if (!(await this.store.has(options.runId))) {
      return this.run<TVars>({
        agent: options.agent,
        runId: options.runId,
        session: options.session,
        input: options.input,
        checkpoint: true,
        context: options.context,
      });
    }
    if (options.input === undefined) {
      return this.resume<TVars>(options.runId);
    }
    return this.send<TVars>({
      runId: options.runId,
      input: options.input,
      checkpoint: true,
      context: options.context,
    });
  }

  async send<TVars extends Vars = Vars>(
    options: PromptTrailSendOptions,
  ): Promise<DurableRunResult<TVars>> {
    const checkpoint =
      options.checkpoint ??
      (options.resumable ? true : undefined) ??
      this.defaultCheckpoint;
    this.assertAppCheckpointStore(checkpoint);
    const existing = await this.store.get(options.runId);
    if (!existing) {
      if (!options.agent) {
        throw new Error(`Unknown durable run: ${options.runId}`);
      }
      return this.startRun<TVars>({
        agent: options.agent,
        runId: options.runId,
        input: options.input,
        checkpoint,
        context: options.context,
      });
    }

    if (options.context) {
      existing.context = cloneDurableRuntimeValue(options.context);
      await this.store.patch(options.runId, {
        context: existing.context,
      });
    }
    if (
      existing.status === 'done' &&
      !graphHasInboundConsumer(existing.agent.toGraph().nodes)
    ) {
      throw new Error(
        `Cannot send input to completed graph run: ${options.runId}. Start a new run or include an inbound consumer before completion.`,
      );
    }
    await this.append(options.runId, normalizeInbound(options.input));
    return this.resume<TVars>(options.runId);
  }

  async resume<TVars extends Vars = Vars>(
    runId: string,
  ): Promise<DurableRunResult<TVars>> {
    const run = await this.getRun<TVars>(runId);
    await this.assertGraphRunManifest(runId, run);
    if (
      run.status === 'done' &&
      run.result &&
      run.inbox.length <= (run.graphCursor ?? run.inbox.length)
    ) {
      return { status: 'done', runId, session: run.result };
    }
    return this.resumeAgentRun(
      runId,
      run as StoredRun<TVars> & {
        agent: Agent<TVars>;
      },
    );
  }

  async prepareAssistantDeliveries(
    runId: string,
    deliveries: readonly AssistantDeliveryOutboxInput[],
  ): Promise<AssistantDeliveryOutboxEntry[]> {
    const run = await this.store.get(runId);
    if (!run) {
      return deliveries.map((delivery) =>
        createAssistantDeliveryOutboxEntry(runId, delivery),
      );
    }
    const outbox = (run.outbox ??= []) as AssistantDeliveryOutboxEntry[];
    for (const delivery of deliveries) {
      const existing = outbox.find(
        (entry) => entry.idempotencyKey === delivery.idempotencyKey,
      );
      if (!existing) {
        const entry = createAssistantDeliveryOutboxEntry(runId, delivery);
        outbox.push(entry);
        await this.store.upsertOutbox(runId, entry);
      } else {
        Object.assign(
          existing,
          completeAssistantDeliveryOutboxMetadata(runId, existing),
        );
        await this.store.upsertOutbox(runId, existing);
      }
    }
    return outbox.filter(
      (entry) =>
        deliveries.some(
          (delivery) => delivery.idempotencyKey === entry.idempotencyKey,
        ) && isRetryableAssistantDeliveryStatus(entry.status),
    );
  }

  async markAssistantDelivery(
    runId: string,
    idempotencyKey: string,
    status: AssistantDeliveryOutboxEntry['status'],
    error?: unknown,
    platformBinding?: unknown,
  ): Promise<void> {
    const run = await this.store.get(runId);
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
    await this.store.upsertOutbox(runId, entry);
  }

  async assistantDeliveryOutbox(
    runId: string,
  ): Promise<readonly AssistantDeliveryOutboxEntry[]> {
    const run = await this.store.get(runId);
    if (!run) {
      return [];
    }
    await this.materializeAssistantDeliveriesForRun(runId, run);
    if (this.backfillAssistantDeliveryOutboxMetadata(runId, run)) {
      await this.persistAssistantDeliveryOutbox(runId, run);
    }
    return run ? [...(run.outbox ?? [])] : [];
  }

  async pendingAssistantDeliveryOutbox(): Promise<
    PendingAssistantDeliveryOutboxEntry[]
  > {
    await this.materializePendingAssistantDeliveries();
    const pending: PendingAssistantDeliveryOutboxEntry[] = [];
    for (const [runId, run] of await this.store.entries()) {
      const changed = this.backfillAssistantDeliveryOutboxMetadata(runId, run);
      for (const entry of run.outbox ?? []) {
        if (isRetryableAssistantDeliveryStatus(entry.status)) {
          pending.push({ runId, entry });
        }
      }
      if (changed) {
        await this.persistAssistantDeliveryOutbox(runId, run);
      }
    }
    return pending;
  }

  private backfillAssistantDeliveryOutboxMetadata<TVars extends Vars = Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): boolean {
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

  async materializePendingAssistantDeliveries(): Promise<void> {
    for (const [runId, run] of await this.store.entries()) {
      await this.materializeAssistantDeliveriesForRun(runId, run);
    }
  }

  private async materializeAssistantDeliveriesForRun<TVars extends Vars = Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): Promise<void> {
    const target = deliveryTargetFromContext(run.context);
    if (!target || !run.result) {
      return;
    }
    const deliveries = run.result.messages
      .filter(
        (
          message,
        ): message is PromptTrailMessage & {
          type: 'assistant';
        } => message.type === 'assistant',
      )
      .map((message, index) => ({
        message,
        assistantIndex: index,
        idempotencyKey: assistantDeliveryKey(runId, index, target),
        target,
      }));
    await this.prepareAssistantDeliveries(runId, deliveries);
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

  private async startRun<TVars extends Vars = Vars>(
    options: PromptTrailRunOptions<TVars>,
  ): Promise<DurableRunResult<TVars>> {
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
      const run: StoredRun<TVars> = {
        agent,
        agentName: graph.name,
        graphManifest,
        initial: options.session ?? Session.create<TVars>(),
        status: 'open',
        once: createCheckpointOnceMemoStore(),
        outbox: [],
        inbox: [],
        providerSessions: {},
        graphCursor: 0,
        context: cloneDurableRuntimeValue(options.context),
      };
      await this.store.create(runId, run);
      this.setPersistedSessionBaseline(runId, run.initial);
      if (options.input !== undefined) {
        await this.append(runId, normalizeInbound(options.input));
      }
      return this.resume<TVars>(runId);
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

  private async executeAgentRun<TVars extends Vars = Vars>(
    agent: Agent<TVars>,
    options: PromptTrailRunOptions<TVars>,
  ): Promise<DurableRunResult<TVars>> {
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
          (error.session as Session<TVars> | undefined) ??
          options.session ??
          Session.create<TVars>();
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

  private async resumeAgentRun<TVars extends Vars = Vars>(
    runId: string,
    run: StoredRun<TVars> & { agent: Agent<TVars> },
  ): Promise<DurableRunResult<TVars>> {
    const graph = run.agent.toGraph();
    const checkpoint = await beginCheckpointGraphExecution(run, () =>
      this.persistRun(runId, run),
    );
    const skipNodePaths = checkpoint.isContinuation
      ? computeCheckpointContinuationSkipNodes(
          graph.nodes,
          graph.name,
          checkpoint.resumeFromNode,
        )
      : undefined;
    const inbox = checkpoint.inbox.map((input) =>
      graphInboundFromStoredInbound(input),
    );
    const durableBoundary = createCheckpointOnceBoundary(run, (entry) =>
      this.recordOnce(runId, entry),
    );

    try {
      const session = await executeAgentGraph<TVars>(
        {
          ...graph,
          middleware: [
            ...graph.middleware,
            ...(this.middleware as readonly MiddlewareDefinition<TVars>[]),
          ],
          hooks: [
            ...graph.hooks,
            ...(this.hooks as readonly HookDefinition<TVars>[]),
          ],
        },
        {
          session: checkpoint.session,
          input: inbox,
          context: cloneDurableRuntimeValue(run.context),
          eventScopeId: runId,
          nextEventSeq: () => this.nextRunEventSeq(runId),
          durableBoundary: () => durableBoundary,
          durableToolExecution: (_context, execute) => {
            return execute(durableBoundary);
          },
          providerSessions: run.providerSessions,
          recordProviderSession: (nodePath, binding) =>
            this.recordProviderSession(runId, run, nodePath, binding),
          observerDeliveryBindings: this.observerDeliveryBindingOptions,
          strictObservers: this.strictObservers,
          resumeFromNode: checkpoint.resumeFromNode,
          skipNode: createCheckpointContinuationSkipPredicate(skipNodePaths),
          observers: [
            async (event) => {
              await this.emitObservers(run, event);
              await this.persistRun(runId, run);
            },
          ],
        },
      );
      await recordCheckpointGraphCompletion(run, session, async () => {
        await this.materializeAssistantDeliveriesForRun(runId, run);
        await this.persistRun(runId, run);
      });
      return { status: 'done', runId, session };
    } catch (error) {
      if (error instanceof GraphExecutionSuspended) {
        const session =
          (error.session as Session<TVars> | undefined) ??
          run.result ??
          run.initial;
        await recordCheckpointGraphSuspension(
          run,
          error.nodePath,
          session,
          () => this.persistRun(runId, run),
        );
        return {
          status: 'suspended',
          runId,
          awaiting: error.nodePath,
          session,
        };
      }
      await restoreCheckpointGraphCursor(run, checkpoint.cursor, () =>
        this.persistRun(runId, run),
      );
      throw error;
    }
  }

  private async assertGraphRunManifest<TVars extends Vars = Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): Promise<void> {
    const graph = run.agent.toGraph();
    const manifest = createAgentGraphManifest(graph);
    if (!run.graphManifest) {
      run.graphManifest = manifest;
      await this.persistRun(runId, run);
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

  private async emitObservers<TVars extends Vars>(
    run: StoredRun<TVars>,
    event: ExecutionEvent,
  ): Promise<void> {
    await this.emitObserverBuses(run, event);
  }

  private async emitObserverBuses<TVars extends Vars>(
    run: StoredRun<TVars>,
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

  private nextRunEventSeq(runId: string): number {
    const seq = this.runEventSeqs.get(runId) ?? 0;
    this.runEventSeqs.set(runId, seq + 1);
    return seq;
  }

  private async append(
    runId: string,
    message: Omit<Inbound, 'offset'>,
  ): Promise<void> {
    const run = await this.getRun(runId);
    const inbound = { ...message, offset: run.inbox.length };
    run.inbox.push(inbound);
    await this.store.appendInbox(runId, inbound);
    if (run.status === 'done') {
      run.status = 'open';
      await this.store.patch(runId, { status: run.status });
    }
  }

  private async persistRun<TVars extends Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): Promise<void> {
    const delta = this.computeSessionCheckpointDelta(runId, run);
    if (delta) {
      await this.store.appendSessionDelta(runId, delta);
      this.setPersistedSessionBaseline(runId, run.result ?? run.initial);
    }
    await this.store.patch(runId, {
      status: run.status,
      graphCursor: run.graphCursor,
      graphSuspendedAt: run.graphSuspendedAt,
      context: run.context,
      agentName: run.agentName,
      graphManifest: run.graphManifest,
    });
  }

  private async recordOnce(
    runId: string,
    entry: CheckpointOnceMemoEntry,
  ): Promise<void> {
    await this.store.recordOnce(runId, entry.scope, entry.key, entry.value);
  }

  private async recordProviderSession<TVars extends Vars>(
    runId: string,
    run: StoredRun<TVars>,
    nodePath: string,
    binding: ProviderSessionBinding,
  ): Promise<void> {
    run.providerSessions = {
      ...(run.providerSessions ?? {}),
      [nodePath]: binding,
    };
    await this.store.recordProviderSession(runId, nodePath, binding);
  }

  private async persistAssistantDeliveryOutbox<TVars extends Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): Promise<void> {
    for (const entry of run.outbox ?? []) {
      await this.store.upsertOutbox(runId, entry);
    }
  }

  private computeSessionCheckpointDelta<TVars extends Vars>(
    runId: string,
    run: StoredRun<TVars>,
  ): SessionCheckpointDelta<TVars> | undefined {
    const session = run.result ?? run.initial;
    const baseline =
      this.persistedSessions.get(runId) ??
      this.setPersistedSessionBaseline(runId, session);
    if (session.version === baseline.version) {
      return undefined;
    }

    if (session.historyRewrittenAtVersion > baseline.version) {
      return {
        fromVersion: baseline.version,
        toVersion: session.version,
        appendedMessages: session.messages,
        varsSet: { ...session.vars },
        rewrite: true,
      };
    }

    const varsDiff = diffVars(baseline.vars, session.vars);
    return {
      fromVersion: baseline.version,
      toVersion: session.version,
      appendedMessages: session.messages.slice(baseline.messageCount),
      ...(Object.keys(varsDiff.varsSet).length > 0
        ? { varsSet: varsDiff.varsSet }
        : {}),
      ...(varsDiff.varsDeleted.length > 0
        ? { varsDeleted: varsDiff.varsDeleted }
        : {}),
    };
  }

  private setPersistedSessionBaseline<TVars extends Vars>(
    runId: string,
    session: Session<TVars>,
  ): { version: number; messageCount: number; vars: Record<string, unknown> } {
    const baseline = {
      version: session.version,
      messageCount: session.messages.length,
      vars: { ...session.vars },
    };
    this.persistedSessions.set(runId, baseline);
    return baseline;
  }

  private resolveAgent<TVars extends Vars>(
    registeredAgent: string | PromptTrailRegisteredAgent<TVars>,
  ): Agent<TVars> | undefined {
    if (typeof registeredAgent === 'string') {
      return this.agents.get(registeredAgent) as Agent<TVars> | undefined;
    }
    return registeredAgent;
  }

  private async getRun<TVars extends Vars>(
    runId: string,
  ): Promise<StoredRun<TVars>> {
    const run = await this.store.get(runId);
    if (!run) {
      throw new Error(`Unknown durable run: ${runId}`);
    }
    return run as StoredRun<TVars>;
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

function createAssistantDeliveryOutboxEntry(
  conversationId: string,
  delivery: AssistantDeliveryOutboxInput,
): AssistantDeliveryOutboxEntry {
  return completeAssistantDeliveryOutboxMetadata(conversationId, {
    ...delivery,
    target: cloneDurableRuntimeValue(delivery.target),
    status: 'pending',
    attempts: 0,
  });
}

function completeAssistantDeliveryOutboxMetadata(
  conversationId: string,
  entry: AssistantDeliveryOutboxInput &
    Partial<
      Pick<
        AssistantDeliveryOutboxEntry,
        'id' | 'conversationId' | 'messageRef' | 'platformBinding'
      >
    > &
    Pick<
      AssistantDeliveryOutboxEntry,
      'status' | 'attempts' | 'lastError' | 'error'
    >,
): AssistantDeliveryOutboxEntry {
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

function applySessionCheckpointDelta<TVars extends Vars>(
  run: StoredRun<TVars>,
  delta: SessionCheckpointDelta<TVars>,
): void {
  const current = run.result ?? run.initial;
  if (current.version >= delta.toVersion) {
    return;
  }
  if (delta.rewrite) {
    run.result = new Session<TVars>(
      [...delta.appendedMessages],
      { ...(delta.varsSet ?? {}) } as TVars,
      current.print,
      delta.toVersion,
      delta.toVersion,
    );
    return;
  }
  const vars = { ...current.vars } as Record<string, unknown>;
  for (const key of delta.varsDeleted ?? []) {
    delete vars[key];
  }
  Object.assign(vars, delta.varsSet);
  run.result = new Session<TVars>(
    [...current.messages, ...delta.appendedMessages],
    vars as TVars,
    current.print,
    delta.toVersion,
  );
}

function diffVars(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): { varsSet: Record<string, unknown>; varsDeleted: string[] } {
  const varsSet: Record<string, unknown> = {};
  const varsDeleted: string[] = [];
  for (const key of Object.keys(previous)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      varsDeleted.push(key);
    }
  }
  for (const [key, value] of Object.entries(next)) {
    if (!Object.is(previous[key], value)) {
      varsSet[key] = value;
    }
  }
  return { varsSet, varsDeleted };
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

function graphInboundFromAppInput(
  input: string | Omit<Inbound, 'offset'>,
): GraphInboundInput {
  if (typeof input === 'string') {
    return { kind: 'user', content: input };
  }
  return {
    kind: input.kind,
    content: input.content,
    attrs: input.attrs,
  };
}

function graphInboundFromStoredInbound(input: Inbound): GraphInboundInput {
  return {
    kind: input.kind,
    content: input.content,
    attrs: input.attrs,
  };
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

export function memoryStore(): DurableRunStore {
  return new MemoryRunStore();
}

export function app(options: PromptTrailAppOptions = {}): PromptTrailApp {
  return new PromptTrailApp(options);
}

export function manualGateway(): AppGateway & {
  emit(event: InboundRuntimeEvent): Promise<void>;
} {
  let emitEvent: ((event: InboundRuntimeEvent) => Promise<void>) | undefined;
  return {
    start(emit) {
      emitEvent = emit;
    },
    async emit(event) {
      if (!emitEvent) {
        throw new Error('Manual gateway has not been started');
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
