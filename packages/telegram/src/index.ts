import type {
  ConversationResolver,
  DeliveryTarget,
  RuntimeFilter,
  Trigger,
  TriggerEvent,
} from '@prompttrail/core';
import type {
  RuntimeAdapter,
  RuntimeGatewayContext,
  RuntimePresenceHandle,
} from '@prompttrail/core/runtime_server';
import {
  createTelegramClient,
  type TelegramChatType,
  type TelegramClient,
  type TelegramMessage,
  type TelegramUpdate,
} from './client';

export * from './client';

/** Telegram messages cap out at 4096 UTF-16 code units. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Interval between repeated `typing` chat actions (Telegram expires it ~5s). */
export const TELEGRAM_TYPING_INTERVAL_MS = 5_000;

export interface TelegramEvent extends TriggerEvent {
  source: 'telegram';
  chatId: string;
  chatType: TelegramChatType;
  chatUsername?: string;
  userId: string;
  username?: string;
  firstName?: string;
  messageId: number;
  content: string;
  isGroup: boolean;
  isBot: boolean;
  mentionsBot?: boolean;
}

export interface TelegramOriginChatDeliveryTarget extends DeliveryTarget {
  platform: 'telegram';
  kind: 'originChat';
}

export interface ConcreteTelegramDeliveryTarget extends DeliveryTarget {
  platform: 'telegram';
  chatId: string;
  replyToMessageId?: number;
}

export interface TelegramSessionKeyOptions {
  /**
   * When true, group chats get one conversation per user (chatId + userId).
   * DMs are always per-user because a private chat id is 1:1 with a user.
   */
  groupSessionsPerUser?: boolean;
}

export const telegram = {
  messages(): Trigger<TelegramEvent> {
    return {
      type: 'telegram.messages',
      eventAttrs: (event) => ({
        chatId: event.chatId,
        chatType: event.chatType,
        userId: event.userId,
        username: event.username,
        messageId: event.messageId,
      }),
      resolveDelivery: (delivery, event) => {
        if (
          delivery.platform === 'origin' ||
          isTelegramOriginChatDeliveryTarget(delivery)
        ) {
          return telegramOrigin(event);
        }
        return delivery;
      },
    };
  },

  notBot(): RuntimeFilter<TelegramEvent> {
    return (event) => !event.isBot;
  },

  inChats(
    chatIds: ReadonlyArray<string | number>,
  ): RuntimeFilter<TelegramEvent> {
    const allowed = chatIds.map(normalizeChatRef);
    return (event) => allowed.some((ref) => chatRefMatches(event, ref));
  },

  sessionKey(
    options: TelegramSessionKeyOptions = {},
  ): ConversationResolver<TelegramEvent> {
    return (event) => {
      const base = `telegram:chat:${event.chatId}`;
      if (event.isGroup && options.groupSessionsPerUser) {
        return `${base}:user:${event.userId}`;
      }
      return base;
    };
  },

  replyToChat(): TelegramOriginChatDeliveryTarget {
    return { platform: 'telegram', kind: 'originChat' };
  },
};

export interface TelegramGatewayOptions {
  token: string;
  /** Injectable client for tests; defaults to the HTTPS long-polling client. */
  client?: TelegramClient;
  /** Long-poll timeout in seconds passed to getUpdates (default 30). */
  pollTimeoutSeconds?: number;
  /** Restrict processing to these chat ids/usernames before dispatch. */
  allowedChats?: ReadonlyArray<string | number>;
  /** Require an @botusername mention in groups; the mention is stripped. */
  requireMention?: boolean;
  onError?: (error: unknown) => void;
  onReady?: (me: { id: number; username?: string }) => void;
  /** Initial backoff after a poll error (ms, default 1000). */
  retryDelayMs?: number;
  /** Maximum backoff after repeated poll errors (ms, default 30000). */
  maxRetryDelayMs?: number;
}

