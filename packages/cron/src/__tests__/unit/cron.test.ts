import { describe, expect, it } from 'vitest';
import { Delivery } from '@prompttrail/core';
import { cron, type CronEvent } from '../../index';

describe('cron runtime bindings', () => {
  it('creates schedule triggers with cron metadata', () => {
    const trigger = cron.schedule('0 20 * * *');

    expect(trigger.type).toBe('cron.schedule');
    expect(trigger.schedule).toBe('0 20 * * *');
  });

  it('uses the job name as default input and exposes job attrs', () => {
    const trigger = cron.schedule('every 360m');
    const event: CronEvent = {
      source: 'cron',
      job: {
        id: 'hn-top100-digest',
        name: 'HN top100 digest',
        schedule: 'every 360m',
      },
    };

    expect(trigger.defaultInput?.(event)).toBe('HN top100 digest');
    expect(trigger.eventAttrs?.(event)).toEqual({
      job: 'HN top100 digest',
      jobId: 'hn-top100-digest',
    });
  });

  it('resolves origin delivery from the cron job origin', () => {
    const trigger = cron.schedule('every 360m');
    const origin = { platform: 'test', channel: 'news' };
    const event: CronEvent = {
      source: 'cron',
      job: {
        id: 'hn-top100-digest',
        name: 'HN top100 digest',
        schedule: 'every 360m',
        origin,
      },
    };

    expect(trigger.resolveDelivery?.(Delivery.origin(), event)).toEqual(origin);
  });
});
