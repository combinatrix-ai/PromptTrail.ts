import type {
  PendingAssistantDeliveryOutboxEntry,
  PromptTrailApp,
} from './durable';
import {
  ObserverFailureError,
  ObserverBus,
  normalizeObserver,
  type ExecutionEvent,
  type ObserverDeliveryBindingOptions,
  type ObserverLike,
} from './execution';
import type { Message } from './message';
import type { Attrs } from './session';
import type { DeliveryTarget, RuntimeBindingEvent } from './runtime_bindings';
import {
  AssistantDeliveryTracker,
  dispatchRuntimeBindingEvent,
  findRuntimeBinding,
  mergeBindingDefaults,
  passesDiscordBehavior,
  resolveRuntimeDelivery,
  type RuntimeDispatchResult,
} from './runtime_dispatch';
import type { RuntimeBundle } from './runtime_bindings';

export interface RuntimeActivity {
  kind: string;
}

export interface RuntimeActivityHandle {
  stop(): Promise<void> | void;
}

export interface RuntimeSourceEmitOptions {
  content?: string;
  attrs?: Record<string, unknown>;
}

export interface RuntimeSourceContext<
  TEvent extends RuntimeBindingEvent = RuntimeBindingEvent,
> {
  emit(event: TEvent, options?: RuntimeSourceEmitOptions): Promise<void>;
}

export interface RuntimeSourceDriver<
  TEvent extends RuntimeBindingEvent = RuntimeBindingEvent,
