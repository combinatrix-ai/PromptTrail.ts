import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, PromptTrail, memoryStore } from '@prompttrail/core';
import { cron, cronGateway } from '../../index';

describe('cronGateway end-to-end', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a durable agent when a cron schedule fires', async () => {
    const runs: string[] = [];
    const main = Agent.create('main')
      .inbox('inbound')
      .assistant('reply', (session) => {
        const content = session.getLastMessage()?.content ?? '';
        runs.push(content);
        return `reply:${content}`;
      });

    const store = memoryStore();
    const app = PromptTrail.app({
      store,
      agents: { main },
    })
      .adapter(cronGateway({ timezone: 'UTC' }))
      .on(cron.schedule('* * * * *'), (binding) =>
        binding
          .name('minute digest')
          .toAgent('main')
          .conversation(({ job }) => `cron:${job.id}`)
          .input('run the digest'),
      );

    await app.start();

    // No fire before the first minute boundary.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runs).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(runs).toEqual(['run the digest']);

    const run = await store.get('cron:minute-digest');
    expect(run?.status).toBe('done');
    expect(run?.result?.messages.map((message) => message.content)).toContain(
      'reply:run the digest',
    );

    await app.stop();

    // After stop, further time does not trigger new runs.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toEqual(['run the digest']);
  });
});
