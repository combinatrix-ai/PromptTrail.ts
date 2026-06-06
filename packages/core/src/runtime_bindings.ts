import type { DurableAgent } from './durable';

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

export interface RuntimeSource<TEvent extends RuntimeBindingEvent> {
  type: string;
  schedule?: string;
}

export interface RuntimeBinding<TEvent extends RuntimeBindingEvent> {
  source: RuntimeSource<TEvent>;
  filters: RuntimeFilter<TEvent>[];
  agent: string;
  conversation: ConversationResolver<TEvent>;
  input?: InputResolver<TEvent>;
  defaults: BindingDefaults;
  name?: string;
}

export type RuntimeBindingLike<TEvent extends RuntimeBindingEvent> =
  | RuntimeBinding<TEvent>
  | BindingBuilder<TEvent>;

export interface RuntimeBundle {
  name: string;
  agents: Record<string, DurableAgent<any, any>>;
  defaults: BindingDefaults;
  bindings: RuntimeBinding<RuntimeBindingEvent>[];
}

export interface RuntimeBundleOptions {
  name: string;
  agents?: Record<string, DurableAgent<any, any>>;
  defaults?: BindingDefaults;
  bindings?: RuntimeBindingLike<RuntimeBindingEvent>[];
}

export class BindingBuilder<TEvent extends RuntimeBindingEvent> {
  private filters: RuntimeFilter<TEvent>[] = [];
  private agentName?: string;
  private conversationResolver?: ConversationResolver<TEvent>;
  private inputResolver?: InputResolver<TEvent>;
  private bindingDefaults: BindingDefaults = {};
  private bindingName?: string;

  constructor(private readonly source: RuntimeSource<TEvent>) {}

  where(filter: RuntimeFilter<TEvent>): this {
    this.filters.push(filter);
    return this;
  }

  toAgent(agent: string): this {
    this.agentName = agent;
    return this;
  }

  conversation(resolver: ConversationResolver<TEvent>): this {
    this.conversationResolver = resolver;
    return this;
  }

  input(input: InputResolver<TEvent>): this {
    this.inputResolver = input;
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

export function bundle(options: RuntimeBundleOptions): RuntimeBundle {
  return {
    name: options.name,
    agents: options.agents ?? {},
    defaults: options.defaults ?? {},
    bindings: (options.bindings ?? []).map((bindingLike) =>
      bindingLike instanceof BindingBuilder ? bindingLike.build() : bindingLike,
    ),
  };
}
