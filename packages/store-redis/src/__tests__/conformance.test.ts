import { Agent } from '@prompttrail/core';
import { runDurableRunStoreConformance } from '@prompttrail/store-conformance';
import RedisMock from 'ioredis-mock';
import { RedisRunStore } from '../index.js';

/**
 * ioredis-mock quirk: the in-memory backing store is shared across all
 * RedisMock() instances created with the same constructor (they share a
 * module-level Map). To avoid cross-suite key collisions we use a unique
 * keyPrefix per suite run. The reopen case passes a NEW RedisMock() client
 * with the SAME keyPrefix — it will see the same keys because ioredis-mock's
 * backing is module-global (not per-instance).
 */
let suiteCounter = 0;

function makeAgents(): Record<string, Agent> {
  return {
    main: Agent.create('main').assistant('reply'),
  };
}

runDurableRunStoreConformance({
  name: 'RedisRunStore (ioredis-mock)',
  makeAgents,
  open: async (agents, { now }) => {
    const keyPrefix = `test-suite-${++suiteCounter}-${Date.now()}`;
    const client = new RedisMock();

    const store = await RedisRunStore.open({ client, agents, keyPrefix, now });

    return {
      store,
      reopen: async () => {
        // Open a fresh RedisRunStore with a NEW RedisMock() client but the
        // SAME keyPrefix. Because ioredis-mock shares a module-level backing
        // store across all instances, the new client sees all keys written by
        // the original client — this makes the durability case (12) meaningful.
        const freshClient = new RedisMock();
        return RedisRunStore.open({
          client: freshClient,
          agents,
          keyPrefix,
          now,
        });
      },
      dispose: async () => {
        try {
          await store.close();
        } catch {
          // ignore errors on double-close or already-disconnected client
        }
      },
    };
  },
});
