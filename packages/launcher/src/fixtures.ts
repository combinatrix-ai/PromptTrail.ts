import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createSession, Session } from '@prompttrail/core';
import type { StoredRun } from '@prompttrail/core';

/**
 * Replay-diff fixtures: a recorded {@link StoredRun} serialized to JSON so it
 * can live in a launcher-owned corpus directory and be replayed against a
 * candidate agent later (design §1/§5, task step 4).
 *
 * A live `StoredRun` carries an `agent` (a closure graph — NOT serializable) and
 * an `once` memo store. The fixture drops both: the AGENT is re-supplied at
 * verify time by `DeployTarget.loadAgent` (the candidate under test), and the
 * once store is irrelevant to replay/diff (the replay executor drives everything
 * from the recording + inbox and never reads `run.once`). What the fixture keeps
 * is exactly what `buildCassette` / `buildGoldenOutcome` / `replayRun` consume:
 * `recording`, `recordLevel`, `initial`/`result` sessions, `inbox`, `outbox`,
 * `services`.
 */
export interface RunFixture {
  agentName: string;
  status: StoredRun<any>['status'];
  recordLevel?: StoredRun<any>['recordLevel'];
  initial: Record<string, unknown>;
  result?: Record<string, unknown>;
  inbox: StoredRun<any>['inbox'];
  outbox: StoredRun<any>['outbox'];
  services?: StoredRun<any>['services'];
  recording: StoredRun<any>['recording'];
}

/** Serialize a recorded run to a fixture JSON string (drops `agent` + `once`). */
export function serializeRunFixture(run: StoredRun<any>): string {
  const fixture: RunFixture = {
    agentName: run.agentName,
    status: run.status,
    recordLevel: run.recordLevel,
    initial: run.initial.toJSON(),
    result: run.result ? run.result.toJSON() : undefined,
    inbox: run.inbox ?? [],
    outbox: run.outbox ?? [],
    services: run.services,
    recording: run.recording,
  };
  return JSON.stringify(fixture, null, 2);
}

/**
 * Reconstruct a {@link StoredRun} from a fixture. The `agent` field is left
 * undefined — the caller MUST attach the candidate agent (from `loadAgent`)
 * before replaying, and always passes it explicitly as `replayRun`'s `agent`
 * option so `run.agent` is never dereferenced.
 */
export function deserializeRunFixture(json: string): StoredRun<any> {
  const fixture = JSON.parse(json) as RunFixture;
  return {
    // Re-supplied by the caller via DeployTarget.loadAgent (never read here).
    agent: undefined as unknown as StoredRun<any>['agent'],
    agentName: fixture.agentName,
    status: fixture.status ?? 'done',
    recordLevel: fixture.recordLevel,
    initial: fixture.initial
      ? Session.fromJSON(fixture.initial)
      : createSession(),
    result: fixture.result ? Session.fromJSON(fixture.result) : undefined,
    // Replay/diff never touch `once`; a fresh empty memo satisfies the type.
    once: { run: new Map(), conversation: new Map() },
    outbox: fixture.outbox ?? [],
    inbox: fixture.inbox ?? [],
    services: fixture.services,
    recording: fixture.recording,
  };
}

/** One loaded fixture: its file stem (used as the diff label) + the run. */
export interface LoadedFixture {
  name: string;
  run: StoredRun<any>;
}

/**
 * Read every `*.json` fixture in `runsDir` (sorted by name for a stable corpus
 * order) and reconstruct each into a {@link StoredRun}. A missing directory
 * yields an empty corpus.
 */
export async function readRunFixtures(
  runsDir: string,
): Promise<LoadedFixture[]> {
  let names: string[];
  try {
    names = await fs.readdir(runsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const jsonFiles = names.filter((name) => name.endsWith('.json')).sort();
  const fixtures: LoadedFixture[] = [];
  for (const file of jsonFiles) {
    const raw = await fs.readFile(join(runsDir, file), 'utf8');
    fixtures.push({
      name: file.replace(/\.json$/, ''),
      run: deserializeRunFixture(raw),
    });
  }
  return fixtures;
}