> {
  type: string;
  start(ctx: RuntimeSourceContext<TEvent>): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export interface RuntimeDeliveryContext {
  conversationId: string;
  idempotencyKey: string;
  event: RuntimeBindingEvent;
  delivery: DeliveryTarget;
  platformBinding?: unknown;
}

export interface RuntimeDeliveryDriver<
  TTarget extends DeliveryTarget = DeliveryTarget,
> {
  platform: string;
  deliver(
    ctx: RuntimeDeliveryContext,
    target: TTarget,
    message: Message,
  ): Promise<unknown> | unknown;
}

export interface RuntimeActivityContext {
  event: RuntimeBindingEvent;
  delivery: DeliveryTarget;
}

export interface RuntimeActivityDriver<
  TTarget extends DeliveryTarget = DeliveryTarget,
> {
  platform: string;
  start(
    ctx: RuntimeActivityContext,
    target: TTarget,
    activity: RuntimeActivity,
  ):
    | Promise<RuntimeActivityHandle | undefined>
    | RuntimeActivityHandle
    | undefined;
}

export interface RuntimeAdapter {
  name: string;
  sources?: readonly RuntimeSourceDriver[];
  deliveries?: readonly RuntimeDeliveryDriver[];
  activities?: readonly RuntimeActivityDriver[];
  observers?: readonly ObserverLike[];
}

export interface RuntimeServerErrorContext {
  sourceType: string;
  event: RuntimeBindingEvent;
  delivery: DeliveryTarget | undefined;
  error: unknown;
}

export interface RuntimeServerOptions {
  bundle: RuntimeBundle;
  runtime: PromptTrailApp;
  adapters: readonly RuntimeAdapter[];
  activity?: RuntimeActivity | false;
  observers?: readonly ObserverLike[];
  strictObservers?: boolean;
  observerDeliveryBindings?: ObserverDeliveryBindingOptions;
  errorMessage?:
    | string
    | ((ctx: RuntimeServerErrorContext) => string | undefined);
}

function namespaceRuntimeObserver(
  observer: ObserverLike,
  namespace: string,
): ObserverLike {
  const normalized = normalizeObserver(observer);
  if (normalized.name) {
    return normalized;
  }
  return { ...normalized, name: namespace };
}

export function server(options: RuntimeServerOptions): RuntimeServer {
  return new RuntimeServer(options);
}

export class RuntimeServer {
  private readonly deliveryTracker = new AssistantDeliveryTracker();
  private readonly observerBus: ObserverBus;
  private readonly runtimeObservers: ObserverLike[];
  private readonly runtimeObserverDisposers: Array<() => void> = [];
  private readonly conversationLocks = new Map<string, Promise<void>>();
  private readonly sources: RuntimeSourceDriver[] = [];
  private readonly deliveries = new Map<string, RuntimeDeliveryDriver>();
  private readonly activities = new Map<string, RuntimeActivityDriver>();
  private readonly eventSeqByConversation = new Map<string, number>();

  constructor(private readonly options: RuntimeServerOptions) {
    this.runtimeObservers = [
      ...(options.observers ?? []),
      ...options.adapters.flatMap((adapter) => adapter.observers ?? []),
    ].map((observer, index) =>
      namespaceRuntimeObserver(observer, `runtimeObserver:${index}`),
    );
    this.observerBus = new ObserverBus(this.runtimeObservers, {
      strictObservers: options.strictObservers,
      ...options.observerDeliveryBindings,
    });
    for (const adapter of options.adapters) {
      this.sources.push(...(adapter.sources ?? []));
      for (const delivery of adapter.deliveries ?? []) {
        this.deliveries.set(delivery.platform, delivery);
      }
      for (const activity of adapter.activities ?? []) {
        this.activities.set(activity.platform, activity);
      }
    }
  }

  async start(): Promise<void> {
    this.registerRuntimeObservers();
    await this.retryPendingDeliveries();
    for (const source of this.sources) {
      await source.start({
        emit: (event, emitOptions) =>
          this.dispatch(source.type, event, emitOptions),
      });
    }
  }

  async stop(): Promise<void> {
    for (const source of this.sources) {
      await source.stop?.();
    }
    this.unregisterRuntimeObservers();
  }

  async dispatch(
    sourceType: string,
    event: RuntimeBindingEvent,
    emitOptions: RuntimeSourceEmitOptions = {},
  ): Promise<void> {
    const binding = findRuntimeBinding(this.options.bundle, sourceType, event);
    if (!binding) {
      return;
    }

    const defaults = mergeBindingDefaults(
      this.options.bundle.defaults,
      binding.defaults,
    );
    if (
      event.source === 'discord' &&
      !passesDiscordBehavior(event, defaults.behavior)
    ) {
      return;
    }

    const delivery = resolveRuntimeDelivery(defaults.delivery, event);
    const conversationId = binding.conversation(event);
    await this.withConversationLock(conversationId, async () => {
      const activityHandle = await this.startActivity(event, delivery);

      try {
        const dispatched = await dispatchRuntimeBindingEvent({
          app: this.options.runtime,
          binding,
          event,
          defaults,
          content: emitOptions.content,
          attrs: emitOptions.attrs,
        });
        await this.deliverAssistantMessages(event, dispatched);
      } catch (error) {
        await this.deliverError(
          sourceType,
          conversationId,
          event,
          delivery,
          error,
        );
        if (
          this.options.strictObservers &&
          error instanceof ObserverFailureError
        ) {
          throw error;
        }
      } finally {
        await activityHandle?.stop();
      }
    });
  }

  private async withConversationLock<T>(
    conversationId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.conversationLocks.get(conversationId);
    let releaseCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const chain = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => current);
    this.conversationLocks.set(conversationId, chain);

    await previous?.catch(() => undefined);
    try {
      return await fn();
    } finally {
      releaseCurrent();
      if (this.conversationLocks.get(conversationId) === chain) {
        this.conversationLocks.delete(conversationId);
      }
    }
  }

  private registerRuntimeObservers(): void {
    if (this.runtimeObserverDisposers.length > 0) {
      return;
    }
    for (const [index, observer] of this.runtimeObservers.entries()) {
      this.runtimeObserverDisposers.push(
        this.options.runtime.registerRuntimeObserver(
          observer,
          this.options.observerDeliveryBindings,
          `runtimeObserver:${index}`,
        ),
      );
    }
  }

  private unregisterRuntimeObservers(): void {
    while (this.runtimeObserverDisposers.length > 0) {
      this.runtimeObserverDisposers.pop()?.();
    }
  }

  private async startActivity(
    event: RuntimeBindingEvent,
    delivery: DeliveryTarget | undefined,
  ): Promise<RuntimeActivityHandle | undefined> {
    if (!delivery || this.options.activity === false) {
      return undefined;
    }
    const driver = this.activities.get(delivery.platform);
    if (!driver) {
      return undefined;
    }
    const activityDelivery = cloneEventRawValue(delivery);
    return driver.start(
      { event, delivery: cloneEventRawValue(delivery) },
      activityDelivery,
      this.options.activity ?? { kind: 'processing' },
    );
  }

  private async deliverAssistantMessages(
    event: RuntimeBindingEvent,
    dispatched: RuntimeDispatchResult,
  ): Promise<void> {
    if (!dispatched.delivery) {
      return;
    }
    const driver = this.deliveries.get(dispatched.delivery.platform);
    if (!driver) {
      return;
    }
    const pending = this.deliveryTracker.pending(
      dispatched.conversationId,
      dispatched.result.session.messages as readonly Message<Attrs>[],
      dispatched.delivery,
    );
    const deliveryAttempts =
      await this.options.runtime.prepareAssistantDeliveries(
        dispatched.conversationId,
        pending,
      );
    for (const deliveryAttempt of deliveryAttempts) {
      let platformBinding: unknown;
      try {
        await this.emitDeliveryEvent('delivery.pending', {
          event,
          conversationId: dispatched.conversationId,
          delivery: dispatched.delivery,
          deliveryAttempt,
        });
        await this.options.runtime.markAssistantDelivery(
          dispatched.conversationId,
          deliveryAttempt.idempotencyKey,
          'delivering',
        );
        const driverDelivery = cloneEventRawValue(dispatched.delivery);
        platformBinding = await driver.deliver(
          {
            conversationId: dispatched.conversationId,
            idempotencyKey: deliveryAttempt.idempotencyKey,
            event,
            delivery: cloneEventRawValue(dispatched.delivery),
            platformBinding: cloneEventRawValue(
              deliveryAttempt.platformBinding,
            ),
          },
          driverDelivery,
          cloneEventRawValue(deliveryAttempt.message),
        );
      } catch (error) {
        await this.options.runtime.markAssistantDelivery(
          dispatched.conversationId,
          deliveryAttempt.idempotencyKey,
          'failed',
          error,
        );
        await this.emitDeliveryEvent('delivery.failed', {
          event,
          conversationId: dispatched.conversationId,
          delivery: dispatched.delivery,
          deliveryAttempt,
          error,
        });
        throw error;
      }
      await this.options.runtime.markAssistantDelivery(
        dispatched.conversationId,
        deliveryAttempt.idempotencyKey,
        'delivered',
        undefined,
        platformBinding,
      );
      this.deliveryTracker.markDelivered(deliveryAttempt);
      await this.emitDeliveryEvent('delivery.completed', {
        event,
        conversationId: dispatched.conversationId,
        delivery: dispatched.delivery,
        deliveryAttempt,
        platformBinding,
      });
    }
  }

  private async retryPendingDeliveries(): Promise<void> {
    for (const [runId, entries] of pendingDeliveriesByRun(
      await this.options.runtime.pendingAssistantDeliveryOutbox(),
    )) {
      for (const entry of entries) {
        const completed = await this.retryOutboxEntry(runId, entry);
        if (!completed) {
          break;
        }
      }
    }
  }

  private async retryOutboxEntry(
    runId: string,
    entry: {
      idempotencyKey: string;
      assistantIndex: number;
      message: Message;
      target?: unknown;
      platformBinding?: unknown;
    },
  ): Promise<boolean> {
    if (!isRuntimeDeliveryTarget(entry.target)) {
      return false;
    }
    const driver = this.deliveries.get(entry.target.platform);
    if (!driver) {
      return false;
    }
    const event = retryDeliveryEvent(runId);
    let platformBinding: unknown;
    try {
      await this.emitDeliveryEvent('delivery.pending', {
        event,
        conversationId: runId,
        delivery: entry.target,
        deliveryAttempt: entry,
      });
      await this.options.runtime.markAssistantDelivery(
        runId,
        entry.idempotencyKey,
        'delivering',
      );
      const driverDelivery = cloneEventRawValue(entry.target);
      platformBinding = await driver.deliver(
        {
          conversationId: runId,
          idempotencyKey: entry.idempotencyKey,
          event,
          delivery: cloneEventRawValue(entry.target),
          platformBinding: cloneEventRawValue(entry.platformBinding),
        },
        driverDelivery,
        cloneEventRawValue(entry.message),
      );
    } catch (error) {
      await this.options.runtime.markAssistantDelivery(
        runId,
        entry.idempotencyKey,
        'failed',
        error,
      );
      await this.emitDeliveryEvent('delivery.failed', {
        event,
        conversationId: runId,
        delivery: entry.target,
        deliveryAttempt: entry,
        error,
      });
      return false;
    }
    await this.options.runtime.markAssistantDelivery(
      runId,
      entry.idempotencyKey,
      'delivered',
      undefined,
      platformBinding,
    );
    this.deliveryTracker.markDelivered(entry);
    await this.emitDeliveryEvent('delivery.completed', {
      event,
      conversationId: runId,
      delivery: entry.target,
      deliveryAttempt: entry,
      platformBinding,
    });
    return true;
  }

  private async emitDeliveryEvent(
    type: 'delivery.pending' | 'delivery.completed' | 'delivery.failed',
    options: {
      event: RuntimeBindingEvent;
      conversationId: string;
      delivery: DeliveryTarget;
      deliveryAttempt: {
        idempotencyKey: string;
        assistantIndex: number;
        messageRef?: {
          conversationId: string;
          assistantIndex: number;
        };
        platformBinding?: unknown;
        status?: string;
      };
      platformBinding?: unknown;
      error?: unknown;
    },
  ): Promise<void> {
    const seq = this.nextDeliveryEventSeq(options.conversationId);
    const sourcePlatformBinding =
      options.platformBinding ?? options.deliveryAttempt.platformBinding;
    const messageRef = options.deliveryAttempt.messageRef
      ? { ...options.deliveryAttempt.messageRef }
      : undefined;
    const delivery = cloneEventRawValue(options.delivery);
    const platformBinding = cloneEventRawValue(sourcePlatformBinding);
    const event: ExecutionEvent = {
      id: `${type}:${options.deliveryAttempt.idempotencyKey}`,
      type,
      at: new Date().toISOString(),
      seq,
      conversationId: options.conversationId,
      runId: options.conversationId,
      idempotencyKey: options.deliveryAttempt.idempotencyKey,
      source: 'runtime',
      raw: {
        sourceEvent: options.event,
        delivery: cloneEventRawValue(options.delivery),
        deliveryAttempt: {
          idempotencyKey: options.deliveryAttempt.idempotencyKey,
          assistantIndex: options.deliveryAttempt.assistantIndex,
          messageRef: messageRef ? { ...messageRef } : undefined,
          platformBinding: cloneEventRawValue(sourcePlatformBinding),
          status: options.deliveryAttempt.status,
        },
        messageRef: messageRef ? { ...messageRef } : undefined,
        platformBinding,
        assistantIndex: options.deliveryAttempt.assistantIndex,
        error: options.error,
      },
      error: options.error,
    };
    try {
      await this.observerBus.emit(event, {
        delivery,
        runtimeEvent: options.event,
      });
      await this.options.runtime.emitRuntimeDeliveryEvent(event, {
        delivery,
        runtimeEvent: options.event,
      });
    } catch (error) {
      if (this.options.strictObservers) {
        throw error;
      }
      // Delivery observers are presentation side effects; final delivery state
      // is owned by the outbox and must not be rolled back by observer failure.
    }
  }

  private nextDeliveryEventSeq(conversationId: string): number {
    const seq = this.eventSeqByConversation.get(conversationId) ?? 0;
    this.eventSeqByConversation.set(conversationId, seq + 1);
    return seq;
  }

  private async deliverError(
    sourceType: string,
    conversationId: string,
    event: RuntimeBindingEvent,
    delivery: DeliveryTarget | undefined,
    error: unknown,
  ): Promise<void> {
    const message = this.resolveErrorMessage({
      sourceType,
      event,
      delivery,
      error,
    });
    if (!message || !delivery) {
      throw error;
    }
    const driver = this.deliveries.get(delivery.platform);
    if (!driver) {
      throw error;
    }
    const driverDelivery = cloneEventRawValue(delivery);
    await driver.deliver(
      {
        conversationId,
        idempotencyKey: runtimeErrorDeliveryKey(
          sourceType,
          conversationId,
          event,
        ),
        event,
        delivery: cloneEventRawValue(delivery),
      },
      driverDelivery,
      { type: 'assistant', content: message },
    );
  }

  private resolveErrorMessage(
    ctx: RuntimeServerErrorContext,
  ): string | undefined {
    const errorMessage = this.options.errorMessage;
    if (typeof errorMessage === 'function') {
      return errorMessage(ctx);
    }
    return errorMessage;
  }
}

