import { describe, expect, it } from 'vitest';
import {
  discordProgressObserver,
  type ConcreteDiscordDeliveryTarget,
} from '../../index';

describe('discord runtime adapter', () => {
  it('renders tool progress events to the Discord delivery target', async () => {
    const sent: string[] = [];
    const client = fakeDiscordClient(sent);
    const observer = discordProgressObserver(client);
    const delivery: ConcreteDiscordDeliveryTarget = {
      platform: 'discord',
      channel: 'general',
    };

    await observer.handle(
      {
        id: 'event-1',
        type: 'tool.started',
        at: '2026-01-01T00:00:00.000Z',
        seq: 1,
        name: 'lookup',
        toolCallId: 'call-1',
      },
      { delivery },
    );
    await observer.handle(
      {
        id: 'event-2',
        type: 'tool.completed',
        at: '2026-01-01T00:00:00.000Z',
        seq: 2,
        name: 'lookup',
        toolCallId: 'call-1',
      },
      { delivery },
    );

    expect(sent).toEqual([
      'general:Running lookup...',
      'general:Completed lookup.',
    ]);
  });

  it('allows custom Discord progress messages and skips undefined messages', async () => {
    const sent: string[] = [];
    const client = fakeDiscordClient(sent);
    const observer = discordProgressObserver(client, {
      format: (event) =>
        event.type === 'tool.started'
          ? `custom:${event.toolName}:${event.toolCallId}`
          : undefined,
    });

    await observer.handle(
      {
        id: 'event-1',
        type: 'tool.started',
        at: '2026-01-01T00:00:00.000Z',
        seq: 1,
        name: 'write',
        toolCallId: 'call-2',
      },
      { delivery: { platform: 'discord', channel: 'general' } },
    );
    await observer.handle(
      {
        id: 'event-2',
        type: 'tool.completed',
        at: '2026-01-01T00:00:00.000Z',
        seq: 2,
        name: 'write',
        toolCallId: 'call-2',
      },
      { delivery: { platform: 'discord', channel: 'general' } },
    );

    expect(sent).toEqual(['general:custom:write:call-2']);
  });

  it('deduplicates Discord progress writes by event key and target', async () => {
    const sent: string[] = [];
    const client = fakeDiscordClient(sent);
    const observer = discordProgressObserver(client);
    const event = {
      id: 'event-1',
      type: 'tool.started' as const,
      at: '2026-01-01T00:00:00.000Z',
      seq: 1,
      name: 'lookup',
      toolCallId: 'call-1',
      idempotencyKey: 'run-1:tool:call-1:started',
    };

    await observer.handle(event, {
      delivery: { platform: 'discord', channel: 'general' },
    });
    await observer.handle(event, {
      delivery: { platform: 'discord', channel: 'general' },
    });
    await observer.handle(event, {
      delivery: { platform: 'discord', channel: 'alerts' },
    });

    expect(sent).toEqual([
      'general:Running lookup...',
      'alerts:Running lookup...',
    ]);
  });

  it('bounds the default Discord progress binding cache', async () => {
    const sent: string[] = [];
    const client = fakeDiscordClient(sent);
    const observer = discordProgressObserver(client, {
      maxBindingEntries: 1,
    });
    const event = {
      id: 'event-1',
      type: 'tool.started' as const,
      at: '2026-01-01T00:00:00.000Z',
      seq: 1,
      name: 'lookup',
      toolCallId: 'call-1',
      idempotencyKey: 'run-1:tool:call-1:started',
    };

    await observer.handle(event, {
      delivery: { platform: 'discord', channel: 'general' },
    });
    await observer.handle(event, {
      delivery: { platform: 'discord', channel: 'alerts' },
    });
    await observer.handle(event, {
      delivery: { platform: 'discord', channel: 'general' },
    });

    expect(sent).toEqual([
      'general:Running lookup...',
      'alerts:Running lookup...',
      'general:Running lookup...',
    ]);
  });
});

function fakeDiscordClient(sent: string[]) {
  const channels = ['general', 'alerts'].map((name) => ({
    id: name,
    name,
    isSendable: () => true,
    send: async (content: string) => {
      sent.push(`${name}:${content}`);
      return { id: `${name}:${sent.length}` };
    },
  }));
  return {
    channels: {
      cache: {
        find: (
          predicate: (candidate: { id: string; name: string }) => boolean,
        ) => channels.find((channel) => predicate(channel)),
      },
      fetch: async (id: string) =>
        channels.find((channel) => channel.id === id),
    },
  } as never;
}
