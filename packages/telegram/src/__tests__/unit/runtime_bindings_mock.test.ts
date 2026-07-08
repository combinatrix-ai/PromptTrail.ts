import { afterEach, describe, expect, it } from 'vitest';
import {
  Agent,
  MemoryRunStore,
  PromptTrail,
  on,
  type RuntimeBundle,
} from '@prompttrail/core';
import {
  telegram,
  telegramGateway,
  type TelegramGatewayOptions,
} from '../../index';
import { FakeTelegramClient } from '../../testing';

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeout = 3_000, interval = 5 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('waitFor timed out');
}

function echoAgent(name = 'main'): Agent {
  return Agent.create(name)
    .inbox('inbox')
    .assistant('reply', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
}

const started: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.stop();
  }
});

interface FixtureConfig {
  bundle: (main: Agent) => RuntimeBundle;
  gateway?: Partial<TelegramGatewayOptions>;
}

async function startFixture(config: FixtureConfig) {
  const client = new FakeTelegramClient();
  const store = new MemoryRunStore();
  const main = echoAgent('main');
  const app = PromptTrail.app({ store, agents: { main } });
  const bundle = config.bundle(main);
  const server = PromptTrail.server({
    bundle,
    runtime: app,
    presence: { kind: 'typing' },
    adapters: [
      telegramGateway({ token: 'test-token', client, ...config.gateway }),
    ],
  });
  await server.start();
  started.push(server);

  const conversationIds = async () =>
    [...(await store.entries())].map(([id]) => id);
  const inbox = async (id: string) => {
    const run = await store.get(id);
    return (run?.inbox ?? []).map((message) => ({
      role: message.kind,
      content: message.content,
    }));
  };

  return { client, store, server, conversationIds, inbox };
}

function bundleWith(bindings: unknown[]): (main: Agent) => RuntimeBundle {
  return (main) =>
    PromptTrail.runtimeBundle({
      name: 'telegram-test',
      agents: { main },
      defaults: { checkpoint: true },
      bindings: bindings as never,
    });
}

const routedBinding = () =>
  on(telegram.messages())
    .where(telegram.notBot())
    .toAgent('main')
    .conversation(telegram.sessionKey({ groupSessionsPerUser: true }))
    .reply(telegram.replyToChat());

