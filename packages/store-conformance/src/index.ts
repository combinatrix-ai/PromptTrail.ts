import { describe, it, expect, afterEach } from 'vitest';
import {
  Agent,
  FencingTokenError,
  Session,
  type DurableRunStore,
  type StoredRun,
  type SessionCheckpointDelta,
  type Inbound,
  type AssistantDeliveryOutboxEntry,
  type DurableTimer,
  type RecordLevel,
  type RunRecordEntry,
} from '@prompttrail/core';

/**
 * Options threaded into a backend's `open` so lease TTL/expiry can be exercised
 * deterministically. The backend MUST wire `now` into its store construction
 * (both the initial store and any `reopen`) so the lease uses the injected
 * clock instead of the wall clock — the lease cases advance it without
 * sleeping.
 */
export interface ConformanceOpenOptions {
  now: () => number;
}

export interface ConformanceSpec {
  name: string;
  makeAgents: () => Record<string, Agent>;
  open: (
    agents: Record<string, Agent>,
    options: ConformanceOpenOptions,
  ) => Promise<{
    store: DurableRunStore;
    reopen?: () => Promise<DurableRunStore>;
    dispose?: () => Promise<void>;
  }>;
}

/** Base value the injected clock resets to at the start of every test. */
const BASE_NOW = 1_000_000;
/** Lease TTL used throughout the lease conformance cases. */
const LEASE_TTL = 10_000;
const HOLDER_A = 'holder-a';
const HOLDER_B = 'holder-b';

function makeOnce(): StoredRun<any>['once'] {
  return { run: new Map(), conversation: new Map() };
}

function makeInitialRun(
  agent: Agent,
  agentName: string,
  overrides: Partial<StoredRun<any>> = {},
): StoredRun<any> {
  return {
    agent,
    agentName,
    initial: Session.create(),
    status: 'open',
    once: makeOnce(),
    outbox: [],
    inbox: [],
    providerSessions: {},
    ...overrides,
  };
}

