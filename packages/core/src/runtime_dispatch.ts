import type { DurableRunResult, PromptTrailApp } from './durable';
import type { Message } from './message';
import type { Attrs, Vars } from './session';
import type {
  BindingDefaults,
  DeliveryTarget,
  RuntimeBinding,
  TriggerEvent,
  RuntimeBundle,
} from './runtime_bindings';
import { assistantDeliveryKey } from './runtime_delivery_keys';

export { assistantDeliveryKey };

export interface RuntimeDispatchContext extends Record<string, unknown> {
  conversationId: string;
  delivery?: DeliveryTarget;
  toolsets?: readonly string[];
  skills?: readonly string[];
  workdir?: string;
  historyBackfill?: unknown;
  channelPrompt?: string;
}

export interface RuntimeDispatchOptions<TEvent extends TriggerEvent> {
  app: PromptTrailApp;
  binding: RuntimeBinding<TEvent>;
  event: TEvent;
  defaults: BindingDefaults;
  content?: string;
  attrs?: Record<string, unknown>;
  checkpoint?: BindingDefaults['checkpoint'];
  resumable?: boolean;
}

export interface RuntimeDispatchResult<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  conversationId: string;
  delivery: DeliveryTarget | undefined;
  context: RuntimeDispatchContext;
  content: string;
  result: DurableRunResult<TVars, TAttrs>;
}

export interface PendingAssistantDelivery<TAttrs extends Attrs = Attrs> {
  message: Message<TAttrs> & { type: 'assistant' };
  assistantIndex: number;
  idempotencyKey: string;
  target?: DeliveryTarget;
}

export function findRuntimeBinding<TEvent extends TriggerEvent>(
  bundle: RuntimeBundle,
  triggerType: string,
  event: TEvent,
): RuntimeBinding<TEvent> | undefined {
  return bundle.bindings.find(
    (binding) =>
      binding.trigger.type === triggerType &&
      binding.filters.every((filter) =>
        (filter as (candidate: TEvent) => boolean)(event),
      ),
  ) as RuntimeBinding<TEvent> | undefined;
}

export function mergeBindingDefaults(
  base: BindingDefaults,
  override: BindingDefaults,
): BindingDefaults {
  return {
    ...base,
    ...override,
    context: { ...(base.context ?? {}), ...(override.context ?? {}) },
    behavior: { ...(base.behavior ?? {}), ...(override.behavior ?? {}) },
  };
}

export function resolveRuntimeInput<TEvent extends TriggerEvent>(
  binding: RuntimeBinding<TEvent>,
  event: TEvent,
): string {
  if (typeof binding.input === 'function') {
    return binding.input(event as TEvent & Record<string, unknown>);
  }
  if (typeof binding.input === 'string') {
    return binding.input;
  }
  if (typeof event.content === 'string') {
    return event.content;
  }
  return binding.trigger.defaultInput?.(event) ?? '';
}

export function resolveRuntimeBindingContext<TEvent extends TriggerEvent>(
  binding: RuntimeBinding<TEvent>,
  event: TEvent,
): Record<string, unknown> | undefined {
  if (!binding.context) {
    return undefined;
  }
  return typeof binding.context === 'function'
    ? binding.context(event as TEvent & Record<string, unknown>)
    : binding.context;
}

export function resolveRuntimeDelivery(
  delivery: DeliveryTarget | undefined,
  binding: RuntimeBinding<TriggerEvent>,
  event: TriggerEvent,
): DeliveryTarget | undefined {
  if (!delivery) {
    return undefined;
  }
  if (binding.trigger.resolveDelivery) {
    return binding.trigger.resolveDelivery(delivery, event);
  }
  return delivery;
}

export function runtimeContextFromDefaults(
  conversationId: string,
  defaults: BindingDefaults,
  delivery: DeliveryTarget | undefined,
  _event: TriggerEvent,
): RuntimeDispatchContext {
  return {
    ...(defaults.context ?? {}),
    conversationId,
    delivery,
    toolsets: defaults.toolsets,
    skills: defaults.skills,
    workdir: defaults.workdir,
    historyBackfill: defaults.context?.historyBackfill,
  };
}

export async function dispatchRuntimeEvent<
  TEvent extends TriggerEvent,
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
>(
  options: RuntimeDispatchOptions<TEvent>,
): Promise<RuntimeDispatchResult<TVars, TAttrs>> {
  const conversationId = options.binding.conversation(options.event);
  const bindingContext = resolveRuntimeBindingContext(
    options.binding,
    options.event,
  );
  const defaults = bindingContext
    ? mergeBindingDefaults(options.defaults, { context: bindingContext })
    : options.defaults;
  const resolvedDelivery = resolveRuntimeDelivery(
    defaults.delivery,
    options.binding as RuntimeBinding<TriggerEvent>,
    options.event,
  );
  const contextDelivery = cloneRuntimeDispatchValue(resolvedDelivery);
  const delivery = cloneRuntimeDispatchValue(resolvedDelivery);
  const context = runtimeContextFromDefaults(
    conversationId,
    defaults,
    contextDelivery,
    options.event,
  );
  const triggerContext = options.binding.trigger.resolveContext?.({
    conversationId,
    defaults,
    delivery: contextDelivery,
    event: options.event,
  });
  if (triggerContext) {
    Object.assign(context, triggerContext);
  }
  const content =
    options.content ?? resolveRuntimeInput(options.binding, options.event);
  const result = await options.app.send<TVars, TAttrs>({
    agent: options.binding.agent,
    runId: conversationId,
    input: {
      kind: 'user',
      content,
      attrs: {
        source: options.event.source,
        ...runtimeEventAttrs(options.event),
        ...(options.binding.trigger.eventAttrs?.(options.event) ?? {}),
        ...(options.attrs ?? {}),
        runtimeContext: context,
      },
    },
    checkpoint: options.checkpoint ?? defaults.checkpoint ?? true,
    resumable: options.resumable,
    context,
  });

  return {
    conversationId,
    delivery,
    context,
    content,
    result,
  };
}

function cloneRuntimeDispatchValue<T>(value: T): T {
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

export function runtimeEventAttrs(
  _event: TriggerEvent,
): Record<string, unknown> {
  return {};
}

export class AssistantDeliveryTracker {
  private readonly deliveredKeys = new Set<string>();

  pending<TAttrs extends Attrs = Attrs>(
    conversationId: string,
    messages: readonly Message<TAttrs>[],
    target?: DeliveryTarget,
  ): PendingAssistantDelivery<TAttrs>[] {
    return messages
      .filter(
        (message): message is Message<TAttrs> & { type: 'assistant' } =>
          message.type === 'assistant',
      )
      .map((message, index) => ({
        message,
        assistantIndex: index,
        idempotencyKey: assistantDeliveryKey(conversationId, index, target),
        target,
      }))
      .filter((delivery) => !this.deliveredKeys.has(delivery.idempotencyKey));
  }

  markDelivered(
    delivery: Pick<PendingAssistantDelivery, 'idempotencyKey'>,
  ): void {
    this.deliveredKeys.add(delivery.idempotencyKey);
  }

  has(idempotencyKey: string): boolean {
    return this.deliveredKeys.has(idempotencyKey);
  }
}
