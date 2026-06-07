import { describe, expect, it } from 'vitest';
import { PromptTrail, agent, memoryStore } from '../../durable';
import {
  bind,
  discord,
  type DiscordMessageEvent,
} from '../../runtime_bindings';
import {
  type RuntimeAdapter,
  type RuntimeSourceContext,
} from '../../runtime_server';

describe('RuntimeServer', () => {
  it('routes adapter source events through bindings and delivery drivers', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const activityEvents: string[] = [];
    const observerEvents: string[] = [];
    const main = agent('main').chat('chat', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
    const bundle = PromptTrail.bundle({
      name: 'server-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const adapter: RuntimeAdapter = {
      name: 'test-discord',
      sources: [
        {
          type: 'discord.messages',
          start(ctx) {
            emit = ctx.emit;
          },
        },
      ],
      deliveries: [
        {
          platform: 'discord',
          deliver(_ctx, _target, message) {
            deliveries.push(message.content);
          },
        },
      ],
      activities: [
        {
          platform: 'discord',
          start() {
            activityEvents.push('start');
            return {
              stop() {
                activityEvents.push('stop');
              },
            };
          },
        },
      ],
    };
    const server = PromptTrail.server({
      bundle,
      runtime: PromptTrail.app({
        store: memoryStore(),
        agents: bundle.agents,
      }),
      activity: { kind: 'typing' },
      observers: [
        (event) => {
          observerEvents.push(
            `${event.seq}:${event.type}:${event.idempotencyKey}`,
          );
        },
      ],
      adapters: [adapter],
    });

    await server.start();
    await emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'hello',
    });

    expect(activityEvents).toEqual(['start', 'stop']);
    expect(deliveries).toEqual(['reply:hello']);
    expect(observerEvents).toEqual([
      '0:delivery.pending:discord:guild:workroom:channel:C_general:user:U_alice:turn:1:delivery:final',
      '1:delivery.completed:discord:guild:workroom:channel:C_general:user:U_alice:turn:1:delivery:final',
    ]);
  });

  it('persists completed final deliveries across server restarts', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const main = agent('main').chat('chat', (session) => ({
      content: `reply:${session.getLastMessage()?.content ?? ''}`,
    }));
    const bundle = PromptTrail.bundle({
      name: 'server-restart-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const adapter: RuntimeAdapter = {
      name: 'test-discord',
      sources: [
        {
          type: 'discord.messages',
          start(ctx) {
            emit = ctx.emit;
          },
        },
      ],
      deliveries: [
        {
          platform: 'discord',
          deliver(_ctx, _target, message) {
            deliveries.push(message.content);
          },
        },
      ],
    };
    const firstServer = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [adapter],
    });

    await firstServer.start();
    await emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'first',
    });

    const secondServer = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [adapter],
    });

    await secondServer.start();
    await emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'second',
    });

    expect(deliveries).toEqual(['reply:first', 'reply:second']);
    expect(
      app
        .assistantDeliveryOutbox(
          'discord:guild:workroom:channel:C_general:user:U_alice',
        )
        .map((entry) => ({
          idempotencyKey: entry.idempotencyKey,
          status: entry.status,
        })),
    ).toEqual([
      {
        idempotencyKey:
          'discord:guild:workroom:channel:C_general:user:U_alice:turn:1:delivery:final',
        status: 'completed',
      },
      {
        idempotencyKey:
          'discord:guild:workroom:channel:C_general:user:U_alice:turn:2:delivery:final',
        status: 'completed',
      },
    ]);
  });

  it('serializes concurrent dispatches for the same conversation', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstHandlerStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const main = agent('main').chat('chat', async (session) => {
      const content = session.getLastMessage()?.content ?? '';
      order.push(`handler:${content}`);
      if (content === 'first') {
        firstStarted?.();
        await firstCanFinish;
      }
      return `reply:${content}`;
    });
    const bundle = PromptTrail.bundle({
      name: 'server-lock-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const server = PromptTrail.server({
      bundle,
      runtime: PromptTrail.app({
        store: memoryStore(),
        agents: bundle.agents,
      }),
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver(_ctx, _target, message) {
                order.push(`deliver:${message.content}`);
              },
            },
          ],
        },
      ],
    });

    await server.start();
    const first = emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'first',
    });
    await firstHandlerStarted;
    const second = emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'second',
    });

    await Promise.resolve();
    expect(order).toEqual(['handler:first']);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual([
      'handler:first',
      'deliver:reply:first',
      'handler:second',
      'deliver:reply:second',
    ]);
  });

  it('runs concurrent dispatches for different conversations independently', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    let secondStarted: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstHandlerStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondHandlerStarted = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const main = agent('main').chat('chat', async (session) => {
      const content = session.getLastMessage()?.content ?? '';
      order.push(`handler:${content}`);
      if (content === 'first') {
        firstStarted?.();
        await firstCanFinish;
      }
      if (content === 'second') {
        secondStarted?.();
      }
      return `reply:${content}`;
    });
    const bundle = PromptTrail.bundle({
      name: 'server-lock-parallel-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [
        bind(discord.messages())
          .where(discord.notBot())
          .toAgent('main')
          .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
          .defaults({
            delivery: discord.replyToOriginThread(),
            behavior: {
              allowedChannels: ['general'],
              requireMention: false,
            },
          }),
      ],
    });
    const server = PromptTrail.server({
      bundle,
      runtime: PromptTrail.app({
        store: memoryStore(),
        agents: bundle.agents,
      }),
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start(ctx) {
                emit = ctx.emit;
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver(_ctx, _target, message) {
                order.push(`deliver:${message.content}`);
              },
            },
          ],
        },
      ],
    });

    await server.start();
    const first = emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'alice',
      authorId: 'U_alice',
      authorBot: false,
      content: 'first',
    });
    await firstHandlerStarted;
    const second = emit?.({
      source: 'discord',
      guild: 'workroom',
      channel: 'general',
      channelId: 'C_general',
      author: 'bob',
      authorId: 'U_bob',
      authorBot: false,
      content: 'second',
    });

    await secondHandlerStarted;
    await second;
    expect(order).toEqual([
      'handler:first',
      'handler:second',
      'deliver:reply:second',
    ]);

    releaseFirst?.();
    await first;

    expect(order).toEqual([
      'handler:first',
      'handler:second',
      'deliver:reply:second',
      'deliver:reply:first',
    ]);
  });

  it('retries pending final deliveries before starting sources', async () => {
    const order: string[] = [];
    const deliveries: string[] = [];
    const main = agent('main').assistant('reply', () => 'stored reply');
    const bundle = PromptTrail.bundle({
      name: 'server-outbox-retry-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const runId = 'discord:guild:workroom:channel:C_general';
    await app.run({
      agent: 'main',
      runId,
      durable: true,
    });
    app.prepareAssistantDeliveries(runId, [
      {
        assistantIndex: 0,
        idempotencyKey: `${runId}:turn:1:delivery:final`,
        message: {
          type: 'assistant',
          content: 'retry me',
        },
        target: discord.channel('general'),
      },
    ]);
    app.markAssistantDelivery(
      runId,
      `${runId}:turn:1:delivery:final`,
      'failed',
      new Error('previous delivery failed'),
    );

    const server = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start() {
                order.push('source-start');
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver(ctx, _target, message) {
                order.push('deliver');
                deliveries.push(`${ctx.idempotencyKey}:${message.content}`);
              },
            },
          ],
        },
      ],
    });

    await server.start();

    expect(order).toEqual(['deliver', 'source-start']);
    expect(deliveries).toEqual([
      'discord:guild:workroom:channel:C_general:turn:1:delivery:final:retry me',
    ]);
    expect(
      app.assistantDeliveryOutbox(runId).map((entry) => entry.status),
    ).toEqual(['completed']);
  });

  it('stops startup delivery retries for a conversation after the first failure', async () => {
    const order: string[] = [];
    const main = agent('main').assistant('reply', () => 'stored reply');
    const bundle = PromptTrail.bundle({
      name: 'server-outbox-retry-order-test',
      agents: { main },
      defaults: { durable: true },
      bindings: [],
    });
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: bundle.agents,
    });
    const runId = 'discord:guild:workroom:channel:C_general';
    await app.run({
      agent: 'main',
      runId,
      durable: true,
    });
    app.prepareAssistantDeliveries(runId, [
      {
        assistantIndex: 0,
        idempotencyKey: `${runId}:turn:1:delivery:final`,
        message: { type: 'assistant', content: 'first' },
        target: discord.channel('general'),
      },
      {
        assistantIndex: 1,
        idempotencyKey: `${runId}:turn:2:delivery:final`,
        message: { type: 'assistant', content: 'second' },
        target: discord.channel('general'),
      },
    ]);

    const server = PromptTrail.server({
      bundle,
      runtime: app,
      adapters: [
        {
          name: 'test-discord',
          sources: [
            {
              type: 'discord.messages',
              start() {
                order.push('source-start');
              },
            },
          ],
          deliveries: [
            {
              platform: 'discord',
              deliver(ctx) {
                order.push(`deliver:${ctx.idempotencyKey}`);
                throw new Error('delivery failed');
              },
            },
          ],
        },
      ],
    });

    await server.start();

    expect(order).toEqual([
      'deliver:discord:guild:workroom:channel:C_general:turn:1:delivery:final',
      'source-start',
    ]);
    expect(
      app.assistantDeliveryOutbox(runId).map((entry) => ({
        idempotencyKey: entry.idempotencyKey,
        status: entry.status,
      })),
    ).toEqual([
      {
        idempotencyKey:
          'discord:guild:workroom:channel:C_general:turn:1:delivery:final',
        status: 'failed',
      },
      {
        idempotencyKey:
          'discord:guild:workroom:channel:C_general:turn:2:delivery:final',
        status: 'pending',
      },
    ]);
  });
});
