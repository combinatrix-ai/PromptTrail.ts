import type {
  GetUpdatesParams,
  SendChatActionParams,
  SendMessageParams,
  TelegramChatType,
  TelegramClient,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramUpdate,
  TelegramUser,
} from './client';

export interface FakeTelegramSentMessage {
  chatId: number | string;
  text: string;
  replyToMessageId?: number;
}

export interface FakeTelegramChatAction {
  chatId: number | string;
  action: string;
}

export interface FakePushMessageOptions {
  chatId: number | string;
  text: string;
  fromId?: number | string;
  fromUsername?: string;
  isBot?: boolean;
  chatType?: TelegramChatType;
  chatUsername?: string;
  messageId?: number;
  entities?: TelegramMessageEntity[];
}

interface PendingWaiter {
  resolve: (updates: TelegramUpdate[]) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Network-free Telegram connector for tests. Feed inbound updates with
 * {@link FakeTelegramClient.pushUpdate}; inspect outbound calls via `sent` and
 * `chatActions`. getUpdates long-polls: it resolves immediately when updates
 * are queued, otherwise it parks until the next pushUpdate or an abort.
 */
export class FakeTelegramClient implements TelegramClient {
  readonly sent: FakeTelegramSentMessage[] = [];
  readonly chatActions: FakeTelegramChatAction[] = [];
  me: TelegramUser = {
    id: 1000,
    is_bot: true,
    username: 'clawbot',
    first_name: 'Claw',
  };

  private readonly pending: TelegramUpdate[] = [];
  private readonly errorQueue: unknown[] = [];
  private waiter?: PendingWaiter;
  private updateSeq = 1;
  private messageSeq = 1;

  async getMe(): Promise<TelegramUser> {
    return this.me;
  }

  /** Queue an error to be thrown by the next getUpdates call. */
  failNextGetUpdates(error: unknown): void {
    this.errorQueue.push(error);
  }

  getUpdates({ signal }: GetUpdatesParams): Promise<TelegramUpdate[]> {
    if (this.errorQueue.length > 0) {
      return Promise.reject(this.errorQueue.shift());
    }
    if (signal?.aborted) {
      return Promise.resolve([]);
    }
    if (this.pending.length > 0) {
      return Promise.resolve(this.drain());
    }
    return new Promise<TelegramUpdate[]>((resolve) => {
      const onAbort = () => {
        this.waiter = undefined;
        resolve([]);
      };
      this.waiter = { resolve, signal, onAbort };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  pushUpdate(options: FakePushMessageOptions): TelegramUpdate {
    const chatType = options.chatType ?? 'private';
    const chatId =
      typeof options.chatId === 'number'
        ? options.chatId
        : Number(options.chatId);
    const fromId =
      options.fromId !== undefined ? Number(options.fromId) : chatId;
    const message: TelegramMessage = {
      message_id: options.messageId ?? this.messageSeq++,
      from: {
        id: fromId,
        is_bot: options.isBot ?? false,
        username: options.fromUsername,
        first_name: options.fromUsername ?? 'User',
      },
      chat: {
        id: chatId,
        type: chatType,
        username: options.chatUsername,
      },
      text: options.text,
      entities: options.entities,
    };
    const update: TelegramUpdate = {
      update_id: this.updateSeq++,
      message,
    };
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve([update]);
    } else {
      this.pending.push(update);
    }
    return update;
  }

  async sendMessage({
    chatId,
    text,
    replyToMessageId,
  }: SendMessageParams): Promise<TelegramMessage> {
    this.sent.push({ chatId, text, replyToMessageId });
    return {
      message_id: this.messageSeq++,
      chat: { id: Number(chatId), type: 'private' },
      text,
    };
  }

  async sendChatAction({
    chatId,
    action,
  }: SendChatActionParams): Promise<void> {
    this.chatActions.push({ chatId, action });
  }

  private drain(): TelegramUpdate[] {
    const updates = [...this.pending];
    this.pending.length = 0;
    return updates;
  }
}

export function mockTelegram(): FakeTelegramClient {
  return new FakeTelegramClient();
}
