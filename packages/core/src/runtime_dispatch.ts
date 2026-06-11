import type { DurableRunResult, PromptTrailApp } from './durable';
import type { Message } from './message';
import type { Attrs, Vars } from './session';
import type {
  BindingDefaults,
  ConcreteDiscordDeliveryTarget,
  CronEvent,
  DeliveryTarget,
  DiscordMessageEvent,
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
  if (isCronEvent(event)) {
    return event.job.name;
  }
  return '';
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
  event: TriggerEvent,
): DeliveryTarget | undefined {
  if (!delivery) {
    return undefined;
  }
  if (delivery.platform === 'origin') {
    if (isCronEvent(event)) {
      return event.job.origin;
    }
    return isDiscordMessageEvent(event) ? discordOrigin(event) : undefined;
  }
  if (delivery.platform === 'discord' && 'kind' in delivery) {
    return isDiscordMessageEvent(event) ? discordOrigin(event) : undefined;
  }
  return delivery;
}

export function runtimeContextFromDefaults(
  conversationId: string,
  defaults: BindingDefaults,
  delivery: DeliveryTarget | undefined,
  event: TriggerEvent,
): RuntimeDispatchContext {
  const channelPrompt = resolveChannelPrompt(defaults, event);
  const skills = resolveChannelSkills(defaults, event);
  return {
    ...(defaults.context ?? {}),
    conversationId,
    delivery,
    toolsets: defaults.toolsets,
    skills,
    workdir: defaults.workdir,
    historyBackfill: defaults.context?.historyBackfill,
    channelPrompt,
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

export function passesDiscordBehavior(
  event: DiscordMessageEvent,
  behavior: BindingDefaults['behavior'],
): boolean {
  if (!behavior) {
    return true;
  }
  if (
    behavior.allowedChannels &&
    !behavior.allowedChannels.some((channel) =>
      matchesDiscordChannel(event, channel),
    )
  ) {
    return false;
  }
  if (event.thread) {
    const threadCanRespond =
      behavior.threadResponseChannels?.some((channel) =>
        matchesDiscordChannel(event, channel),
      ) ?? true;
    if (threadCanRespond && behavior.threadRequireMention === false) {
      return true;
    }
  }
  if (
    behavior.freeResponseChannels?.some((channel) =>
      matchesDiscordChannel(event, channel),
    )
  ) {
    return true;
  }
  if (behavior.requireMention === false) {
    return true;
  }
  return event.mentionsBot === true;
}

export function matchesDiscordChannel(
  event: DiscordMessageEvent,
  channel: string,
): boolean {
  return event.channel === channel || event.channelId === channel;
}

export function isConcreteDiscordDeliveryTarget(
  delivery: DeliveryTarget | undefined,
): delivery is ConcreteDiscordDeliveryTarget {
  return (
    delivery?.platform === 'discord' &&
    'channel' in delivery &&
    !('kind' in delivery)
  );
}

export function runtimeEventAttrs(
  event: TriggerEvent,
): Record<string, unknown> {
  if (isDiscordMessageEvent(event)) {
    return {
      author: event.author,
      authorId: event.authorId,
      channel: event.channel,
      channelId: event.channelId,
      thread: event.thread,
    };
  }
  if (isCronEvent(event)) {
    return {
      job: event.job.name,
      jobId: event.job.id,
    };
  }
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

function discordOrigin(
  event: DiscordMessageEvent,
): ConcreteDiscordDeliveryTarget {
  return {
    platform: 'discord',
    channel: event.channel,
    thread: event.thread,
  };
}

function resolveChannelPrompt(
  defaults: BindingDefaults,
  event: TriggerEvent,
): string | undefined {
  if (!isDiscordMessageEvent(event)) {
    return undefined;
  }
  const prompts = defaults.context?.channelPrompts as
    | Record<string, string>
    | undefined;
  if (!prompts) {
    return undefined;
  }
  return (
    (event.thread ? prompts[event.thread] : undefined) ??
    prompts[event.channel] ??
    prompts[event.channelId]
  );
}

function resolveChannelSkills(
  defaults: BindingDefaults,
  event: TriggerEvent,
): readonly string[] | undefined {
  if (!isDiscordMessageEvent(event)) {
    return defaults.skills;
  }
  const bindings = defaults.context?.channelSkillBindings as
    | Array<{ channel: string; skills: readonly string[] }>
    | undefined;
  if (!bindings) {
    return defaults.skills;
  }
  const exactThread = event.thread
    ? bindings.find((binding) => binding.channel === event.thread)
    : undefined;
  const parent = bindings.find(
    (binding) =>
      binding.channel === event.channel || binding.channel === event.channelId,
  );
  return exactThread?.skills ?? parent?.skills ?? defaults.skills;
}

export function isDiscordMessageEvent(
  event: TriggerEvent,
): event is DiscordMessageEvent {
  return (
    event.source === 'discord' &&
    typeof event.channel === 'string' &&
    typeof event.channelId === 'string'
  );
}

export function isCronEvent(event: TriggerEvent): event is CronEvent {
  const job = event.job as { id?: unknown; name?: unknown } | undefined;
  return (
    event.source === 'cron' &&
    typeof job === 'object' &&
    job !== null &&
    typeof job.id === 'string' &&
    typeof job.name === 'string'
  );
}
