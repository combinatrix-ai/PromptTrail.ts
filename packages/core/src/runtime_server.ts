import type {
  PendingAssistantDeliveryOutboxEntry,
  PromptTrailApp,
} from './durable';
import {
  ObserverBus,
  type ExecutionEvent,
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
}

export interface RuntimeDeliveryDriver<
  TTarget extends DeliveryTarget = DeliveryTarget,
> {
  platform: string;
  deliver(
    ctx: RuntimeDeliveryContext,
    target: TTarget,
    message: Message,
  ): Promise<void> | void;
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
  errorMessage?:
    | string
    | ((ctx: RuntimeServerErrorContext) => string | undefined);
}

export function server(options: RuntimeServerOptions): RuntimeServer {
  return new RuntimeServer(options);
}

export class RuntimeServer {
  private readonly deliveryTracker = new AssistantDeliveryTracker();
  private readonly observerBus: ObserverBus;
  private readonly sources: RuntimeSourceDriver[] = [];
  private readonly deliveries = new Map<string, RuntimeDeliveryDriver>();
  private readonly activities = new Map<string, RuntimeActivityDriver>();
  private eventSeq = 0;

  constructor(private readonly options: RuntimeServerOptions) {
    this.observerBus = new ObserverBus(options.observers ?? []);
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
      await this.deliverError(sourceType, event, delivery, error);
    } finally {
      await activityHandle?.stop();
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
    return driver.start(
      { event, delivery },
      delivery,
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
    const deliveryAttempts = this.options.runtime.prepareAssistantDeliveries(
      dispatched.conversationId,
      pending,
    );
    for (const deliveryAttempt of deliveryAttempts) {
      try {
        await this.emitDeliveryEvent('delivery.pending', {
          event,
          conversationId: dispatched.conversationId,
          delivery: dispatched.delivery,
          deliveryAttempt,
        });
        await driver.deliver(
          {
            conversationId: dispatched.conversationId,
            idempotencyKey: deliveryAttempt.idempotencyKey,
            event,
            delivery: dispatched.delivery,
          },
          dispatched.delivery,
          deliveryAttempt.message,
        );
        this.options.runtime.markAssistantDelivery(
          dispatched.conversationId,
          deliveryAttempt.idempotencyKey,
          'completed',
        );
        this.deliveryTracker.markDelivered(deliveryAttempt);
        await this.emitDeliveryEvent('delivery.completed', {
          event,
          conversationId: dispatched.conversationId,
          delivery: dispatched.delivery,
          deliveryAttempt,
        });
      } catch (error) {
        this.options.runtime.markAssistantDelivery(
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
    }
  }

  private async retryPendingDeliveries(): Promise<void> {
    for (const [runId, entries] of pendingDeliveriesByRun(
      this.options.runtime.pendingAssistantDeliveryOutbox(),
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
    try {
      await this.emitDeliveryEvent('delivery.pending', {
        event,
        conversationId: runId,
        delivery: entry.target,
        deliveryAttempt: entry,
      });
      await driver.deliver(
        {
          conversationId: runId,
          idempotencyKey: entry.idempotencyKey,
          event,
          delivery: entry.target,
        },
        entry.target,
        entry.message,
      );
      this.options.runtime.markAssistantDelivery(
        runId,
        entry.idempotencyKey,
        'completed',
      );
      this.deliveryTracker.markDelivered(entry);
      await this.emitDeliveryEvent('delivery.completed', {
        event,
        conversationId: runId,
        delivery: entry.target,
        deliveryAttempt: entry,
      });
      return true;
    } catch (error) {
      this.options.runtime.markAssistantDelivery(
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
        status?: string;
      };
      error?: unknown;
    },
  ): Promise<void> {
    const seq = this.eventSeq++;
    const event: ExecutionEvent = {
      id: `${type}:${options.deliveryAttempt.idempotencyKey}`,
      type,
      at: new Date().toISOString(),
      seq,
      conversationId: options.conversationId,
      runId: options.conversationId,
      replay: 'live',
      idempotencyKey: options.deliveryAttempt.idempotencyKey,
      source: 'runtime',
      raw: {
        sourceEvent: options.event,
        delivery: options.delivery,
        assistantIndex: options.deliveryAttempt.assistantIndex,
        error: options.error,
      },
      error: options.error,
    };
    try {
      await this.observerBus.emit(event, {
        delivery: options.delivery,
        runtimeEvent: options.event,
      });
    } catch {
      // Delivery observers are presentation side effects; final delivery state
      // is owned by the outbox and must not be rolled back by observer failure.
    }
  }

  private async deliverError(
    sourceType: string,
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
    await driver.deliver(
      {
        conversationId: 'runtime-error',
        idempotencyKey: `runtime-error:${Date.now()}`,
        event,
        delivery,
      },
      delivery,
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