export function runDurableRunStoreConformance(spec: ConformanceSpec): void {
  describe(spec.name, () => {
    let store: DurableRunStore;
    let reopen: (() => Promise<DurableRunStore>) | undefined;
    let dispose: (() => Promise<void>) | undefined;
    let agents: Record<string, Agent>;
    // Injected lease clock. Reset per test in openStore; lease cases advance it
    // via setNow rather than sleeping.
    let clock = BASE_NOW;
    const setNow = (value: number) => {
      clock = value;
    };

    afterEach(async () => {
      if (dispose) {
        await dispose();
      }
    });

    async function openStore() {
      clock = BASE_NOW;
      agents = spec.makeAgents();
      const result = await spec.open(agents, { now: () => clock });
      store = result.store;
      reopen = result.reopen;
      dispose = result.dispose;
    }

    // Case 1: create + get round-trips a StoredRun
    it('case 1: create + get round-trips a StoredRun', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-roundtrip-1';
      const initial = Session.create();
      const run = makeInitialRun(agent, agentName, { initial });

      await store.create(runId, run);
      const retrieved = await store.get(runId);

      expect(retrieved).toBeDefined();
      expect(retrieved!.agentName).toBe(agentName);
      expect(retrieved!.status).toBe('open');
      expect(retrieved!.initial.messages).toHaveLength(0);
    });

    // Case 2: has() is false before create, true after, false after delete
    it('case 2: has() lifecycle', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-has-2';

      expect(await store.has(runId)).toBe(false);
      await store.create(runId, makeInitialRun(agent, agentName));
      expect(await store.has(runId)).toBe(true);
      await store.delete(runId);
      expect(await store.has(runId)).toBe(false);
    });

    // Case 3: appendSessionDelta chains — two contiguous deltas, merged messages + vars, append-only
    it('case 3: appendSessionDelta chains two deltas, merged result', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-delta-3';
      await store.create(runId, makeInitialRun(agent, agentName));

      const delta1: SessionCheckpointDelta = {
        fromVersion: 0,
        toVersion: 1,
        appendedMessages: [{ type: 'user', content: 'hello' }],
        varsSet: { foo: 'bar' },
      };
      await store.appendSessionDelta(runId, delta1);

      const delta2: SessionCheckpointDelta = {
        fromVersion: 1,
        toVersion: 2,
        appendedMessages: [{ type: 'assistant', content: 'world' }],
        varsSet: { baz: 42 },
        varsDeleted: ['foo'],
      };
      await store.appendSessionDelta(runId, delta2);

      const retrieved = await store.get(runId);
      expect(retrieved).toBeDefined();
      const result = retrieved!.result;
      expect(result).toBeDefined();
      expect(result!.version).toBe(2);
      expect(result!.messages).toHaveLength(2);
      expect(result!.messages[0].content).toBe('hello');
      expect(result!.messages[1].content).toBe('world');
      // foo was deleted, baz was set
      expect((result!.vars as Record<string, unknown>)['foo']).toBeUndefined();
      expect((result!.vars as Record<string, unknown>)['baz']).toBe(42);
    });

    // Case 4: a rewrite delta REPLACES messages
    it('case 4: rewrite delta replaces messages', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-rewrite-4';
      await store.create(runId, makeInitialRun(agent, agentName));

      // First append some messages
      const delta1: SessionCheckpointDelta = {
        fromVersion: 0,
        toVersion: 1,
        appendedMessages: [
          { type: 'user', content: 'original' },
          { type: 'assistant', content: 'original reply' },
        ],
      };
      await store.appendSessionDelta(runId, delta1);

      // Now rewrite with entirely new messages
      const rewriteDelta: SessionCheckpointDelta = {
        fromVersion: 1,
        toVersion: 2,
        appendedMessages: [{ type: 'user', content: 'rewritten' }],
        varsSet: { mode: 'rewritten' },
        rewrite: true,
      };
      await store.appendSessionDelta(runId, rewriteDelta);

      const retrieved = await store.get(runId);
      const result = retrieved!.result!;
      expect(result.version).toBe(2);
      // Rewrite: only the delta's appendedMessages remain
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('rewritten');
      expect((result.vars as Record<string, unknown>)['mode']).toBe(
        'rewritten',
      );
    });

    // Case 5: recordOnce on both scopes, retrievable, upsert overwrites same key
    it('case 5: recordOnce both scopes + upsert', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-once-5';
      await store.create(runId, makeInitialRun(agent, agentName));

      await store.recordOnce(runId, 'run', 'key-a', 'value-a');
      await store.recordOnce(runId, 'conversation', 'key-b', { nested: true });

      let retrieved = await store.get(runId);
      expect(retrieved!.once.run.get('key-a')).toBe('value-a');
      expect(retrieved!.once.conversation.get('key-b')).toEqual({
        nested: true,
      });

      // Upsert: overwrite same key
      await store.recordOnce(runId, 'run', 'key-a', 'updated-value');
      retrieved = await store.get(runId);
      expect(retrieved!.once.run.get('key-a')).toBe('updated-value');
    });

    // Case 6: upsertOutbox inserts then updates by idempotencyKey
    it('case 6: upsertOutbox inserts + updates by idempotencyKey', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-outbox-6';
      await store.create(runId, makeInitialRun(agent, agentName));

      const entry1: AssistantDeliveryOutboxEntry = {
        id: 'idem-key-1',
        idempotencyKey: 'idem-key-1',
        conversationId: runId,
        message: { type: 'assistant', content: 'hello' },
        assistantIndex: 0,
        messageRef: { conversationId: runId, assistantIndex: 0 },
        status: 'pending',
        attempts: 0,
      };
      await store.upsertOutbox(runId, entry1);

      let retrieved = await store.get(runId);
      expect(retrieved!.outbox).toHaveLength(1);
      expect(retrieved!.outbox[0].status).toBe('pending');

      // Same idempotencyKey => replace, not duplicate
      const entry1Updated: AssistantDeliveryOutboxEntry = {
        ...entry1,
        status: 'delivered',
        attempts: 1,
      };
      await store.upsertOutbox(runId, entry1Updated);

      retrieved = await store.get(runId);
      expect(retrieved!.outbox).toHaveLength(1);
      expect(retrieved!.outbox[0].status).toBe('delivered');
      expect(retrieved!.outbox[0].attempts).toBe(1);

      // Different key => new entry
      const entry2: AssistantDeliveryOutboxEntry = {
        ...entry1,
        id: 'idem-key-2',
        idempotencyKey: 'idem-key-2',
        assistantIndex: 1,
        messageRef: { conversationId: runId, assistantIndex: 1 },
      };
      await store.upsertOutbox(runId, entry2);
      retrieved = await store.get(runId);
      expect(retrieved!.outbox).toHaveLength(2);
    });

    // Case 7: appendInbox appends in offset order
    it('case 7: appendInbox appends in offset order', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-inbox-7';
      await store.create(runId, makeInitialRun(agent, agentName));

      const inbound0: Inbound = { offset: 0, kind: 'user', content: 'first' };
      const inbound1: Inbound = {
        offset: 1,
        kind: 'system',
        content: 'second',
      };
      await store.appendInbox(runId, inbound0);
      await store.appendInbox(runId, inbound1);

      const retrieved = await store.get(runId);
      expect(retrieved!.inbox).toHaveLength(2);
      expect(retrieved!.inbox[0].offset).toBe(0);
      expect(retrieved!.inbox[0].content).toBe('first');
      expect(retrieved!.inbox[1].offset).toBe(1);
      expect(retrieved!.inbox[1].content).toBe('second');
    });

    // Case 8: recordProviderSession stores a binding under nodePath
    it('case 8: recordProviderSession stores binding under nodePath', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-provider-8';
      await store.create(runId, makeInitialRun(agent, agentName));

      const binding = {
        provider: 'claude' as const,
        id: 'sess-123',
        restarts: 0,
      };
      await store.recordProviderSession(runId, 'main/node0', binding);

      const retrieved = await store.get(runId);
      expect(retrieved!.providerSessions).toBeDefined();
      expect(retrieved!.providerSessions!['main/node0']).toEqual(binding);
    });

    // Case 9: patch updates status/graphCursor/graphSuspendedAt/services/graphManifest
    it('case 9: patch updates run fields', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-patch-9';
      await store.create(runId, makeInitialRun(agent, agentName));

      await store.patch(runId, {
        status: 'done',
        graphCursor: 5,
        graphSuspendedAt: 'node/waiting',
        services: { userId: 'u1' },
      });

      const retrieved = await store.get(runId);
      expect(retrieved!.status).toBe('done');
      expect(retrieved!.graphCursor).toBe(5);
      expect(retrieved!.graphSuspendedAt).toBe('node/waiting');
      expect(retrieved!.services).toEqual({ userId: 'u1' });
    });

    // Case 10: delete removes the run
    it('case 10: delete removes the run', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-delete-10';
      await store.create(runId, makeInitialRun(agent, agentName));

      expect(await store.has(runId)).toBe(true);
      await store.delete(runId);
      expect(await store.get(runId)).toBeUndefined();
      expect(await store.has(runId)).toBe(false);
    });

    // Case 11: entries() lists all live runs
    it('case 11: entries() lists all live runs', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];

      await store.create('run-entries-11a', makeInitialRun(agent, agentName));
      await store.create('run-entries-11b', makeInitialRun(agent, agentName));
      await store.create('run-entries-11c', makeInitialRun(agent, agentName));
      await store.delete('run-entries-11b');

      const entriesIterable = await store.entries();
      const entries = [...entriesIterable];
      const runIds = entries.map(([id]) => id);

      expect(runIds).toContain('run-entries-11a');
      expect(runIds).toContain('run-entries-11c');
      expect(runIds).not.toContain('run-entries-11b');
    });

    // Case 12: DURABILITY — reopen gives a fresh store over the same data
    it('case 12: durability — reopen reconstructs runs identically', async () => {
      await openStore();
      if (!reopen) {
        // Skip durability case for in-memory stores
        return;
      }

      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-durable-12';

      // Create and populate the run
      await store.create(runId, makeInitialRun(agent, agentName));

      await store.appendSessionDelta(runId, {
        fromVersion: 0,
        toVersion: 1,
        appendedMessages: [
          { type: 'user', content: 'durable message 1' },
          { type: 'assistant', content: 'durable reply 1' },
        ],
        varsSet: { persistent: true },
      });

      await store.appendSessionDelta(runId, {
        fromVersion: 1,
        toVersion: 2,
        appendedMessages: [{ type: 'user', content: 'durable message 2' }],
        varsSet: { count: 2 },
      });

      await store.recordOnce(
        runId,
        'run',
        'durable-once-key',
        'durable-once-value',
      );
      await store.recordOnce(runId, 'conversation', 'conv-key', {
        persisted: 42,
      });

      const outboxEntry: AssistantDeliveryOutboxEntry = {
        id: 'durable-idem',
        idempotencyKey: 'durable-idem',
        conversationId: runId,
        message: { type: 'assistant', content: 'durable reply 1' },
        assistantIndex: 0,
        messageRef: { conversationId: runId, assistantIndex: 0 },
        status: 'pending',
        attempts: 0,
      };
      await store.upsertOutbox(runId, outboxEntry);

      const inbound: Inbound = {
        offset: 0,
        kind: 'user',
        content: 'durable input',
      };
      await store.appendInbox(runId, inbound);

      const providerBinding = {
        provider: 'claude' as const,
        id: 'sess-durable',
        restarts: 0,
      };
      await store.recordProviderSession(runId, 'main/agent', providerBinding);

      await store.patch(runId, { status: 'done', graphCursor: 3 });

      // Reopen the store over the same backing data
      const freshStore = await reopen();
      const reconstructed = await freshStore.get(runId);

      expect(reconstructed).toBeDefined();
      expect(reconstructed!.agentName).toBe(agentName);
      expect(reconstructed!.status).toBe('done');
      expect(reconstructed!.graphCursor).toBe(3);

      const result = reconstructed!.result!;
      expect(result.version).toBe(2);
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].content).toBe('durable message 1');
      expect(result.messages[1].content).toBe('durable reply 1');
      expect(result.messages[2].content).toBe('durable message 2');
      expect((result.vars as Record<string, unknown>)['persistent']).toBe(true);
      expect((result.vars as Record<string, unknown>)['count']).toBe(2);

      expect(reconstructed!.once.run.get('durable-once-key')).toBe(
        'durable-once-value',
      );
      expect(reconstructed!.once.conversation.get('conv-key')).toEqual({
        persisted: 42,
      });

      expect(reconstructed!.outbox).toHaveLength(1);
      expect(reconstructed!.outbox[0].idempotencyKey).toBe('durable-idem');
      expect(reconstructed!.outbox[0].status).toBe('pending');

      expect(reconstructed!.inbox).toHaveLength(1);
      expect(reconstructed!.inbox[0].content).toBe('durable input');

      expect(reconstructed!.providerSessions!['main/agent']).toEqual(
        providerBinding,
      );
    });

    // Case 13: delete then recreate the same runId yields a clean run.
    // Catches backends that orphan child rows (deltas/once/inbox/outbox/
    // provider) on delete — reusing the runId must NOT fold the old run's
    // child rows into the new run.
    it('case 13: delete then recreate same runId yields a clean run', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-recreate-13';

      // First incarnation: fully populated across all child tables.
      const firstInitial = Session.create({
        messages: [{ type: 'user', content: 'first incarnation initial' }],
      });
      await store.create(
        runId,
        makeInitialRun(agent, agentName, { initial: firstInitial }),
      );
      await store.appendSessionDelta(runId, {
        fromVersion: 1,
        toVersion: 2,
        appendedMessages: [{ type: 'assistant', content: 'first delta' }],
        varsSet: { leaked: true },
      });
      await store.recordOnce(
        runId,
        'run',
        'leaked-run-key',
        'leaked-run-value',
      );
      await store.recordOnce(runId, 'conversation', 'leaked-conv-key', {
        leaked: 1,
      });
      await store.upsertOutbox(runId, {
        id: 'leaked-idem',
        idempotencyKey: 'leaked-idem',
        conversationId: runId,
        message: { type: 'assistant', content: 'first delta' },
        assistantIndex: 0,
        messageRef: { conversationId: runId, assistantIndex: 0 },
        status: 'pending',
        attempts: 0,
      });
      await store.appendInbox(runId, {
        offset: 0,
        kind: 'user',
        content: 'leaked inbox',
      });
      await store.recordProviderSession(runId, 'main/leaked', {
        provider: 'claude',
        id: 'leaked-sess',
        restarts: 0,
      });

      // Delete the run.
      await store.delete(runId);
      expect(await store.has(runId)).toBe(false);

      // Recreate the SAME runId with a DIFFERENT fresh initial session and
      // nothing else.
      const secondInitial = Session.create({
        messages: [{ type: 'user', content: 'second incarnation initial' }],
      });
      await store.create(
        runId,
        makeInitialRun(agent, agentName, { initial: secondInitial }),
      );

      const reconstructed = await store.get(runId);
      expect(reconstructed).toBeDefined();

      // Only the new run's state must be reflected — no leaked child rows.
      expect(reconstructed!.inbox).toHaveLength(0);
      expect(reconstructed!.outbox).toHaveLength(0);
      expect(reconstructed!.once.run.size).toBe(0);
      expect(reconstructed!.once.conversation.size).toBe(0);
      expect(reconstructed!.providerSessions ?? {}).toEqual({});

      // No leaked session delta: result should be undefined (no deltas applied)
      // and the initial session must be the new one.
      expect(reconstructed!.initial.messages).toHaveLength(1);
      expect(reconstructed!.initial.messages[0].content).toBe(
        'second incarnation initial',
      );
      const effective = reconstructed!.result ?? reconstructed!.initial;
      expect(effective.messages).toHaveLength(1);
      expect(effective.messages[0].content).toBe('second incarnation initial');
      expect(
        (effective.vars as Record<string, unknown>)['leaked'],
      ).toBeUndefined();
    });

    // Case 14: CONCURRENCY — N concurrent appendSessionDelta chains to N
    // DIFFERENT runs on the same store all succeed with correct, independent
    // per-run seq chains. This is the concurrency contract a backend must
    // honor (see DurableRunStore's docstring in packages/core/src/durable.ts):
    // seq/offset allocation must be atomic and correct across concurrent
    // activity on DIFFERENT runs sharing one store/connection pool. It does
    // NOT test concurrent appends to the SAME run — that is out of contract
    // (single-writer-per-run is assumed; the app-level per-run mutex provides
    // it in-process).
    it('case 14: concurrent appendSessionDelta chains to different runs stay independent', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];

      const runCount = 8;
      const deltasPerRun = 3;
      const runIds = Array.from(
        { length: runCount },
        (_, i) => `run-concurrent-14-${i}`,
      );

      await Promise.all(
        runIds.map((runId) =>
          store.create(runId, makeInitialRun(agent, agentName)),
        ),
      );

      // For each run, append `deltasPerRun` deltas IN ORDER (same-run appends
      // stay sequential, honoring the single-writer-per-run contract), but run
      // all N runs' append chains CONCURRENTLY with each other so a backend
      // that allocates seq via a shared/global counter — or that races on the
      // connection pool across different run_ids — would be exposed.
      await Promise.all(
        runIds.map(async (runId) => {
          for (let i = 0; i < deltasPerRun; i++) {
            const delta: SessionCheckpointDelta = {
              fromVersion: i,
              toVersion: i + 1,
              appendedMessages: [
                { type: 'user', content: `${runId}-message-${i}` },
              ],
              varsSet: { [`k${i}`]: i },
            };
            await store.appendSessionDelta(runId, delta);
          }
        }),
      );

      for (const runId of runIds) {
        const retrieved = await store.get(runId);
        expect(retrieved).toBeDefined();
        const result = retrieved!.result;
        expect(result).toBeDefined();
        // Correct per-run seq chain: all deltasPerRun deltas landed, in order,
        // with no gaps and no cross-run leakage — otherwise version/message
        // count would be wrong or messages would belong to another run.
        expect(result!.version).toBe(deltasPerRun);
        expect(result!.messages).toHaveLength(deltasPerRun);
        for (let i = 0; i < deltasPerRun; i++) {
          expect(result!.messages[i].content).toBe(`${runId}-message-${i}`);
        }
      }
    });

    // -----------------------------------------------------------------------
    // Lease + fencing token cases (durability roadmap §2)
    // -----------------------------------------------------------------------

    // Case 15: acquire/renew/current round-trip. current() is undefined before
    // acquire; re-acquire by the same holder renews and KEEPS the token; renew
    // extends expiry without bumping the token; release makes current()
    // undefined again.
    it('case 15: lease acquire/renew/current round-trip', async () => {
      await openStore();

      expect(await store.lease.current()).toBeUndefined();

      const s1 = await store.lease.acquire(HOLDER_A, LEASE_TTL);
      expect(s1).toBeDefined();
      expect(s1!.holder).toBe(HOLDER_A);
      expect(s1!.expiresAt).toBe(BASE_NOW + LEASE_TTL);

      const current = await store.lease.current();
      expect(current!.holder).toBe(HOLDER_A);
      expect(current!.token).toBe(s1!.token);

      // Re-acquire by the same holder renews and keeps the token.
      const s2 = await store.lease.acquire(HOLDER_A, LEASE_TTL);
      expect(s2!.token).toBe(s1!.token);

      // Renew extends the expiry against the advanced clock, keeping the token.
      setNow(BASE_NOW + 5_000);
      const s3 = await store.lease.renew(HOLDER_A);
      expect(s3!.token).toBe(s1!.token);
      expect(s3!.expiresAt).toBe(BASE_NOW + 5_000 + LEASE_TTL);

      // Release: current() is undefined afterwards.
      await store.lease.release(HOLDER_A);
      expect(await store.lease.current()).toBeUndefined();

      // renew by a holder that no longer owns a live lease returns undefined.
      expect(await store.lease.renew(HOLDER_A)).toBeUndefined();
    });

    // Case 16: a second holder cannot acquire while the lease is live; after the
    // first holder releases, the second holder acquires and the token bumps.
    it('case 16: second holder cannot acquire while lease is live', async () => {
      await openStore();

      const s1 = await store.lease.acquire(HOLDER_A, LEASE_TTL);
      expect(s1).toBeDefined();

      const blocked = await store.lease.acquire(HOLDER_B, LEASE_TTL);
      expect(blocked).toBeUndefined();
      expect((await store.lease.current())!.holder).toBe(HOLDER_A);

      await store.lease.release(HOLDER_A);
      const s2 = await store.lease.acquire(HOLDER_B, LEASE_TTL);
      expect(s2).toBeDefined();
      expect(s2!.holder).toBe(HOLDER_B);
      expect(s2!.token).toBeGreaterThan(s1!.token);
    });

    // Case 17: an EXPIRED lease reads as undefined and can be taken over by a
    // different holder; the takeover bumps the token (orphan-takeover path).
    it('case 17: expired lease can be taken over and token increases', async () => {
      await openStore();

      const s1 = await store.lease.acquire(HOLDER_A, LEASE_TTL);
      expect(s1).toBeDefined();

      // Advance past expiry: the lease reads as absent.
      setNow(BASE_NOW + LEASE_TTL + 1);
      expect(await store.lease.current()).toBeUndefined();

      const s2 = await store.lease.acquire(HOLDER_B, LEASE_TTL);
      expect(s2).toBeDefined();
      expect(s2!.holder).toBe(HOLDER_B);
      expect(s2!.token).toBeGreaterThan(s1!.token);
    });

    // Case 18: handoff transfers the live lease atomically and bumps the token;
    // handoff from a holder that is not the current holder returns undefined.
    it('case 18: handoff transfers atomically and bumps token', async () => {
      await openStore();

      const s1 = await store.lease.acquire(HOLDER_A, LEASE_TTL);
      expect(s1).toBeDefined();

      // Wrong `from` → no transfer.
      const wrong = await store.lease.handoff({
        from: HOLDER_B,
        to: 'someone',
        ttlMs: LEASE_TTL,
      });
      expect(wrong).toBeUndefined();
      expect((await store.lease.current())!.holder).toBe(HOLDER_A);

      const s2 = await store.lease.handoff({
        from: HOLDER_A,
        to: HOLDER_B,
        ttlMs: LEASE_TTL,
      });
      expect(s2).toBeDefined();
      expect(s2!.holder).toBe(HOLDER_B);
      expect(s2!.token).toBeGreaterThan(s1!.token);
      expect((await store.lease.current())!.holder).toBe(HOLDER_B);
    });

    // Case 19: FENCING — after a handoff, the paused old holder ("blue") whose
    // token predates the handoff cannot write; its stale-fenced write is
    // rejected with FencingTokenError, while the new holder ("green") writes
    // with its fresh token. This is the paused-blue double-write scenario the
    // fencing token exists to defeat.
    it('case 19: stale-fence write rejected with FencingTokenError after handoff', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-fence-19';

      // Run created before any lease exists — an unfenced create is allowed.
      await store.create(runId, makeInitialRun(agent, agentName));

      const blue = await store.lease.acquire(HOLDER_A, LEASE_TTL);
      expect(blue).toBeDefined();

      // Blue writes with its own token: accepted.
      await store.patch(runId, { graphCursor: 1 }, blue!.token);

      // Handoff to green bumps the token.
      const green = await store.lease.handoff({
        from: HOLDER_A,
        to: HOLDER_B,
        ttlMs: LEASE_TTL,
      });
      expect(green!.token).toBeGreaterThan(blue!.token);

      // Paused blue tries to write with its now-stale token: rejected.
      await expect(
        store.patch(runId, { graphCursor: 2 }, blue!.token),
      ).rejects.toBeInstanceOf(FencingTokenError);

      // Green writes with its fresh token: accepted.
      await store.patch(runId, { graphCursor: 3 }, green!.token);

      const retrieved = await store.get(runId);
      expect(retrieved!.graphCursor).toBe(3);
    });

    // Case 20: with an ACTIVE lease, an omitted fence is also a
    // FencingTokenError — a leased store requires every writer to present its
    // token. Presenting the current token succeeds.
    it('case 20: omitted fence rejected while leased', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-fence-20';

      await store.create(runId, makeInitialRun(agent, agentName));
      const held = await store.lease.acquire(HOLDER_A, LEASE_TTL);
      expect(held).toBeDefined();

      await expect(
        store.patch(runId, { graphCursor: 1 }),
      ).rejects.toBeInstanceOf(FencingTokenError);

      await store.patch(runId, { graphCursor: 2 }, held!.token);
      expect((await store.get(runId))!.graphCursor).toBe(2);
    });

    // Case 21: a lease-less store accepts unfenced writes — the zero-config
    // single-process path stays unchanged. (Cases 1–14 rely on this
    // implicitly; here it is explicit alongside the lease cases.)
    it('case 21: lease-less store accepts unfenced writes', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-fence-21';

      // No lease acquired: every mutating call proceeds without a fence.
      expect(await store.lease.current()).toBeUndefined();
      await store.create(runId, makeInitialRun(agent, agentName));
      await store.patch(runId, { graphCursor: 7 });
      await store.appendInbox(runId, {
        offset: 0,
        kind: 'user',
        content: 'unfenced',
      });
      await store.recordOnce(runId, 'run', 'k', 'v');

      const retrieved = await store.get(runId);
      expect(retrieved!.graphCursor).toBe(7);
      expect(retrieved!.inbox).toHaveLength(1);
      expect(retrieved!.once.run.get('k')).toBe('v');
    });

    // Case 22: DURABILITY — the fencing token is monotonic across a store
    // reopen (persisted with the lease). Skipped for in-memory stores that have
    // no reopen, like case 12.
    it('case 22: fencing token monotonic across reopen', async () => {
      await openStore();
      if (!reopen) {
        return;
      }

      const s1 = await store.lease.acquire(HOLDER_A, LEASE_TTL);
      expect(s1).toBeDefined();

      // Advance past expiry so the reopened store can take the lease over.
      setNow(BASE_NOW + LEASE_TTL + 1);

      const fresh = await reopen();
      expect(await fresh.lease.current()).toBeUndefined();

      const s2 = await fresh.lease.acquire(HOLDER_B, LEASE_TTL);
      expect(s2).toBeDefined();
      // The persisted counter survives the reopen: the new token is strictly
      // greater than the pre-reopen token, never reset to zero.
      expect(s2!.token).toBeGreaterThan(s1!.token);
    });

    // -----------------------------------------------------------------------
    // Durable timer cases (durability roadmap §3)
    // -----------------------------------------------------------------------

    // Case 23: upsertTimer round-trips and is idempotent by (runId, id) — a
    // second upsert with the same id REPLACES the row (e.g. marking firedAt),
    // it does not append a duplicate. A second id makes a second timer.
    it('case 23: upsertTimer round-trip + idempotent upsert', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-timer-23';
      await store.create(runId, makeInitialRun(agent, agentName));

      const timer: DurableTimer = {
        id: 'sleeper/wait',
        wakeAt: BASE_NOW + 60_000,
        kind: 'control',
        createdAt: BASE_NOW,
      };
      await store.upsertTimer(runId, timer);

      let retrieved = await store.get(runId);
      expect(retrieved!.timers).toHaveLength(1);
      expect(retrieved!.timers![0].id).toBe('sleeper/wait');
      expect(retrieved!.timers![0].wakeAt).toBe(BASE_NOW + 60_000);
      expect(retrieved!.timers![0].firedAt).toBeUndefined();

      // Same id => replace, not duplicate (mark it fired).
      await store.upsertTimer(runId, { ...timer, firedAt: BASE_NOW + 60_000 });
      retrieved = await store.get(runId);
      expect(retrieved!.timers).toHaveLength(1);
      expect(retrieved!.timers![0].firedAt).toBe(BASE_NOW + 60_000);

      // Different id => new timer.
      await store.upsertTimer(runId, {
        id: 'sleeper/wait2',
        wakeAt: BASE_NOW + 120_000,
        createdAt: BASE_NOW,
      });
      retrieved = await store.get(runId);
      expect(retrieved!.timers).toHaveLength(2);
    });

    // Case 24: DURABILITY — timers survive a store reopen. Skipped for in-memory
    // stores with no reopen, like case 12.
    it('case 24: durable timers survive reopen', async () => {
      await openStore();
      if (!reopen) {
        return;
      }
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-timer-24';
      await store.create(runId, makeInitialRun(agent, agentName));

      await store.upsertTimer(runId, {
        id: 'sleeper/pending',
        wakeAt: BASE_NOW + 3_600_000,
        payload: 'timer:sleeper/pending',
        kind: 'control',
        createdAt: BASE_NOW,
      });
      await store.upsertTimer(runId, {
        id: 'sleeper/fired',
        wakeAt: BASE_NOW + 1_000,
        createdAt: BASE_NOW,
        firedAt: BASE_NOW + 1_500,
      });

      const fresh = await reopen();
      const reconstructed = await fresh.get(runId);
      const timers = [...(reconstructed!.timers ?? [])].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      expect(timers).toHaveLength(2);
      const fired = timers.find((t) => t.id === 'sleeper/fired')!;
      const pending = timers.find((t) => t.id === 'sleeper/pending')!;
      expect(fired.firedAt).toBe(BASE_NOW + 1_500);
      expect(pending.firedAt).toBeUndefined();
      expect(pending.wakeAt).toBe(BASE_NOW + 3_600_000);
      expect(pending.payload).toBe('timer:sleeper/pending');
      expect(pending.kind).toBe('control');
    });

    // Case 25: delete cascades timers — a recreated runId must not fold the old
    // incarnation's timer rows into the new run.
    it('case 25: delete cascades timers', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-timer-25';
      await store.create(runId, makeInitialRun(agent, agentName));
      await store.upsertTimer(runId, {
        id: 'sleeper/leaked',
        wakeAt: BASE_NOW + 5_000,
        createdAt: BASE_NOW,
      });

      await store.delete(runId);
      expect(await store.has(runId)).toBe(false);

      await store.create(runId, makeInitialRun(agent, agentName));
      const reconstructed = await store.get(runId);
      expect(reconstructed!.timers ?? []).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // Recording layer cases (design-docs replay-and-self-deploy.md, B0)
    // -----------------------------------------------------------------------

    // Case 26: appendRecord round-trips a seq-ordered stream, preserving order
    // across the three entry kinds (node breadcrumb, model call, tool call).
    it('case 26: appendRecord round-trips ordered stream across kinds', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-record-26';
      await store.create(runId, makeInitialRun(agent, agentName));

      const node: RunRecordEntry = {
        kind: 'node',
        record: { seq: 0, nodePath: 'main', nodeType: 'scope', at: 100 },
      };
      const model: RunRecordEntry = {
        kind: 'model',
        record: {
          seq: 1,
          nodePath: 'main/assistant',
          callIndex: 0,
          provider: 'assistant',
          requestDigest: 'req-digest-1',
          response: { text: 'hello' },
          at: 101,
        },
      };
      const tool: RunRecordEntry = {
        kind: 'tool',
        record: {
          seq: 2,
          nodePath: 'main/tools',
          callIndex: 0,
          toolName: 'search',
          argsDigest: 'args-digest-1',
          result: { ok: true },
          at: 102,
        },
      };
      await store.appendRecord(runId, node);
      await store.appendRecord(runId, model);
      await store.appendRecord(runId, tool);

      const retrieved = await store.get(runId);
      const recording = retrieved!.recording ?? [];
      expect(recording).toHaveLength(3);
      expect(recording.map((e) => e.record.seq)).toEqual([0, 1, 2]);
      expect(recording.map((e) => e.kind)).toEqual(['node', 'model', 'tool']);
      expect(recording[1]).toEqual(model);
      expect(recording[2]).toEqual(tool);
    });

    // Case 27: appendRecord is idempotent by (runId, seq) — a second append with
    // a seq already present is a no-op (first write wins), like appendInbox.
    it('case 27: appendRecord idempotent by (runId, seq)', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-record-27';
      await store.create(runId, makeInitialRun(agent, agentName));

      const first: RunRecordEntry = {
        kind: 'node',
        record: { seq: 0, nodePath: 'main', nodeType: 'scope', at: 1 },
      };
      await store.appendRecord(runId, first);

      // Same seq, different payload => dropped (first write wins).
      const dup: RunRecordEntry = {
        kind: 'node',
        record: { seq: 0, nodePath: 'other', nodeType: 'loop', at: 2 },
      };
      await store.appendRecord(runId, dup);

      const retrieved = await store.get(runId);
      const recording = retrieved!.recording ?? [];
      expect(recording).toHaveLength(1);
      expect(recording[0]).toEqual(first);
    });

    // Case 28: DURABILITY — the recording stream survives a store reopen.
    // Skipped for in-memory stores with no reopen, like case 12.
    it('case 28: recording survives reopen', async () => {
      await openStore();
      if (!reopen) {
        return;
      }
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-record-28';
      await store.create(runId, makeInitialRun(agent, agentName));

      const entries: RunRecordEntry[] = [
        {
          kind: 'node',
          record: { seq: 0, nodePath: 'main', nodeType: 'scope', at: 1 },
        },
        {
          kind: 'model',
          record: {
            seq: 1,
            nodePath: 'main/assistant',
            callIndex: 0,
            provider: 'claude',
            requestDigest: 'd',
            request: { messages: ['hi'] },
            response: { text: 'yo' },
            at: 2,
          },
        },
      ];
      for (const entry of entries) {
        await store.appendRecord(runId, entry);
      }

      const fresh = await reopen();
      const reconstructed = await fresh.get(runId);
      const recording = reconstructed!.recording ?? [];
      expect(recording).toHaveLength(2);
      expect(recording.map((e) => e.record.seq)).toEqual([0, 1]);
      expect(recording[1]).toEqual(entries[1]);
    });

    // Case 29: delete cascades records — a recreated runId must not fold the old
    // incarnation's record rows into the new run.
    it('case 29: delete cascades records', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-record-29';
      await store.create(runId, makeInitialRun(agent, agentName));
      await store.appendRecord(runId, {
        kind: 'node',
        record: { seq: 0, nodePath: 'main', nodeType: 'scope', at: 1 },
      });

      await store.delete(runId);
      expect(await store.has(runId)).toBe(false);

      await store.create(runId, makeInitialRun(agent, agentName));
      const reconstructed = await store.get(runId);
      expect(reconstructed!.recording ?? []).toHaveLength(0);
    });

    // Case 30: recordLevel is fixed at create time and round-trips on the run,
    // including across a reopen when the backend is durable.
    it('case 30: recordLevel round-trips on the run', async () => {
      await openStore();
      const agentName = Object.keys(agents)[0];
      const agent = agents[agentName];
      const runId = 'run-record-30';
      const recordLevel: RecordLevel = 'full';
      await store.create(
        runId,
        makeInitialRun(agent, agentName, { recordLevel }),
      );

      const retrieved = await store.get(runId);
      expect(retrieved!.recordLevel).toBe('full');

      if (reopen) {
        const fresh = await reopen();
        const reconstructed = await fresh.get(runId);
        expect(reconstructed!.recordLevel).toBe('full');
      }
    });
  });
}