describe('runtime bindings with a fake Telegram client', () => {
  it('routes an allowed private message to a durable agent conversation', async () => {
    const fixture = await startFixture({
      bundle: bundleWith([routedBinding()]),
    });

    fixture.client.pushUpdate({
      chatId: 555,
      text: 'why is the VM out of disk?',
      fromUsername: 'alice',
    });

    await waitFor(() => fixture.client.sent.length > 0);

    expect(await fixture.conversationIds()).toContain('telegram:chat:555');
    expect(await fixture.inbox('telegram:chat:555')).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: 'why is the VM out of disk?',
      }),
    );
    expect(fixture.client.sent).toContainEqual(
      expect.objectContaining({
        chatId: '555',
        text: 'reply:why is the VM out of disk?',
        replyToMessageId: undefined,
      }),
    );
  });

  it('isolates two users in a group when groupSessionsPerUser is set', async () => {
    const fixture = await startFixture({
      bundle: bundleWith([routedBinding()]),
    });

    fixture.client.pushUpdate({
      chatId: -100,
      chatType: 'supergroup',
      fromId: 1,
      fromUsername: 'alice',
      text: 'alice task',
    });
    fixture.client.pushUpdate({
      chatId: -100,
      chatType: 'supergroup',
      fromId: 2,
      fromUsername: 'bob',
      text: 'bob task',
    });

    await waitFor(() => fixture.client.sent.length >= 2);

    const ids = await fixture.conversationIds();
    expect(ids).toEqual(
      expect.arrayContaining([
        'telegram:chat:-100:user:1',
        'telegram:chat:-100:user:2',
      ]),
    );
  });

  it('shares a group conversation when groupSessionsPerUser is not set', async () => {
    const fixture = await startFixture({
      bundle: bundleWith([
        on(telegram.messages())
          .where(telegram.notBot())
          .toAgent('main')
          .conversation(telegram.sessionKey())
          .reply(telegram.replyToChat()),
      ]),
    });

    fixture.client.pushUpdate({
      chatId: -100,
      chatType: 'supergroup',
      fromId: 1,
      fromUsername: 'alice',
      text: 'first',
    });
    fixture.client.pushUpdate({
      chatId: -100,
      chatType: 'supergroup',
      fromId: 2,
      fromUsername: 'bob',
      text: 'second',
    });

    await waitFor(() => fixture.client.sent.length >= 2);

    expect(await fixture.conversationIds()).toEqual(['telegram:chat:-100']);
  });

  it('keeps DMs isolated per chat', async () => {
    const fixture = await startFixture({
      bundle: bundleWith([routedBinding()]),
    });

    fixture.client.pushUpdate({
      chatId: 111,
      fromUsername: 'alice',
      text: 'hi',
    });
    fixture.client.pushUpdate({ chatId: 222, fromUsername: 'bob', text: 'yo' });

    await waitFor(() => fixture.client.sent.length >= 2);

    const ids = await fixture.conversationIds();
    expect(ids).toEqual(
      expect.arrayContaining(['telegram:chat:111', 'telegram:chat:222']),
    );
  });

  it('drops bot-authored messages via the notBot filter', async () => {
    const fixture = await startFixture({
      bundle: bundleWith([routedBinding()]),
    });

    fixture.client.pushUpdate({
      chatId: 555,
      text: 'automated status',
      fromUsername: 'digestBot',
      isBot: true,
    });
    // A subsequent human message must still route, proving the loop kept going.
    fixture.client.pushUpdate({
      chatId: 555,
      text: 'human here',
      fromUsername: 'alice',
    });

    await waitFor(() => fixture.client.sent.length > 0);

    expect(fixture.client.sent).toEqual([
      expect.objectContaining({ text: 'reply:human here' }),
    ]);
  });

  it('respects the allowedChats gateway option', async () => {
    const fixture = await startFixture({
      bundle: bundleWith([routedBinding()]),
      gateway: { allowedChats: [555] },
    });

    fixture.client.pushUpdate({ chatId: 999, text: 'from elsewhere' });
    fixture.client.pushUpdate({ chatId: 555, text: 'from allowed' });

    await waitFor(() => fixture.client.sent.length > 0);

    expect(fixture.client.sent).toEqual([
      expect.objectContaining({ chatId: '555', text: 'reply:from allowed' }),
    ]);
  });

  it('routes only chats named by the inChats filter', async () => {
    const fixture = await startFixture({
      bundle: bundleWith([
        on(telegram.messages())
          .where(telegram.notBot())
          .where(telegram.inChats([555]))
          .toAgent('main')
          .conversation(telegram.sessionKey())
          .reply(telegram.replyToChat()),
      ]),
    });

    fixture.client.pushUpdate({ chatId: 777, text: 'ignored' });
    fixture.client.pushUpdate({ chatId: 555, text: 'accepted' });

    await waitFor(() => fixture.client.sent.length > 0);

    expect(fixture.client.sent).toEqual([
      expect.objectContaining({ chatId: '555', text: 'reply:accepted' }),
    ]);
  });

  it('requires and strips an @botusername mention in groups', async () => {
    const fixture = await startFixture({
      bundle: bundleWith([routedBinding()]),
      gateway: { requireMention: true },
    });

    fixture.client.pushUpdate({
      chatId: -100,
      chatType: 'supergroup',
      fromId: 1,
      fromUsername: 'alice',
      text: 'quiet background message',
    });
    fixture.client.pushUpdate({
      chatId: -100,
      chatType: 'supergroup',
      fromId: 1,
      fromUsername: 'alice',
      text: '@clawbot please inspect this',
    });

    await waitFor(() => fixture.client.sent.length > 0);

    // Only the mentioned message routes, and the mention is stripped.
    expect(fixture.client.sent).toEqual([
      expect.objectContaining({ text: 'reply:please inspect this' }),
    ]);
  });

  it('sets reply_to_message_id for group replies', async () => {
    const fixture = await startFixture({
      bundle: bundleWith([routedBinding()]),
    });

    fixture.client.pushUpdate({
      chatId: -100,
      chatType: 'supergroup',
      fromId: 1,
      fromUsername: 'alice',
      messageId: 4242,
      text: 'ping',
    });

    await waitFor(() => fixture.client.sent.length > 0);

    expect(fixture.client.sent[0]).toEqual(
      expect.objectContaining({ chatId: '-100', replyToMessageId: 4242 }),
    );
  });

  it('chunks assistant replies longer than 4096 characters', async () => {
    const longAgent = Agent.create('main')
      .inbox('inbox')
      .assistant('reply', () => ({ content: 'x'.repeat(5000) }));
    const client = new FakeTelegramClient();
    const store = new MemoryRunStore();
    const app = PromptTrail.app({ store, agents: { main: longAgent } });
    const bundle = PromptTrail.runtimeBundle({
      name: 'telegram-chunk',
      agents: { main: longAgent },
      defaults: { checkpoint: true },
      bindings: [
        on(telegram.messages())
          .toAgent('main')
          .conversation(telegram.sessionKey())
          .reply(telegram.replyToChat()),
      ],
    });
    const server = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [telegramGateway({ token: 'test-token', client })],
    });
    await server.start();
    started.push(server);

    client.pushUpdate({ chatId: 42, text: 'go' });

    await waitFor(() => client.sent.length >= 2);

    expect(client.sent).toHaveLength(2);
    expect(client.sent[0].text.length).toBe(4096);
    expect(client.sent[1].text.length).toBe(904);
    expect(client.sent[0].text + client.sent[1].text).toBe('x'.repeat(5000));
  });
});
