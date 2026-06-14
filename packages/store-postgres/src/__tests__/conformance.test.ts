import { Agent } from '@prompttrail/core';
import { runDurableRunStoreConformance } from '@prompttrail/store-conformance';
import { newDb } from 'pg-mem';
import { PostgresRunStore } from '../index.js';

function makeAgents(): Record<string, Agent> {
  return {
    main: Agent.create('main').assistant('reply'),
  };
}

runDurableRunStoreConformance({
  name: 'PostgresRunStore (pg-mem)',
  makeAgents,
  open: async (agents) => {
    // Create a pg-mem in-memory Postgres instance.
    // pg-mem persists data within the same `mem` object across Pool instances.
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    const pool = new Pool();

    const store = await PostgresRunStore.open({ pool, agents });

    return {
      store,
      reopen: async () => {
        // Close the current pool and open a fresh one over the same mem db.
        // The schema and data remain because `mem` (and its backing tables) is
        // shared — this makes the durability case meaningful.
        await pool.end();
        const { Pool: Pool2 } = mem.adapters.createPg();
        const pool2 = new Pool2();
        // Open without recreating schema (CREATE TABLE IF NOT EXISTS is safe)
        return PostgresRunStore.open({ pool: pool2, agents });
      },
      dispose: async () => {
        try {
          await pool.end();
        } catch {
          // ignore double-close
        }
      },
    };
  },
});
