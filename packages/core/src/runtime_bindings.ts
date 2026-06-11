import type { PromptTrailRegisteredAgent, RunStore } from './durable';

export interface TriggerEvent {
  source: string;
  [key: string]: unknown;
}

export type RuntimeFilter<TEvent extends TriggerEvent> = (
  event: TEvent,
) => boolean;

export type ConversationResolver<TEvent extends TriggerEvent> = (
  event: TEvent,
) => string;

export type InputResolver<TEvent extends TriggerEvent> =
  | string
  | ((event: TEvent & Record<string, unknown>) => string);

export type RuntimeContextResolver<TEvent extends TriggerEvent> =
  | Record<string, unknown>
  | ((event: TEvent & Record<string, unknown>) => Record<string, unknown>);

export interface OriginDeliveryTarget {
  platform: 'origin';
}

export interface DeliveryTarget {
  platform: string;
  [key: string]: unknown;
}

export type RuntimeDeliveryTarget = DeliveryTarget | OriginDeliveryTarget;

export interface BindingDefaults {
  checkpoint?: true | RunStore | { store?: RunStore };
  delivery?: DeliveryTarget;
  toolsets?: readonly string[];
  skills?: readonly string[];
  workdir?: string;
  context?: Record<string, unknown>;
  behavior?: unknown;
}

export interface Trigger<TEvent extends TriggerEvent = TriggerEvent> {
  type: string;
  defaultInput?: (event: TEvent) => string | undefined;
  eventAttrs?: (event: TEvent) => Record<string, unknown> | undefined;
  resolveDelivery?: (
    delivery: DeliveryTarget,
    event: TEvent,
  ) => DeliveryTarget | undefined;
  resolveContext?: (options: {
    conversationId: string;
    defaults: BindingDefaults;
    delivery: DeliveryTarget | undefined;
    event: TEvent;
  }) => Record<string, unknown> | undefined;
  shouldDispatch?: (event: TEvent, defaults: BindingDefaults) => boolean;
}

export interface RuntimeBinding<TEvent extends TriggerEvent> {
  trigger: Trigger<TEvent>;
  filters: RuntimeFilter<TEvent>[];
  agent: string;
  conversation: ConversationResolver<TEvent>;
  input?: InputResolver<TEvent>;
  context?: RuntimeContextResolver<TEvent>;
  defaults: BindingDefaults;
  name?: string;
}

export type RuntimeBindingLike<TEvent extends TriggerEvent> =
  | RuntimeBinding<TEvent>
  | BindingBuilder<TEvent>;

export type RuntimeAgentRef = string | PromptTrailRegisteredAgent;

export interface RuntimeBundle {
  name: string;
  agents: Record<string, PromptTrailRegisteredAgent<any, any>>;
  defaults: BindingDefaults;
  bindings: RuntimeBinding<TriggerEvent>[];
}

export interface RuntimeBundleOptions {
  name: string;
  agents?: Record<string, PromptTrailRegisteredAgent<any, any>>;
  defaults?: BindingDefaults;
  bindings?: RuntimeBindingLike<any>[];
}

export class BindingBuilder<TEvent extends TriggerEvent> {
  private filters: RuntimeFilter<TEvent>[] = [];
  private agentName?: string;
  private agentRef?: RuntimeAgentRef;
  private conversationResolver?: ConversationResolver<TEvent>;
  private inputResolver?: InputResolver<TEvent>;
  private contextResolver?: RuntimeContextResolver<TEvent>;
  private bindingDefaults: BindingDefaults = {};
  private bindingName?: string;

  constructor(private readonly trigger: Trigger<TEvent>) {}

  where(filter: RuntimeFilter<TEvent>): this {
    this.filters.push(filter);
    return this;
  }

  to(agent: RuntimeAgentRef): this {
    this.agentName = resolveRuntimeAgentName(agent);
    this.agentRef = agent;
    return this;
  }

  toAgent(agent: RuntimeAgentRef): this {
    return this.to(agent);
  }