export function telegramGateway(
  options: TelegramGatewayOptions,
): RuntimeAdapter {
  const client = options.client ?? createTelegramClient(options.token);
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
  let botUsername: string | undefined;
  let poller: TelegramPoller | undefined;

  return {
    name: 'telegram',
    gateways: [
      {
        type: 'telegram.messages',
        async start(ctx: RuntimeGatewayContext<TelegramEvent>) {
          const me = await client.getMe();
          botUsername = me.username;
          options.onReady?.({ id: me.id, username: me.username });
          poller = new TelegramPoller(client, ctx, {
            pollTimeoutSeconds,
            allowedChats: options.allowedChats,
            requireMention: options.requireMention,
            onError: options.onError,
            retryDelayMs: options.retryDelayMs ?? 1_000,
            maxRetryDelayMs: options.maxRetryDelayMs ?? 30_000,
            botUsername,
          });
          poller.start();
        },
        async stop() {
          await poller?.stop();
          poller = undefined;
        },
      },
    ],
    deliveries: [
      {
        platform: 'telegram',
        async deliver(_ctx, target, message) {
          if (!isConcreteTelegramDeliveryTarget(target)) {
            return undefined;
          }
          const chunks = chunkTelegramMessage(message.content);
          let last: TelegramMessage | undefined;
          for (let index = 0; index < chunks.length; index++) {
            last = await client.sendMessage({
              chatId: target.chatId,
              text: chunks[index],
              // Reply-threading only anchors the first chunk in group chats.
              replyToMessageId:
                index === 0 ? target.replyToMessageId : undefined,
            });
          }
          if (!last) {
            return undefined;
          }
          return {
            platform: 'telegram',
            chatId: target.chatId,
            messageId: last.message_id,
          };
        },
      },
    ],
    presences: [
      {
        platform: 'telegram',
        start(_ctx, target, presence) {
          if (
            !isConcreteTelegramDeliveryTarget(target) ||
            (presence.kind !== 'typing' && presence.kind !== 'processing')
          ) {
            return undefined;
          }
          return startTelegramTyping(client, target.chatId);
        },
      },
    ],
    observers: [],
  };
}

interface TelegramPollerOptions {
  pollTimeoutSeconds: number;
  allowedChats?: ReadonlyArray<string | number>;
  requireMention?: boolean;
  onError?: (error: unknown) => void;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  botUsername?: string;
}

class TelegramPoller {
  private readonly controller = new AbortController();
  private readonly allowedChats?: ReadonlyArray<{
    kind: 'id' | 'username';
    value: string;
  }>;
  private running = false;
  private loop?: Promise<void>;
  private offset?: number;

  constructor(
    private readonly client: TelegramClient,
    private readonly ctx: RuntimeGatewayContext<TelegramEvent>,
    private readonly options: TelegramPollerOptions,
  ) {
    this.allowedChats = options.allowedChats?.map(normalizeChatRef);
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller.abort();
    // Await the loop so no getUpdates request or backoff timer outlives stop().
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    let backoff = this.options.retryDelayMs;
    while (this.running) {
      try {
        const updates = await this.client.getUpdates({
          offset: this.offset,
          timeout: this.options.pollTimeoutSeconds,
          allowedUpdates: ['message'],
          signal: this.controller.signal,
        });
        backoff = this.options.retryDelayMs;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (!this.running) {
            break;
          }
          try {
            await this.handle(update);
          } catch (error) {
            this.options.onError?.(error);
          }
        }
      } catch (error) {
        if (!this.running || this.controller.signal.aborted) {
          break;
        }
        this.options.onError?.(error);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, this.options.maxRetryDelayMs);
      }
    }
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message) {
      return;
    }
    const event = telegramMessageToEvent(message, this.options.botUsername);
    if (!event) {
      return;
    }
    if (
      this.allowedChats &&
      !this.allowedChats.some((ref) => chatRefMatches(event, ref))
    ) {
      return;
    }
    let content = event.content;
    if (this.options.requireMention && event.isGroup) {
      if (!event.mentionsBot) {
        return;
      }
      content = stripMention(content, this.options.botUsername);
    }
    await this.ctx.emit(event, { content });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (ms <= 0 || this.controller.signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        resolve();
      };
      const cleanup = () =>
        this.controller.signal.removeEventListener('abort', onAbort);
      this.controller.signal.addEventListener('abort', onAbort, {
        once: true,
      });
    });
  }
}

