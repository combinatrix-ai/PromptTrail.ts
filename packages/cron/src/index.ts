import type { DeliveryTarget, Trigger, TriggerEvent } from '@prompttrail/core';

export interface CronEvent extends TriggerEvent {
  source: 'cron';
  job: {
    id: string;
    name: string;
    schedule: string;
    origin?: DeliveryTarget;
  };
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
