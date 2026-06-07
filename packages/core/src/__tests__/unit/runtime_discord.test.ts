import { describe, expect, it } from 'vitest';
import { discordProgressObserver } from '../../runtime_discord';
import type { ConcreteDiscordDeliveryTarget } from '../../runtime_bindings';

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

    expect(sent).toEqual(['Running lookup...', 'Completed lookup.']);
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

    expect(sent).toEqual(['custom:write:call-2']);
  });
});

function fakeDiscordClient(sent: string[]) {
  const channel = {
    id: 'general',
    name: 'general',
    isSendable: () => true,
    send: async (content: string) => {
      sent.push(content);
    },
  };
  return {
    channels: {
      cache: {
        find: (
          predicate: (candidate: { id: string; name: string }) => boolean,
        ) => (predicate(channel) ? channel : undefined),
      },
      fetch: async () => channel,
    },
  } as never;
}
