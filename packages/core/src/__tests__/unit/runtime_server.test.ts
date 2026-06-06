import { describe, expect, it } from 'vitest';
import { PromptTrail, agent, memoryStore } from '../../durable';
import { bind, discord, type DiscordMessageEvent } from '../../runtime_bindings';
import {
  type RuntimeAdapter,
  type RuntimeSourceContext,
} from '../../runtime_server';

describe('RuntimeServer', () => {
  it('routes adapter source events through bindings and delivery drivers', async () => {
    let emit: RuntimeSourceContext<DiscordMessageEvent>['emit'] | undefined;
    const deliveries: string[] = [];
    const activityEvents: string[] = [];
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
  });
});
