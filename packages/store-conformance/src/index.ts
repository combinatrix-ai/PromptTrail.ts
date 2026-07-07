import { describe, it, expect, afterEach } from 'vitest';
import {
  Agent,
  Session,
  type DurableRunStore,
  type StoredRun,
  type SessionCheckpointDelta,
  type Inbound,
  type AssistantDeliveryOutboxEntry,
} from '@prompttrail/core';

export interface ConformanceSpec {
  name: string;
  makeAgents: () => Record<string, Agent>;
  open: (agents: Record<string, Agent>) => Promise<{
    store: DurableRunStore;
    reopen?: () => Promise<DurableRunStore>;
    dispose?: () => Promise<void>;
  }>;
}

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

    afterEach(async () => {
      if (dispose) {
        await dispose();
      }
    });

    async function openStore() {
      agents = spec.makeAgents();
      const result = await spec.open(agents);
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

    // Case 9: patch updates status/graphCursor/graphSuspendedAt/context/graphManifest
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
        context: { userId: 'u1' },
      });

      const retrieved = await store.get(runId);
      expect(retrieved!.status).toBe('done');
      expect(retrieved!.graphCursor).toBe(5);
      expect(retrieved!.graphSuspendedAt).toBe('node/waiting');
      expect(retrieved!.context).toEqual({ userId: 'u1' });
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
  });
}
