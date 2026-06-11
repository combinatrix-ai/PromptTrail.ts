import { describe, expect, it } from 'vitest';
import { Agent, Delivery, PromptTrail, on } from '@prompttrail/core';
import { cron } from '@prompttrail/cron';
import { mockCron } from '@prompttrail/cron/testing';
import { discord } from '../../index';
import {
  deterministicAssistant,
  mockDiscord,
  mockRuntimeFixture,
} from '../../testing';
import { assistantDeliveryKey } from '@prompttrail/core/runtime_dispatch';

function discordDeliveryTarget(channel: string, thread?: string) {
  return {
    platform: 'discord' as const,
    channel,
    thread,
  };
}

function workroomFixture() {
  const main = Agent.create('main');
  const workroom = PromptTrail.runtimeBundle({
    name: 'workroom-assistant',
    agents: { main },
    defaults: {
      checkpoint: true,
    },
    bindings: [
      on(discord.messages())
        .where(discord.notBot())
        .where(discord.inChannels(['general', 'cloud-lab', 'news']))
        .toAgent('main')
        .conversation(
          discord.sessionKey({
            groupSessionsPerUser: true,
            threadSessionsPerUser: false,
          }),
        )
        .reply(discord.replyToOriginThread())
        .toolsets([
          'web',
          'terminal',
          'file',
          'memory',
          'discord',
          'discord_admin',
          'cronjob',
          'skills',
          'delegation',
        ])
        .defaults({
          context: {
            historyBackfill: { enabled: true, limit: 50 },
          },
        })
        .behavior({
          allowedChannels: ['general', 'cloud-lab', 'news'],
          freeResponseChannels: ['general', 'cloud-lab', 'news'],
        })
        .behavior({
          threadResponseChannels: ['general', 'cloud-lab', 'news'],
          requireMention: false,
          autoThread: true,
          threadRequireMention: false,
        }),

      on(cron.schedule('every 360m'))
        .name('HN top100 digest')
        .toAgent('main')
        .conversation(({ job }) => `cron:${job.id}`)
        .input((event) => String(event.scriptOutput ?? event.job.name))
        .reply(discord.channel('news'))
        .toolsets(['web', 'terminal', 'delegation']),

      on(cron.schedule('0 20 * * *'))
        .name('Supplier earnings calendar daily update')
        .toAgent('main')
        .conversation(({ job }) => `cron:${job.id}`)
        .input('Maintain the supplier earnings calendar.')
        .reply(Delivery.origin())
        .skills(['supplier-research', 'api-change-watchers'])
        .toolsets(['terminal', 'file', 'web'])
        .workdir('/home/user/notes/Work/suppliers'),
    ],
  });

  return mockRuntimeFixture({
    bundle: workroom,
    connectors: {
      discord: mockDiscord({
        guild: 'workroom',
        channels: {
          general: { id: 'C_general', name: 'general' },
          cloudLab: { id: 'C_cloud', name: 'cloud-lab' },
          news: { id: 'C_news', name: 'news' },
          random: { id: 'C_random', name: 'random' },
        },
        users: {
          alice: { id: 'U_alice', name: 'alice' },
          bob: { id: 'U_bob', name: 'bob' },
          digestBot: { id: 'U_digest_bot', name: 'digestBot', bot: true },
        },
      }),
      cron: mockCron(),
    },
    assistant: deterministicAssistant(),
  });
}

function mentionGatedFixture() {
  const main = Agent.create('main');
  const workroom = PromptTrail.runtimeBundle({
    name: 'mention-gated',
    agents: { main },
    bindings: [
      on(discord.messages())
        .where(discord.notBot())
        .toAgent('main')
        .conversation(
          discord.sessionKey({
            groupSessionsPerUser: true,
            threadSessionsPerUser: false,
          }),
        )
        .defaults({
          delivery: discord.replyToOriginThread(),
          behavior: {
            allowedChannels: ['cloud-lab'],
            requireMention: true,
            freeResponseChannels: [],
            threadRequireMention: true,
            autoThread: false,
          },
        }),
    ],
  });

  return mockRuntimeFixture({
    bundle: workroom,
    connectors: {
      discord: mockDiscord({
        guild: 'workroom',
        channels: {
          cloudLab: { id: 'C_cloud', name: 'cloud-lab' },
          random: { id: 'C_random', name: 'random' },
        },
        users: {
          alice: { id: 'U_alice', name: 'alice' },
          digestBot: { id: 'U_digest_bot', name: 'digestBot', bot: true },
        },
      }),
      cron: mockCron(),
    },
    assistant: deterministicAssistant(),
  });
}

