import type { DeliveryTarget } from '@prompttrail/core';

type CronTickHandler = (
  name: string,
  payload?: Record<string, unknown>,
) => Promise<void>;

export class MockCronConnector {
  private tickHandler?: CronTickHandler;
  private readonly origins = new Map<string, DeliveryTarget>();
  private readonly runNames: string[] = [];

  attach(handler: CronTickHandler): void {
    this.tickHandler = handler;
  }

  async tick(name: string, payload?: Record<string, unknown>): Promise<void> {
    if (!this.tickHandler) {
      throw new Error('Mock Cron connector is not attached to a fixture');
    }
    this.runNames.push(name);
    await this.tickHandler(name, payload);
  }

  setOrigin(name: string, origin: DeliveryTarget): void {
    this.origins.set(name, origin);
  }

  origin(name: string): DeliveryTarget | undefined {
    return this.origins.get(name);
  }

  runs(): string[] {
    return [...this.runNames];
  }
}

export function mockCron(): MockCronConnector {
  return new MockCronConnector();
}
