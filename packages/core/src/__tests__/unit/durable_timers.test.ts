import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptTrail, memoryStore } from '../../durable';
import { parseDuration } from '../../duration';
import { Source } from '../../source';
import { Agent } from '../../templates';

const HOUR = 3_600_000;

function reminderAgent() {
  // A minimal durable-reminder shape: sleep, then emit a fixed reply. Literal
  // sources keep it deterministic (no real model call).
  return Agent.create('reminder')
    .sleep('wait', '2h')
    .assistant('done', Source.literal('reminder fired'));
}

describe('durable timers — Agent.sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('suspends with the timer persisted, then fires and completes on advance', async () => {
    const store = memoryStore();
    const app = PromptTrail.app({
      agents: { reminder: reminderAgent() },
      store,
    });
    await app.start();

    const base = Date.now();
    const suspended = await app.run({
      agent: 'reminder',
      runId: 'r-sleep',
      checkpoint: true,
    });
    expect(suspended.status).toBe('suspended');
    expect(suspended.awaiting).toBe('reminder/wait');

    // Timer persisted, pending, with wakeAt = now + 2h.
    const armed = await store.get('r-sleep');
    expect(armed!.timers).toHaveLength(1);
    expect(armed!.timers![0].id).toBe('reminder/wait');
    expect(armed!.timers![0].wakeAt).toBe(base + 2 * HOUR);
    expect(armed!.timers![0].firedAt).toBeUndefined();

    // Not yet due: advancing less than the duration does not fire.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect((await store.get('r-sleep'))!.status).toBe('open');

    // Crossing wakeAt fires the sweep, which resumes the run past the sleep.
    await vi.advanceTimersByTimeAsync(HOUR);
    const done = await store.get('r-sleep');
    expect(done!.status).toBe('done');
    expect(done!.timers![0].firedAt).toBeDefined();
    expect(done!.result!.messages.map((message) => message.content)).toContain(
      'reminder fired',
    );

    await app.stop();
  });

  it('a fresh app on the same store re-arms a pending timer and fires it (cold restart)', async () => {
    const store = memoryStore();
    const app = PromptTrail.app({
      agents: { reminder: reminderAgent() },
      store,
    });
    await app.start();
    await app.run({ agent: 'reminder', runId: 'r-cold', checkpoint: true });
    // Simulate a restart: stop the first app (its sweep timer is cleared) with
    // the timer still pending.
    await app.stop();
    expect((await store.get('r-cold'))!.timers![0].firedAt).toBeUndefined();

    const restarted = PromptTrail.app({
      agents: { reminder: reminderAgent() },
      store,
    });
    // Boot scan re-arms the pending (future) timer; advancing time fires it.
    await restarted.start();
    expect((await store.get('r-cold'))!.status).toBe('open');
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    const done = await store.get('r-cold');
    expect(done!.status).toBe('done');
    expect(done!.timers![0].firedAt).toBeDefined();
    await restarted.stop();
  });

  it('fires a past-due timer immediately on start (cold-boot fire)', async () => {
    const store = memoryStore();
    const app = PromptTrail.app({
      agents: { reminder: reminderAgent() },
      store,
    });
    await app.start();
    await app.run({ agent: 'reminder', runId: 'r-due', checkpoint: true });
    await app.stop();

    // Advance the wall clock past wakeAt WITHOUT running the (now-cleared) sweep.
    vi.setSystemTime(Date.now() + 3 * HOUR);

    const restarted = PromptTrail.app({
      agents: { reminder: reminderAgent() },
      store,
    });
    // The boot sweep sees wakeAt <= now and fires synchronously during start().
    await restarted.start();

    const done = await store.get('r-due');
    expect(done!.status).toBe('done');
    expect(done!.timers![0].firedAt).toBeDefined();
    await restarted.stop();
  });

  it('does not re-arm after firing — a fired timer stays single-shot', async () => {
    const store = memoryStore();
    const app = PromptTrail.app({
      agents: { reminder: reminderAgent() },
      store,
    });
    await app.start();
    await app.run({ agent: 'reminder', runId: 'r-once', checkpoint: true });
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    const done = await store.get('r-once');
    expect(done!.status).toBe('done');
    expect(done!.timers).toHaveLength(1);
    const firedAt = done!.timers![0].firedAt;
    expect(firedAt).toBeDefined();

    // Resuming a completed sleep run must not re-arm the timer or change firedAt,
    // and it must not spin (advancing time fires nothing new).
    const resumed = await app.resume('r-once');
    expect(resumed.status).toBe('done');
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    const after = await store.get('r-once');
    expect(after!.timers).toHaveLength(1);
    expect(after!.timers![0].firedAt).toBe(firedAt);

    await app.stop();
  });

  it('fires through the fenced store under lease mode', async () => {
    // With lease mode on, every store mutation carries the lease fencing token.
    // If the timer-firing writes (upsertTimer + the resume's checkpoint writes)
    // did NOT present the fence, the FencedRunStore would reject them with a
    // FencingTokenError and the run would never complete — so a clean fire+
    // complete under an active lease proves the firing path is fenced.
    const store = memoryStore();
    const app = PromptTrail.app({
      agents: { reminder: reminderAgent() },
      store,
      lease: true,
    });
    await app.start();
    expect(app.lease).toBeDefined();

    await app.run({ agent: 'reminder', runId: 'r-fenced', checkpoint: true });
    await vi.advanceTimersByTimeAsync(2 * HOUR);

    const done = await store.get('r-fenced');
    expect(done!.status).toBe('done');
    expect(done!.timers![0].firedAt).toBeDefined();
    await app.stop();
  });
});

describe('parseDuration', () => {
  it('passes through non-negative numbers as milliseconds', () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(1500)).toBe(1500);
  });

  it('parses single-unit strings', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('1w')).toBe(604_800_000);
  });

  it('parses compound strings and tolerates whitespace', () => {
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1h 30m')).toBe(5_400_000);
    expect(parseDuration('2d12h')).toBe(216_000_000);
  });

  it('rejects invalid input', () => {
    expect(() => parseDuration('')).toThrow();
    expect(() => parseDuration('7dd')).toThrow();
    expect(() => parseDuration('abc')).toThrow();
    expect(() => parseDuration('10y')).toThrow();
    expect(() => parseDuration(-5)).toThrow();
    expect(() => parseDuration(Number.NaN)).toThrow();
  });
});
