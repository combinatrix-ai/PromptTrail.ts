import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeGatewayContext,
  RuntimeGatewayDriver,
} from '@prompttrail/core/runtime_server';
import {
  chunkTelegramMessage,
  telegram,
  telegramGateway,
  telegramMessageToEvent,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  type TelegramEvent,
} from '../../index';
import { FakeTelegramClient } from '../../testing';

function messagesGateway(
  adapter: ReturnType<typeof telegramGateway>,
): RuntimeGatewayDriver {
  const gateway = adapter.gateways?.find(
    (candidate) => candidate.type === 'telegram.messages',
  );
  if (!gateway) {
    throw new Error('telegram.messages gateway not found');
  }
  return gateway;
}

function collectingContext(): {
  ctx: RuntimeGatewayContext<TelegramEvent>;
  emitted: Array<{ event: TelegramEvent; content?: string }>;
} {
  const emitted: Array<{ event: TelegramEvent; content?: string }> = [];
  const ctx: RuntimeGatewayContext<TelegramEvent> = {
    async emit(event, options) {
      emitted.push({ event, content: options?.content });
    },
    bindings: [],
  };
  return { ctx, emitted };
}

async function waitFor(
  predicate: () => boolean,
  { timeout = 2_000, interval = 5 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('waitFor timed out');
}

describe('chunkTelegramMessage', () => {
  it('returns an empty array for empty content', () => {
    expect(chunkTelegramMessage('')).toEqual([]);
  });

  it('returns a single chunk under the limit', () => {
    expect(chunkTelegramMessage('hello')).toEqual(['hello']);
  });

  it('splits content longer than the limit', () => {
    const text = 'a'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 10);
    const chunks = chunkTelegramMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers a newline boundary within the window', () => {
    const head = 'a'.repeat(4000);
    const tail = 'b'.repeat(200);
    const chunks = chunkTelegramMessage(`${head}\n${tail}`);
    expect(chunks).toEqual([head, tail]);
  });
});

describe('telegramMessageToEvent', () => {
  it('maps a group message and detects a mention', () => {
    const event = telegramMessageToEvent(
      {
        message_id: 7,
        from: { id: 9, is_bot: false, username: 'alice' },
        chat: { id: -100, type: 'supergroup', username: 'lab' },
        text: 'hey @clawbot',
      },
      'clawbot',
    );
    expect(event).toMatchObject({
      source: 'telegram',
      chatId: '-100',
      chatType: 'supergroup',
      chatUsername: 'lab',
      userId: '9',
      username: 'alice',
      messageId: 7,
      isGroup: true,
      isBot: false,
      mentionsBot: true,
    });
  });

  it('ignores non-text updates', () => {
    expect(
      telegramMessageToEvent({
        message_id: 1,
        chat: { id: 1, type: 'private' },
      }),
    ).toBeUndefined();
  });
});

describe('telegram trigger delivery resolution', () => {
  it('anchors group replies to the origin message and leaves DMs unthreaded', () => {
    const trigger = telegram.messages();
    const groupEvent: TelegramEvent = {
      source: 'telegram',
      chatId: '-100',
      chatType: 'supergroup',
      userId: '1',
      messageId: 55,
      content: 'hi',
      isGroup: true,
      isBot: false,
    };
    const dmEvent: TelegramEvent = {
      ...groupEvent,
      chatId: '9',
      chatType: 'private',
      messageId: 7,
      isGroup: false,
    };
    expect(
      trigger.resolveDelivery?.(telegram.replyToChat(), groupEvent),
    ).toEqual({ platform: 'telegram', chatId: '-100', replyToMessageId: 55 });
    expect(trigger.resolveDelivery?.(telegram.replyToChat(), dmEvent)).toEqual({
      platform: 'telegram',
      chatId: '9',
      replyToMessageId: undefined,
    });
  });
});

describe('telegram poll loop', () => {
  it('emits parked updates once pushed', async () => {
    const client = new FakeTelegramClient();
    const gateway = messagesGateway(telegramGateway({ token: 't', client }));
    const { ctx, emitted } = collectingContext();
    await gateway.start(ctx);

    client.pushUpdate({ chatId: 5, text: 'hello' });
    await waitFor(() => emitted.length > 0);

    expect(emitted[0].event.chatId).toBe('5');
    expect(emitted[0].content).toBe('hello');
    await gateway.stop?.();
  });

  it('stop() aborts the poll loop with no further processing', async () => {
    const client = new FakeTelegramClient();
    const onReady = vi.fn();
    const gateway = messagesGateway(
      telegramGateway({ token: 't', client, onReady }),
    );
    const { ctx, emitted } = collectingContext();
    await gateway.start(ctx);
    expect(onReady).toHaveBeenCalledWith({ id: 1000, username: 'clawbot' });

    // The loop is parked in getUpdates; stop() must resolve promptly.
    await gateway.stop?.();

    client.pushUpdate({ chatId: 5, text: 'after stop' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(emitted).toEqual([]);
  });

  it('backs off on a poll error, reports it, and keeps polling', async () => {
    const client = new FakeTelegramClient();
    const onError = vi.fn();
    const error = new Error('network down');
    client.failNextGetUpdates(error);
    const gateway = messagesGateway(
      telegramGateway({
        token: 't',
        client,
        onError,
        retryDelayMs: 5,
        maxRetryDelayMs: 20,
      }),
    );
    const { ctx, emitted } = collectingContext();
    await gateway.start(ctx);

    client.pushUpdate({ chatId: 5, text: 'recovered' });
    await waitFor(() => emitted.length > 0);

    expect(onError).toHaveBeenCalledWith(error);
    expect(emitted[0].content).toBe('recovered');
    await gateway.stop?.();
  });
});

describe('telegram presence', () => {
  it('sends a typing chat action when presence starts', async () => {
    const client = new FakeTelegramClient();
    const adapter = telegramGateway({ token: 't', client });
    const presence = adapter.presences?.find(
      (candidate) => candidate.platform === 'telegram',
    );
    const handle = await presence?.start(
      { event: { source: 'telegram' }, delivery: { platform: 'telegram' } },
      { platform: 'telegram', chatId: '5' },
      { kind: 'typing' },
    );
    await waitFor(() => client.chatActions.length > 0);
    expect(client.chatActions[0]).toEqual({ chatId: '5', action: 'typing' });
    await handle?.stop();
  });
});
