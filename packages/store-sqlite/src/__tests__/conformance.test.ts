import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Agent, MemoryRunStore } from '@prompttrail/core';
import { runDurableRunStoreConformance } from '@prompttrail/store-conformance';
import { SqliteRunStore } from '../index.js';

function makeAgents(): Record<string, Agent> {
  return {
    main: Agent.create('main').assistant('reply'),
  };
}

// Run conformance against SqliteRunStore (with durability/reopen)
runDurableRunStoreConformance({
  name: 'SqliteRunStore',
  makeAgents,
  open: async (agents, { now }) => {
    const dbPath = join(tmpdir(), `prompttrail-test-${randomUUID()}.db`);
    const store = new SqliteRunStore({ path: dbPath, agents, now });
    return {
      store,
      reopen: async () => {
        // Close the current store and open a fresh one over the same file
        store.close();
        return new SqliteRunStore({ path: dbPath, agents, now });
      },
      dispose: async () => {
        store.close();
        await rm(dbPath, { force: true });
      },
    };
  },
});

// Run conformance against MemoryRunStore (no reopen/durability case)
runDurableRunStoreConformance({
  name: 'MemoryRunStore',
  makeAgents,
  open: async (_agents, { now }) => {
    return {
      store: new MemoryRunStore({ now }),
      // No reopen — durability case will be skipped
    };
  },
});