function cloneEventRawValue<T>(value: T): T {
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

function isRuntimeDeliveryTarget(value: unknown): value is DeliveryTarget {
  return (
    !!value &&
    typeof value === 'object' &&
    'platform' in value &&
    typeof (value as { platform?: unknown }).platform === 'string'
  );
}

function pendingDeliveriesByRun(
  entries: readonly PendingAssistantDeliveryOutboxEntry[],
): Array<[string, PendingAssistantDeliveryOutboxEntry['entry'][]]> {
  const grouped = new Map<
    string,
    PendingAssistantDeliveryOutboxEntry['entry'][]
  >();
  for (const { runId, entry } of entries) {
    const existing = grouped.get(runId);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(runId, [entry]);
    }
  }
  for (const runEntries of grouped.values()) {
    runEntries.sort(
      (left, right) =>
        left.assistantIndex - right.assistantIndex ||
        left.idempotencyKey.localeCompare(right.idempotencyKey),
    );
  }
  return [...grouped.entries()];
}

function retryDeliveryEvent(runId: string): RuntimeBindingEvent {
  // Startup retries do not have the original source event in memory. Delivery
  // drivers must use the persisted delivery target for routing on this path.
  return {
    source: 'cron',
    job: {
      id: 'runtime-outbox-retry',
      name: `Runtime outbox retry for ${runId}`,
      schedule: '',
    },
  };
}

function runtimeErrorDeliveryKey(
  sourceType: string,
  conversationId: string,
  event: RuntimeBindingEvent,
): string {
  return `runtime-error:${fnv1a(
    stableStringify({
      sourceType,
      conversationId,
      event,
    }),
  )}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