export function telegramMessageToEvent(
  message: TelegramMessage,
  botUsername?: string,
): TelegramEvent | undefined {
  if (typeof message.text !== 'string' || message.text.length === 0) {
    return undefined;
  }
  const chat = message.chat;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const from = message.from;
  return {
    source: 'telegram',
    chatId: String(chat.id),
    chatType: chat.type,
    chatUsername: chat.username,
    userId: from ? String(from.id) : String(chat.id),
    username: from?.username,
    firstName: from?.first_name,
    messageId: message.message_id,
    content: message.text,
    isGroup,
    isBot: from?.is_bot ?? false,
    mentionsBot: botUsername
      ? mentionsUsername(message.text, botUsername)
      : false,
  };
}

export async function startTelegramTyping(
  client: TelegramClient,
  chatId: string,
): Promise<RuntimePresenceHandle | undefined> {
  const send = () =>
    client.sendChatAction({ chatId, action: 'typing' }).catch(() => undefined);
  await send();
  const interval = setInterval(() => {
    void send();
  }, TELEGRAM_TYPING_INTERVAL_MS);
  return {
    stop() {
      clearInterval(interval);
    },
  };
}

/**
 * Split content into chunks that respect Telegram's 4096-char message limit,
 * preferring a newline boundary when one exists within the window.
 */
export function chunkTelegramMessage(
  text: string,
  limit = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length === 0) {
    return [];
  }
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) {
      cut = limit;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

export function isConcreteTelegramDeliveryTarget(
  delivery: DeliveryTarget | undefined,
): delivery is ConcreteTelegramDeliveryTarget {
  return (
    delivery?.platform === 'telegram' &&
    'chatId' in delivery &&
    !('kind' in delivery)
  );
}

function isTelegramOriginChatDeliveryTarget(
  delivery: DeliveryTarget,
): delivery is TelegramOriginChatDeliveryTarget {
  return delivery.platform === 'telegram' && delivery.kind === 'originChat';
}

function telegramOrigin(event: TelegramEvent): ConcreteTelegramDeliveryTarget {
  return {
    platform: 'telegram',
    chatId: event.chatId,
    replyToMessageId: event.isGroup ? event.messageId : undefined,
  };
}

interface ChatRef {
  kind: 'id' | 'username';
  value: string;
}

function normalizeChatRef(ref: string | number): ChatRef {
  if (typeof ref === 'number') {
    return { kind: 'id', value: String(ref) };
  }
  const trimmed = ref.trim();
  if (trimmed.startsWith('@')) {
    return { kind: 'username', value: trimmed.slice(1).toLowerCase() };
  }
  if (/^-?\d+$/.test(trimmed)) {
    return { kind: 'id', value: trimmed };
  }
  return { kind: 'username', value: trimmed.toLowerCase() };
}

function chatRefMatches(event: TelegramEvent, ref: ChatRef): boolean {
  if (ref.kind === 'id') {
    return event.chatId === ref.value;
  }
  return (event.chatUsername ?? '').toLowerCase() === ref.value;
}

function mentionsUsername(text: string, username: string): boolean {
  return text.toLowerCase().includes(`@${username.toLowerCase()}`);
}

function stripMention(text: string, username?: string): string {
  if (!username) {
    return text.trim();
  }
  const pattern = new RegExp(`@${escapeRegExp(username)}\\b`, 'gi');
  return text
    .replace(pattern, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
