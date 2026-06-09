import type { PromptTrailRegisteredAgent } from './durable';

export interface DiscordMessageEvent {
  source: 'discord';
  guild: string;
  channel: string;
  channelId: string;
  thread?: string;
  author: string;
  authorId: string;
  authorBot: boolean;
  content: string;
  mentionsBot?: boolean;
  isDM?: boolean;
}

export interface CronEvent {
  source: 'cron';
  job: {
    id: string;
    name: string;
    schedule: string;
    origin?: DeliveryTarget;
  };
  payload?: Record<string, unknown>;
}

export type RuntimeBindingEvent = DiscordMessageEvent | CronEvent;

export type RuntimeFilter<TEvent extends RuntimeBindingEvent> = (
  event: TEvent,
) => boolean;

export type ConversationResolver<TEvent extends RuntimeBindingEvent> = (
  event: TEvent,
) => string;

export type InputResolver<TEvent extends RuntimeBindingEvent> =
  | string
  | ((event: TEvent & Record<string, unknown>) => string);

export type RuntimeContextResolver<TEvent extends RuntimeBindingEvent> =
  | Record<string, unknown>
  | ((event: TEvent & Record<string, unknown>) => Record<string, unknown>);

export interface OriginDeliveryTarget {
  platform: 'origin';
}

export interface DiscordOriginThreadDeliveryTarget {
  platform: 'discord';
  kind: 'originThread';
}

export interface DiscordChannelDeliveryTarget {
  platform: 'discord';
  channel: string;
}

export interface ConcreteDiscordDeliveryTarget {
  platform: 'discord';
  channel: string;
  thread?: string;
}

export type DeliveryTarget =
  | OriginDeliveryTarget
  | DiscordOriginThreadDeliveryTarget
  | DiscordChannelDeliveryTarget
  | ConcreteDiscordDeliveryTarget;

export interface BindingDefaults {
  durable?: boolean;
  delivery?: DeliveryTarget;
  toolsets?: readonly string[];
  skills?: readonly string[];
  workdir?: string;
  context?: Record<string, unknown>;
  behavior?: DiscordBindingBehavior;
}

export interface DiscordBindingBehavior {
  allowedChannels?: readonly string[];
  freeResponseChannels?: readonly string[];
  threadResponseChannels?: readonly string[];
  requireMention?: boolean;
  autoThread?: boolean;
  threadRequireMention?: boolean;
  reactions?: boolean;
  allowAnyAttachment?: boolean;
  maxAttachmentBytes?: number;
}

export interface RuntimeSource<_TEvent extends RuntimeBindingEvent> {
  type: string;
  schedule?: string;
}

export interface RuntimeBinding<TEvent extends RuntimeBindingEvent> {
  source: RuntimeSource<TEvent>;
  filters: RuntimeFilter<TEvent>[];
  agent: string;
  conversation: ConversationResolver<TEvent>;
  input?: InputResolver<TEvent>;
  context?: RuntimeContextResolver<TEvent>;
  defaults: BindingDefaults;
  name?: string;
}

export type RuntimeBindingLike<TEvent extends RuntimeBindingEvent> =
  | RuntimeBinding<TEvent>
  | BindingBuilder<TEvent>;

export type RuntimeAgentRef = string | PromptTrailRegisteredAgent;

export interface RuntimeBundle {
  name: string;
  agents: Record<string, PromptTrailRegisteredAgent<any, any>>;
  defaults: BindingDefaults;
  bindings: RuntimeBinding<RuntimeBindingEvent>[];
}

export interface RuntimeBundleOptions {
  name: string;
  agents?: Record<string, PromptTrailRegisteredAgent<any, any>>;
  defaults?: BindingDefaults;
  bindings?: RuntimeBindingLike<any>[];
}

export class BindingBuilder<TEvent extends RuntimeBindingEvent> {
  private filters: RuntimeFilter<TEvent>[] = [];
  private agentName?: string;
  private agentRef?: RuntimeAgentRef;
  private conversationResolver?: ConversationResolver<TEvent>;
  private inputResolver?: InputResolver<TEvent>;
  private contextResolver?: RuntimeContextResolver<TEvent>;
  private bindingDefaults: BindingDefaults = {};
  private bindingName?: string;

  constructor(private readonly source: RuntimeSource<TEvent>) {}

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

  delivery(delivery: DeliveryTarget): this {
    return this.defaults({ delivery });
  }

  durable(durable = true): this {
    return this.defaults({ durable });
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
   * Shallow-merge Discord behavior defaults. Nested arrays such as
   * allowedChannels are replaced by later calls, not concatenated.
   */
  behavior(behavior: DiscordBindingBehavior): this {
    this.bindingDefaults = {
      ...this.bindingDefaults,
      behavior: {
        ...(this.bindingDefaults.behavior ?? {}),
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
      source: this.source,
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

export function bind<TEvent extends RuntimeBindingEvent>(
  source: RuntimeSource<TEvent>,
): BindingBuilder<TEvent> {
  return new BindingBuilder(source);
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

function channelMatches(
  eventChannel: string,
  eventChannelId: string,
  id: string,
) {
  return eventChannel === id || eventChannelId === id;
}

export const discord = {
  messages(): RuntimeSource<DiscordMessageEvent> {
    return { type: 'discord.messages' };
  },

  notBot(): RuntimeFilter<DiscordMessageEvent> {
    return (event) => !event.authorBot;
  },

  inChannels(channels: readonly string[]): RuntimeFilter<DiscordMessageEvent> {
    return (event) =>
      channels.some((channel) =>
        channelMatches(event.channel, event.channelId, channel),
      );
  },

  sessionKey(options: {
    groupSessionsPerUser?: boolean;
    threadSessionsPerUser?: boolean;
  }): ConversationResolver<DiscordMessageEvent> {
    return (event) => {
      if (event.isDM) {
        return `discord:dm:${event.authorId}`;
      }
      if (event.thread) {
        const base = `discord:guild:${event.guild}:thread:${event.thread}`;
        return options.threadSessionsPerUser
          ? `${base}:user:${event.authorId}`
          : base;
      }
      const base = `discord:guild:${event.guild}:channel:${event.channelId}`;
      return options.groupSessionsPerUser
        ? `${base}:user:${event.authorId}`
        : base;
    };
  },

  replyToOriginThread(): DiscordOriginThreadDeliveryTarget {
    return { platform: 'discord', kind: 'originThread' };
  },

  channel(channel: string): DiscordChannelDeliveryTarget {
    return { platform: 'discord', channel };
  },
};

export const cron = {
  schedule(schedule: string): RuntimeSource<CronEvent> {
    return { type: 'cron.schedule', schedule };
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

function isBindingBuilder<TEvent extends RuntimeBindingEvent>(
  bindingLike: RuntimeBindingLike<TEvent>,
): bindingLike is BindingBuilder<TEvent> {
  return typeof (bindingLike as { build?: unknown }).build === 'function';
}