function threadPerUserFixture() {
  const main = Agent.create('main');
  const workroom = PromptTrail.runtimeBundle({
    name: 'thread-per-user',
    agents: { main },
    bindings: [
      on(discord.messages())
        .where(discord.notBot())
        .where(discord.inChannels(['cloud-lab']))
        .toAgent('main')
        .conversation(
          discord.sessionKey({
            groupSessionsPerUser: true,
            threadSessionsPerUser: true,
          }),
        )
        .defaults({
          delivery: discord.replyToOriginThread(),
          behavior: {
            allowedChannels: ['cloud-lab'],
            requireMention: false,
            threadRequireMention: false,
          },
        }),
    ],
  });

  return mockRuntimeFixture({
    bundle: workroom,
    connectors: {
      discord: mockDiscord({
        guild: 'workroom',
        channels: {
          cloudLab: { id: 'C_cloud', name: 'cloud-lab' },
        },
        users: {
          alice: { id: 'U_alice', name: 'alice' },
          bob: { id: 'U_bob', name: 'bob' },
        },
      }),
      cron: mockCron(),
    },
    assistant: deterministicAssistant(),
  });
}

function channelContextFixture() {
  const main = Agent.create('main');
  const workroom = PromptTrail.runtimeBundle({
    name: 'channel-context',
    agents: { main },
    bindings: [
      on(discord.messages())
        .where(discord.notBot())
        .where(discord.inChannels(['cloud-lab']))
        .toAgent('main')
        .conversation(
          discord.sessionKey({
            groupSessionsPerUser: true,
            threadSessionsPerUser: false,
          }),
        )
        .defaults({
          delivery: discord.replyToOriginThread(),
          context: {
            channelPrompts: {
              'cloud-lab': 'Infrastructure debug mode.',
              T_special: 'Incident commander mode.',
            },
            channelSkillBindings: [
              { channel: 'cloud-lab', skills: ['cloud-ops-debugging'] },
              { channel: 'T_special', skills: ['incident-review'] },
            ],
          },
          behavior: {
            allowedChannels: ['cloud-lab'],
            requireMention: false,
            threadRequireMention: false,
          },
        }),
    ],
  });

  return mockRuntimeFixture({
    bundle: workroom,
    connectors: {
      discord: mockDiscord({
        guild: 'workroom',
        channels: {
          cloudLab: { id: 'C_cloud', name: 'cloud-lab' },
        },
        users: {
          alice: { id: 'U_alice', name: 'alice' },
        },
      }),
      cron: mockCron(),
    },
    assistant: deterministicAssistant(),
  });
}

