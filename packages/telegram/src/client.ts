/**
 * Minimal Telegram Bot API client.
 *
 * Telegram's Bot API is plain HTTPS: long-polling via getUpdates and message
 * delivery via sendMessage. This client is deliberately dependency-free — it
 * uses the global `fetch` available on Node 22+ — so the package does not pull
 * in grammy/telegraf. The interface is injectable so tests substitute a fake
 * connector with no network access.
 */

export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel';

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number;
  type: TelegramChatType;
  title?: string;
  username?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date?: number;
  text?: string;
  entities?: TelegramMessageEntity[];
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface GetUpdatesParams {
  offset?: number;
  timeout?: number;
  allowedUpdates?: readonly string[];
  signal?: AbortSignal;
}

export interface SendMessageParams {
  chatId: number | string;
  text: string;
  replyToMessageId?: number;
}

export interface SendChatActionParams {
  chatId: number | string;
  action: string;
}

export interface TelegramClient {
  getMe(): Promise<TelegramUser>;
  getUpdates(params: GetUpdatesParams): Promise<TelegramUpdate[]>;
  sendMessage(params: SendMessageParams): Promise<TelegramMessage>;
  sendChatAction(params: SendChatActionParams): Promise<void>;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface CreateTelegramClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly description: string | undefined,
    readonly errorCode?: number,
  ) {
    super(`Telegram API ${method} failed: ${description ?? 'unknown error'}`);
    this.name = 'TelegramApiError';
  }
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/**
 * Create the default HTTPS client bound to a bot token. Requires a global
 * `fetch` (Node 22+) unless one is injected via options.
 */
export function createTelegramClient(
  token: string,
  options: CreateTelegramClientOptions = {},
): TelegramClient {
  const baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(
    /\/$/,
    '',
  );
  const fetchImpl = options.fetch ?? resolveGlobalFetch();

  async function call<T>(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(pruneUndefined(body)) : undefined,
      signal,
    });
    const payload = (await response.json()) as TelegramApiResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new TelegramApiError(
        method,
        payload.description,
        payload.error_code,
      );
    }
    return payload.result as T;
  }

  return {
    getMe() {
      return call<TelegramUser>('getMe');
    },
    getUpdates({ offset, timeout, allowedUpdates, signal }) {
      return call<TelegramUpdate[]>(
        'getUpdates',
        {
          offset,
          timeout,
          allowed_updates: allowedUpdates,
        },
        signal,
      );
    },
    sendMessage({ chatId, text, replyToMessageId }) {
      return call<TelegramMessage>('sendMessage', {
        chat_id: chatId,
        text,
        reply_to_message_id: replyToMessageId,
      });
    },
    async sendChatAction({ chatId, action }) {
      await call('sendChatAction', { chat_id: chatId, action });
    },
  };
}

function resolveGlobalFetch(): FetchLike {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== 'function') {
    throw new Error(
      'Global fetch is not available. Provide options.fetch or run on Node 22+.',
    );
  }
  return candidate as unknown as FetchLike;
}

function pruneUndefined(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