  conversation(resolver: ConversationResolver<TEvent>): this {
    this.conversationResolver = resolver;
    return this;
  }

  input(input: InputResolver<TEvent>): this {
    this.inputResolver = input;
    return this;
  }

  reply(delivery: DeliveryTarget): this {
    return this.defaults({ delivery });
  }

  checkpoint(checkpoint: BindingDefaults['checkpoint'] = true): this {
    return this.defaults({ checkpoint });
  }

  toolsets(toolsets: readonly string[]): this {
    return this.defaults({ toolsets });
  }

  skills(skills: readonly string[]): this {
    return this.defaults({ skills });
  }

  workdir(workdir: string): this {
    return this.defaults({ workdir });
  }

  /**
   * Shallow-merge platform behavior defaults. Nested arrays are replaced by
   * later calls, not concatenated.
   */
  behavior(behavior: Record<string, unknown>): this {
    const previous =
      this.bindingDefaults.behavior &&
      typeof this.bindingDefaults.behavior === 'object'
        ? this.bindingDefaults.behavior
        : {};
    this.bindingDefaults = {
      ...this.bindingDefaults,
      behavior: {
        ...previous,
        ...behavior,
      },
    };
    return this;
  }

  context(context: RuntimeContextResolver<TEvent>): this {
    this.contextResolver = context;
    return this;
  }

  defaults(defaults: BindingDefaults): this {
    this.bindingDefaults = { ...this.bindingDefaults, ...defaults };
    return this;
  }

  name(name: string): this {
    this.bindingName = name;
    return this;
  }

  agentRegistration():
    | { name: string; agent: PromptTrailRegisteredAgent }
    | undefined {
    const agentRef = this.agentRef;
    if (!this.agentName || !agentRef || typeof agentRef === 'string') {
      return undefined;
    }
    return { name: this.agentName, agent: agentRef };
  }

  build(): RuntimeBinding<TEvent> {
    if (!this.agentName) {
      throw new Error('Runtime binding is missing .toAgent(...)');
    }
    if (!this.conversationResolver) {
      throw new Error('Runtime binding is missing .conversation(...)');
    }
    return {
      trigger: this.trigger,
      filters: [...this.filters],
      agent: this.agentName,
      conversation: this.conversationResolver,
      input: this.inputResolver,
      context: this.contextResolver,
      defaults: { ...this.bindingDefaults },
      name: this.bindingName,
    };
  }
}

export function on<TEvent extends TriggerEvent>(
  trigger: Trigger<TEvent>,
): BindingBuilder<TEvent> {
  return new BindingBuilder(trigger);
}

function resolveRuntimeAgentName(agentRef: RuntimeAgentRef): string {
  if (typeof agentRef === 'string') {
    return agentRef;
  }
  if (hasRuntimeAgentName(agentRef)) {
    return agentRef.name;
  }
  throw new Error('Runtime binding agent must be an agent name or Agent.');
}

function hasRuntimeAgentName(value: unknown): value is { name: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

export const Delivery = {
  origin(): OriginDeliveryTarget {
    return { platform: 'origin' };
  },

  replyToOrigin(): OriginDeliveryTarget {
    return { platform: 'origin' };
  },
};

export function runtimeBundle(options: RuntimeBundleOptions): RuntimeBundle {
  const agents = { ...(options.agents ?? {}) };
  const bindings = (options.bindings ?? []).map((bindingLike) => {
    if (!isBindingBuilder(bindingLike)) {
      return bindingLike;
    }
    const registration = bindingLike.agentRegistration();
    if (registration && !agents[registration.name]) {
      agents[registration.name] = registration.agent;
    }
    return bindingLike.build();
  });

  return {
    name: options.name,
    agents,
    defaults: options.defaults ?? {},
    bindings,
  };
}

function isBindingBuilder<TEvent extends TriggerEvent>(
  bindingLike: RuntimeBindingLike<TEvent>,
): bindingLike is BindingBuilder<TEvent> {
  return typeof (bindingLike as { build?: unknown }).build === 'function';
}
