import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { on, type RuntimeBinding, type TriggerEvent } from '@prompttrail/core';
import type {
  RuntimeGatewayContext,
  RuntimeGatewayEmitOptions,
} from '@prompttrail/core/runtime_server';
import { cron, cronGateway, isCronEvent, type CronEvent } from '../../index';

function cronBinding(
  schedule: string,
  name?: string,
): RuntimeBinding<CronEvent> {
  const builder = on(cron.schedule(schedule))
    .toAgent('main')
    .conversation(({ job }) => `cron:${job.id}`);
  if (name) {
    builder.name(name);
  }
  return builder.build() as unknown as RuntimeBinding<CronEvent>;
}

function count<T>(values: readonly T[], value: T): number {
  return values.filter((candidate) => candidate === value).length;
}

interface CapturedEmit {
  event: CronEvent;
  options?: RuntimeGatewayEmitOptions;
}

function fakeContext(
  bindings: readonly RuntimeBinding<CronEvent>[],
  emit: (
    event: CronEvent,
    options?: RuntimeGatewayEmitOptions,
  ) => Promise<void>,
): RuntimeGatewayContext<CronEvent> {
  return { bindings, emit };
}

function startGateway(
  adapter: ReturnType<typeof cronGateway>,
  ctx: RuntimeGatewayContext<CronEvent>,
) {
  const gateway = adapter.gateways![0]!;
  void gateway.start(ctx as RuntimeGatewayContext<TriggerEvent>);
  return gateway;
}

describe('cronGateway', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires on schedule and emits a valid CronEvent', async () => {
    const captured: CapturedEmit[] = [];
    const ctx = fakeContext(
      [cronBinding('* * * * *', 'Minute digest')],
      async (event, options) => {
        captured.push({ event, options });
      },
    );
    startGateway(cronGateway({ timezone: 'UTC' }), ctx);

    // Nothing fires before the first minute boundary.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(captured).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(captured).toHaveLength(1);

    const { event } = captured[0]!;
    expect(isCronEvent(event)).toBe(true);
    expect(event.job).toEqual({
      id: 'minute-digest',
      name: 'Minute digest',
      schedule: '* * * * *',
    });
    expect(event.firedAt).toBe('2026-01-01T00:01:00.000Z');
    expect(event.payload).toEqual({ firedAt: '2026-01-01T00:01:00.000Z' });

    // Re-arms for the following minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(captured).toHaveLength(2);
    expect(captured[1]!.event.firedAt).toBe('2026-01-01T00:02:00.000Z');
  });

  it('derives a stable job id from the schedule and index when unnamed', async () => {
    const captured: CronEvent[] = [];
    const ctx = fakeContext([cronBinding('*/2 * * * *')], async (event) => {
      captured.push(event);
    });
    startGateway(cronGateway({ timezone: 'UTC' }), ctx);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.job.id).toBe('2-0');
    expect(captured[0]!.job.name).toBe('*/2 * * * *');
  });

  it('fires multiple schedules independently', async () => {
    const fires: string[] = [];
    const ctx = fakeContext(
      [
        cronBinding('* * * * *', 'every-minute'),
        cronBinding('*/2 * * * *', 'every-two-minutes'),
      ],
      async (event) => {
        fires.push(event.job.id);
      },
    );
    startGateway(cronGateway({ timezone: 'UTC' }), ctx);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fires).toEqual(['every-minute']);

    // At the two-minute mark both schedules are due; same-tick fire order is
    // not guaranteed, so assert per-job counts instead.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count(fires, 'every-minute')).toBe(2);
    expect(count(fires, 'every-two-minutes')).toBe(1);
  });

  it('does not queue overlapping fires for the same job', async () => {
    let emitCount = 0;
    let releaseFirst: (() => void) | undefined;
    const firstEmit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const ctx = fakeContext(
      [cronBinding('* * * * *', 'slow-job')],
      async () => {
        emitCount += 1;
        if (emitCount === 1) {
          await firstEmit;
        }
      },
    );
    startGateway(cronGateway({ timezone: 'UTC' }), ctx);

    // First fire starts and stays in flight (emit awaits firstEmit).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emitCount).toBe(1);

    // Next fire is due but the previous emit has not resolved: skipped.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emitCount).toBe(1);

    // Once the first emit resolves, subsequent fires emit again.
    releaseFirst?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(emitCount).toBe(2);
  });

  it('stops all timers and does not fire after stop', async () => {
    const captured: CronEvent[] = [];
    const ctx = fakeContext(
      [cronBinding('* * * * *', 'job')],
      async (event) => {
        captured.push(event);
      },
    );
    const gateway = startGateway(cronGateway({ timezone: 'UTC' }), ctx);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(captured).toHaveLength(1);

    await gateway.stop?.();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(captured).toHaveLength(1);
  });

  it('routes emit rejections to onError', async () => {
    const errors: Array<{ error: unknown; jobId: string }> = [];
    const ctx = fakeContext([cronBinding('* * * * *', 'boom')], async () => {
      throw new Error('emit failed');
    });
    startGateway(
      cronGateway({
        timezone: 'UTC',
        onError: (error, job) => {
          errors.push({ error, jobId: job.id });
        },
      }),
      ctx,
    );

    await vi.advanceTimersByTimeAsync(60_000);

    expect(errors).toHaveLength(1);
    expect((errors[0]!.error as Error).message).toBe('emit failed');
    expect(errors[0]!.jobId).toBe('boom');

    // A failed emit clears in-flight state so the next occurrence still fires.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toHaveLength(2);
  });
});
