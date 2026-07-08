import { Agent } from '@prompttrail/core';
import { runDurableRunStoreConformance } from '@prompttrail/store-conformance';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LibsqlRunStore } from '../index.js';

function makeAgents(): Record<string, Agent> {
  return {
    main: Agent.create('main').assistant('reply'),
  };
}

runDurableRunStoreConformance({
  name: 'LibsqlRunStore (file-backed sqlite)',
  makeAgents,
  open: async (agents, { now }) => {
    // Use a temp directory with a unique file so that:
    // - The durability/reopen case (case 12) can open a NEW client over the
    //   SAME file and see the previously written data.
    // - :memory: cannot be used because each createClient() call gets its own
    //   in-process database that does not share state with any other client.
    const dir = mkdtempSync(join(tmpdir(), 'prompttrail-libsql-'));
    const dbPath = join(dir, 'test.db');
    const url = `file:${dbPath}`;

    const store = await LibsqlRunStore.open({ url, agents, now });

    return {
      store,
      reopen: async () => {
        // Close the current client and open a brand-new one over the same file.
        // The previously written rows remain on disk — this validates durability.
        await store.close();
        return LibsqlRunStore.open({ url, agents, now });
      },
      dispose: async () => {
        try {
          await store.close();
        } catch {
          // ignore double-close errors
        }
        // Remove the database file and any SQLite WAL/SHM sidecar files.
        for (const suffix of ['', '-wal', '-shm']) {
          const f = `${dbPath}${suffix}`;
          if (existsSync(f)) {
            rmSync(f);
          }
        }
        // Remove the temp directory itself.
        try {
          rmSync(dir, { recursive: true });
        } catch {
          // ignore if already gone
        }
      },
    };
  },
});