describe('runtime bindings with mock Discord and cron', () => {
  it('merges fluent binding behavior defaults across calls', () => {
    const built = on(discord.messages())
      .toAgent('main')
      .conversation(() => 'discord:test')
      .behavior({
        allowedChannels: ['general'],
        requireMention: true,
      })
      .behavior({
        requireMention: false,
        autoThread: true,
      })
      .build();

    expect(built.defaults.behavior).toEqual({
      allowedChannels: ['general'],
      requireMention: false,
      autoThread: true,
    });
  });

  it('routes an allowed Discord message to a durable agent conversation', async () => {
    const fixture = workroomFixture();

    await fixture.discord.receive({
      channel: 'cloud-lab',
      author: 'alice',
      content: 'why is the VM out of disk?',
      mentionsBot: false,
      autoThread: false,
    });

    expect(fixture.runtime.conversations()).toContainEqual({
      id: 'discord:guild:workroom:channel:C_cloud:user:U_alice',
      agent: 'main',
      status: 'done',
    });
    expect(
      fixture.runtime.inbox(
        'discord:guild:workroom:channel:C_cloud:user:U_alice',
      ),
    ).toContainEqual(
      expect.objectContaining({
        role: 'user',
        source: 'discord',
        content: 'why is the VM out of disk?',
      }),
    );
    expect(fixture.discord.deliveries()).toContainEqual(
      expect.objectContaining({
        channel: 'cloud-lab',
        content: 'reply:why is the VM out of disk?',
      }),
    );
  });

  it('drops bot-authored and disallowed Discord messages', async () => {
    const fixture = workroomFixture();

    await fixture.discord.receive({
      channel: 'cloud-lab',
      author: 'digestBot',
      content: 'automated status',
    });
    await fixture.discord.receive({
      channel: 'random',
      author: 'alice',
      content: 'hello from elsewhere',
    });

    expect(fixture.runtime.conversations()).toEqual([]);
    expect(fixture.discord.deliveries()).toEqual([]);
  });

  it('supports mention-gated Discord bindings', async () => {
    const fixture = mentionGatedFixture();

    await fixture.discord.receive({
      channel: 'cloud-lab',
      author: 'alice',
      content: 'quiet background message',
      mentionsBot: false,
    });

    expect(fixture.runtime.conversations()).toEqual([]);

    await fixture.discord.receive({
      channel: 'cloud-lab',
      author: 'alice',
      content: '@bot please inspect this',
      mentionsBot: true,
    });

    expect(fixture.runtime.conversations()).toContainEqual(
      expect.objectContaining({
        id: 'discord:guild:workroom:channel:C_cloud:user:U_alice',
      }),
    );
  });

  it('keeps parent-channel users isolated and shares thread conversations', async () => {
    const fixture = workroomFixture();

    await fixture.discord.receive({
      channel: 'cloud-lab',
      author: 'alice',
      content: 'alice task',
      autoThread: false,
    });
    await fixture.discord.receive({
      channel: 'cloud-lab',
      author: 'bob',
      content: 'bob task',
      autoThread: false,
    });

    expect(fixture.runtime.conversations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'discord:guild:workroom:channel:C_cloud:user:U_alice',
        }),
        expect.objectContaining({
          id: 'discord:guild:workroom:channel:C_cloud:user:U_bob',
        }),
      ]),
    );

    await fixture.discord.receive({
      channel: 'cloud-lab',
      thread: 'T_incident',
      author: 'alice',
      content: 'the deploy failed',
    });
    await fixture.discord.receive({
      channel: 'cloud-lab',
      thread: 'T_incident',
      author: 'bob',
      content: 'I see the same failure',
    });

    expect(
      fixture.runtime.inbox('discord:guild:workroom:thread:T_incident'),
    ).toEqual([
      expect.objectContaining({ author: 'alice' }),
      expect.objectContaining({ author: 'bob' }),
    ]);
  });

  it('can opt into per-user thread conversations', async () => {
    const fixture = threadPerUserFixture();

    await fixture.discord.receive({
      channel: 'cloud-lab',
      thread: 'T_incident',
      author: 'alice',
      content: 'the deploy failed',
    });
    await fixture.discord.receive({
      channel: 'cloud-lab',
      thread: 'T_incident',
      author: 'bob',
      content: 'I see the same failure',
    });

    expect(fixture.runtime.conversations()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'discord:guild:workroom:thread:T_incident:user:U_alice',
        }),
        expect.objectContaining({
          id: 'discord:guild:workroom:thread:T_incident:user:U_bob',
        }),
      ]),
    );
  });

  it('auto-threads parent-channel messages when configured', async () => {
    const fixture = workroomFixture();

    await fixture.discord.receive({
      channel: 'cloud-lab',
      author: 'alice',
      content: 'debug this disk issue',
    });

    const [thread] = fixture.discord.threads();
    expect(thread).toEqual({
      channel: 'cloud-lab',
      thread: 'T_cloud-lab_1',
    });
    expect(fixture.runtime.conversations()).toContainEqual(
      expect.objectContaining({
        id: 'discord:guild:workroom:thread:T_cloud-lab_1',
      }),
    );
    expect(fixture.discord.deliveries()).toContainEqual(
      expect.objectContaining({
        channel: 'cloud-lab',
        thread: 'T_cloud-lab_1',
      }),
    );
  });

  it('passes Discord binding defaults to the assistant context', async () => {
    const fixture = workroomFixture();

    await fixture.discord.receive({
      channel: 'cloud-lab',
      thread: 'T_debug',
      author: 'alice',
      content: 'inspect logs',
    });

    expect(fixture.runtime.lastAssistantObservation()).toMatchObject({
      conversationId: 'discord:guild:workroom:thread:T_debug',
      delivery: {
        platform: 'discord',
        channel: 'cloud-lab',
        thread: 'T_debug',
      },
      toolsets: [
        'web',
        'terminal',
        'file',
        'memory',
        'discord',
        'discord_admin',
        'cronjob',
        'skills',
        'delegation',
      ],
      historyBackfill: { enabled: true, limit: 50 },
    });
  });

  it('resolves channel prompts and skill bindings by thread then parent', async () => {
    const fixture = channelContextFixture();

    await fixture.discord.receive({
      channel: 'cloud-lab',
      thread: 'T_regular',
      author: 'alice',
      content: 'regular thread',
    });
    expect(fixture.runtime.lastAssistantObservation()).toMatchObject({
      channelPrompt: 'Infrastructure debug mode.',
      skills: ['cloud-ops-debugging'],
    });

    await fixture.discord.receive({
      channel: 'cloud-lab',
      thread: 'T_special',
      author: 'alice',
      content: 'special thread',
    });
    expect(fixture.runtime.lastAssistantObservation()).toMatchObject({
      channelPrompt: 'Incident commander mode.',
      skills: ['incident-review'],
    });
  });

  it('runs cron bindings through the same runtime and delivery path', async () => {
    const fixture = workroomFixture();

    await fixture.cron.tick('HN top100 digest', {
      scriptOutput: '1. Example story\n2. Another story',
    });

    expect(fixture.runtime.conversations()).toContainEqual(
      expect.objectContaining({
        id: 'cron:hn-top100-digest',
        agent: 'main',
      }),
    );
    expect(fixture.runtime.lastAssistantObservation()).toMatchObject({
      toolsets: ['web', 'terminal', 'delegation'],
      delivery: {
        platform: 'discord',
        channel: 'news',
      },
    });
    expect(fixture.discord.deliveries()).toContainEqual(
      expect.objectContaining({
        channel: 'news',
        content: 'reply:1. Example story\n2. Another story',
      }),
    );

    fixture.cron.setOrigin('Supplier earnings calendar daily update', {
      platform: 'discord',
      channel: 'cloud-lab',
      thread: 'T_supplier_research',
    });
    await fixture.cron.tick('Supplier earnings calendar daily update');

    expect(fixture.runtime.lastAssistantObservation()).toMatchObject({
      skills: ['supplier-research', 'api-change-watchers'],
      toolsets: ['terminal', 'file', 'web'],
      workdir: '/home/user/notes/Work/suppliers',
      delivery: {
        platform: 'discord',
        channel: 'cloud-lab',
        thread: 'T_supplier_research',
      },
    });
  });

  it('records unresolved origin delivery for cron jobs without origin', async () => {
    const fixture = workroomFixture();

    await fixture.cron.tick('Supplier earnings calendar daily update');

    expect(fixture.discord.deliveries()).toEqual([]);
    expect(fixture.effects.entries()).toContainEqual(
      expect.objectContaining({
        kind: 'unresolvedDelivery',
        idempotencyKey:
          'cron:supplier-earnings-calendar-daily-update:turn:1:delivery:final',
        status: 'skipped',
      }),
    );
  });

  it('does not double-deliver when a durable conversation is resumed', async () => {
    const fixture = workroomFixture();

    await fixture.discord.receive({
      channel: 'cloud-lab',
      thread: 'T_debug',
      author: 'alice',
      content: 'first',
    });
    await fixture.runtime.resume('discord:guild:workroom:thread:T_debug');

    expect(fixture.discord.deliveries()).toEqual([
      expect.objectContaining({
        channel: 'cloud-lab',
        thread: 'T_debug',
        content: 'reply:first',
      }),
    ]);
    expect(fixture.effects.entries()).toContainEqual(
      expect.objectContaining({
        kind: 'delivery',
        idempotencyKey: assistantDeliveryKey(
          'discord:guild:workroom:thread:T_debug',
          0,
          discordDeliveryTarget('cloud-lab', 'T_debug'),
        ),
        status: 'completed',
      }),
    );
  });
});
