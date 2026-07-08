// Scripted server child for the launcher blue/green tests.
//
// This stands in for a real deployable (e.g. claw). It is deliberately tiny: it
// only participates in the single-writer lease and demonstrates fencing, because
// that is all the launcher orchestration needs from a served process. The store
// family is the cross-process IPC (design task step 4): both children open their
// OWN SqliteRunStore on the SAME db file, so the lease row is shared.
//
// Symmetric warm-standby protocol (so rollback keeps blue warm):
//   - I SERVE while I hold the lease (holder === me): I (re)acquire to learn my
//     fencing token and heartbeat it.
//   - When someone else holds the lease I drop to STANDBY. On the transition out
//     of serving I fire ONE "late write" with my now-stale token to prove the
//     store fences it out (the B4 guarantee) and record the outcome.
//   - I re-take the lease the instant it is handed (back) to me (holder === me).
//   - blue takes the lease on startup (it is the current deployment); green
//     starts in standby and only serves once the launcher hands it the lease.
//
// It imports the BUILT @prompttrail/store-sqlite (a spawned process gets no
// vitest source aliases), so the workspace must be built — which the launcher's
// verify step ensures.
import { writeFileSync, renameSync } from 'node:fs';
import { SqliteRunStore } from '@prompttrail/store-sqlite';

const holder = process.env.LAUNCHER_LEASE_HOLDER;
const role = process.env.LAUNCHER_ROLE;
const ttlMs = Number(process.env.LAUNCHER_TTL_MS ?? '30000');
const dbPath = process.env.LAUNCHER_DB_PATH;
const readyFile = process.env.LAUNCHER_READY_FILE;
const statusFile = process.env.LAUNCHER_STATUS_FILE;
const pollMs = Number(process.env.LAUNCHER_POLL_MS ?? '50');

if (!holder || !dbPath || !statusFile) {
  console.error('server-child: missing required env');
  process.exit(2);
}

const store = new SqliteRunStore({ path: dbPath, agents: {} });

let token; // fencing token I currently hold, if serving
let serving = false;
let everServed = false;
let lateWriteRejected = null; // null=untested, true=fenced out, false=leaked

function writeStatus() {
  const tmp = `${statusFile}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({
      holder,
      role,
      serving,
      token: token ?? null,
      lateWriteRejected,
      pid: process.pid,
      at: Date.now(),
    }),
  );
  renameSync(tmp, statusFile);
}

async function fenceProbe(staleToken) {
  // Present a stale fencing token to a mutating store method. `patch` runs the
  // fence check FIRST, so a stale token throws FencingTokenError before touching
  // any run — a clean, side-effect-free demonstration of the drained-blue guard.
  try {
    await store.patch('launcher-fence-probe', { status: 'open' }, staleToken);
    lateWriteRejected = false;
  } catch (error) {
    lateWriteRejected = error && error.name === 'FencingTokenError';
  }
}

async function tick() {
  let current;
  try {
    current = await store.lease.current();
  } catch {
    return;
  }

  if (current && current.holder === holder) {
    // I am (or have just been handed) the holder: (re)acquire renews and keeps
    // the token, teaching me my fence so my writes pass and blue's don't.
    const state = await store.lease.acquire(holder, ttlMs);
    if (state) {
      token = state.token;
      serving = true;
      everServed = true;
    }
  } else if (!current) {
    // Lease is free (nobody active).
    if (role === 'blue' && !everServed) {
      // Blue is the current deployment: take the lease on startup.
      const state = await store.lease.acquire(holder, ttlMs);
      if (state) {
        token = state.token;
        serving = true;
        everServed = true;
      }
    } else if (serving) {
      // I was serving and my lease lapsed: re-take it (keeps me warm).
      const state = await store.lease.acquire(holder, ttlMs);
      if (state) {
        token = state.token;
      }
    }
    // Green pre-cutover with a free lease: stay in standby, never steal it.
  } else {
    // Someone else holds the lease.
    if (serving) {
      // I just lost it. Prove my stale token is fenced out, then stand by warm.
      serving = false;
      const stale = token;
      if (stale !== undefined) {
        await fenceProbe(stale);
      }
    }
  }

  writeStatus();
}

let looping = false;
const timer = setInterval(() => {
  if (looping) return;
  looping = true;
  void tick().finally(() => {
    looping = false;
  });
}, pollMs);

function shutdown() {
  clearInterval(timer);
  try {
    writeStatus();
  } catch {
    // ignore
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Warm + connected: run one tick (blue grabs the lease here) then signal ready.
await tick();
if (readyFile) {
  writeFileSync(readyFile, String(process.pid));
}
