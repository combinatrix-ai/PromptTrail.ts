import { Cron } from 'croner';
import type {
  DeliveryTarget,
  RuntimeBinding,
  Trigger,
  TriggerEvent,
} from '@prompttrail/core';
import type {
  RuntimeAdapter,
  RuntimeGatewayContext,
} from '@prompttrail/core/runtime_server';

export interface CronEvent extends TriggerEvent {
  source: 'cron';
  job: {
    id: string;
    name: string;
    schedule: string;
    origin?: DeliveryTarget;
  };
  /** ISO timestamp of the moment the scheduler fired this occurrence. */
  firedAt?: string;
  payload?: Record<string, unknown>;
}

export interface CronTrigger extends Trigger<CronEvent> {
  schedule: string;
}

export const cron = {
  schedule(schedule: string): CronTrigger {
    return {
      type: 'cron.schedule',
      schedule,
      defaultInput: (event) => event.job.name,
      eventAttrs: (event) => ({
        job: event.job.name,
        jobId: event.job.id,
      }),
      resolveDelivery: (delivery, event) =>
        delivery.platform === 'origin' ? event.job.origin : delivery,
    };
  },
};

export function isCronEvent(event: TriggerEvent): event is CronEvent {
  const job = event.job as { id?: unknown; name?: unknown } | undefined;
  return (
    event.source === 'cron' &&
    typeof job === 'object' &&
    job !== null &&
    typeof job.id === 'string' &&
    typeof job.name === 'string'
  );
}

/** Stable job identity derived from a cron binding. */
export interface CronJob {
  id: string;
  name: string;
  schedule: string;
}

export interface CronGatewayOptions {
  /**
   * IANA timezone applied when computing each schedule's next run. Defaults to
   * the host's local timezone.
   */
  timezone?: string;
  /** Invoked when a fired job's dispatch (ctx.emit) rejects. */
  onError?: (error: unknown, job: CronJob) => void | Promise<void>;
}

const CRON_TRIGGER_TYPE = 'cron.schedule';

/**
 * Real cron scheduler adapter. Discovers schedules declared on cron bindings
 * (trigger type 'cron.schedule') via the gateway context, arms one timer per
 * schedule, and emits a CronEvent on each fire.
 *
 * Overlap policy: fires are NOT queued. If a job's previous emit is still
 * awaiting when its next fire is due, that fire is skipped; the following
 * occurrence is still armed.
 *
 * Relationship to durable timers (roadmap §3 — "timers should unify with the
 * cron trigger plumbing rather than grow a second scheduler"): the unification
 * is the shared SCHEDULING DISCIPLINE, not a merged code path. Both this gateway
 * and the core durable-timer sweep (`PromptTrailApp`, packages/core/src/durable.ts)
 * follow the same rules — an injectable clock, self-driven `setTimeout`s that
 * compute the next fire and re-arm after each occurrence, skip-don't-queue
 * re-entrancy, and cleanup on stop — so neither grows into a second ad-hoc
 * scheduler. They stay separate deliberately: cron is a stateless wall-clock
 * TRIGGER that starts runs, while durable timers are per-run WAKE-UPS whose
 * wake-at is persisted and re-armed on boot. The intended future convergence is
 * a cron occurrence that arms a durable timer (a scheduled run that survives a
 * restart between fire and delivery); that reuse lives on top of this same
 * discipline, not by moving the durable-timer sweep into this package.
 */
export function cronGateway(options: CronGatewayOptions = {}): RuntimeAdapter {
  let scheduler: CronScheduler | undefined;
  return {
    name: 'cron',
    gateways: [
      {
        type: CRON_TRIGGER_TYPE,
        start(ctx: RuntimeGatewayContext<CronEvent>) {
          scheduler = new CronScheduler(ctx, options);
          scheduler.start();
        },
        stop() {
          scheduler?.stop();
          scheduler = undefined;
        },
      },
    ],
  };
}

class CronScheduler {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private stopped = false;

  constructor(
    private readonly ctx: RuntimeGatewayContext<CronEvent>,
    private readonly options: CronGatewayOptions,
  ) {}

  start(): void {
    this.ctx.bindings.forEach((binding, index) => {
      const job = deriveCronJob(binding, index);
      if (!job) {
        return;
      }
      this.arm(job);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private arm(job: CronJob): void {
    if (this.stopped) {
      return;
    }
    const pattern = new Cron(job.schedule, { timezone: this.options.timezone });
    const scheduleNext = () => {
      if (this.stopped) {
        return;
      }
      const next = pattern.nextRun();
      if (!next) {
        return;
      }
      const delay = Math.max(0, next.getTime() - Date.now());
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.fire(job);
        scheduleNext();
      }, delay);
      this.timers.add(timer);
    };
    scheduleNext();
  }

  private async fire(job: CronJob): Promise<void> {
    if (this.stopped) {
      return;
    }
    // Overlap policy: skip (do not queue) while the previous emit is in flight.
    if (this.inFlight.has(job.id)) {
      return;
    }
    this.inFlight.add(job.id);
    const firedAt = new Date().toISOString();
    const event: CronEvent = {
      source: 'cron',
      job: { id: job.id, name: job.name, schedule: job.schedule },
      firedAt,
      payload: { firedAt },
    };
    try {
      await this.ctx.emit(event);
    } catch (error) {
      await this.options.onError?.(error, job);
    } finally {
      this.inFlight.delete(job.id);
    }
  }
}

function deriveCronJob(
  binding: RuntimeBinding<CronEvent>,
  index: number,
): CronJob | undefined {
  const schedule = (binding.trigger as CronTrigger).schedule;
  if (!schedule) {
    return undefined;
  }
  const name = binding.name ?? schedule;
  const id = binding.name
    ? slug(binding.name)
    : `${slug(schedule) || 'cron'}-${index}`;
  return { id, name, schedule };
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
