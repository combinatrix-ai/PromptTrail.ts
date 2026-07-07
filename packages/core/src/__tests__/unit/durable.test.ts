import { describe, expect, it } from 'vitest';
import {
  CheckpointRollbackError,
  createCheckpointOnceBoundary,
  createCheckpointOnceMemoStore,
} from '../../checkpoint_continuation';
import {
  MemoryRunStore,
  PromptTrail,
  manualGateway,
  memoryStore,
} from '../../durable';
import type {
  AssistantDeliveryOutboxEntry,
  DurableRunStore,
  Inbound,
  OnceScope,
  SessionCheckpointDelta,
  StoredRun,
  StoredRunPatch,
} from '../../durable';
import type { ProviderSessionBinding } from '../../provider_session';
import { Session } from '../../session';
import { Source } from '../../source';
import { Agent } from '../../templates';
import { executePromptTrailTool, Tool } from '../../tool';

class TrackingRunStore implements DurableRunStore {
  readonly runs = new Map<string, StoredRun<any>>();
  readonly snapshots: Array<{
    type: string;
    runId: string;
    status?: StoredRun<any>['status'];
    onceRunEntries?: number;
    resultMessages?: number;
    outbox?: number;
  }> = [];

  async get(runId: string): Promise<StoredRun<any> | undefined> {
    return this.runs.get(runId);
  }

  async create(runId: string, run: StoredRun<any>): Promise<void> {
    this.runs.set(runId, run);
    this.snapshots.push({
      type: 'create',
      runId,
      status: run.status,
      onceRunEntries: run.once.run.size,
      resultMessages: run.result?.messages.length,
      outbox: run.outbox.length,
    });
  }

  async has(runId: string): Promise<boolean> {
    return this.runs.has(runId);
  }

  async patch(runId: string, patch: StoredRunPatch): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    Object.assign(run, patch);
    this.snapshots.push({
      type: 'patch',
      runId,
      status: run.status,
      onceRunEntries: run.once.run.size,
      resultMessages: run.result?.messages.length,
      outbox: run.outbox.length,
    });
  }

  async appendInbox(runId: string, inbound: Inbound): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.inbox[inbound.offset]) {
      return;
    }
    run.inbox.push(inbound);
  }

  async appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    applyDelta(run, delta);
    this.snapshots.push({
      type: 'appendSessionDelta',
      runId,
      status: run.status,
      onceRunEntries: run.once.run.size,
      resultMessages: run.result?.messages.length,
      outbox: run.outbox.length,
    });
  }

  async recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.once[scope].set(key, value);
    this.snapshots.push({
      type: 'recordOnce',
      runId,
      status: run.status,
      onceRunEntries: run.once.run.size,
      resultMessages: run.result?.messages.length,
      outbox: run.outbox.length,
    });
  }

  async upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    upsertOutbox(run, entry);
    this.snapshots.push({
      type: 'upsertOutbox',
      runId,
      status: run.status,
      onceRunEntries: run.once.run.size,
      resultMessages: run.result?.messages.length,
      outbox: run.outbox.length,
    });
  }

  async recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.providerSessions = {
      ...(run.providerSessions ?? {}),
      [nodePath]: binding,
    };
    this.snapshots.push({
      type: 'recordProviderSession',
      runId,
      status: run.status,
      onceRunEntries: run.once.run.size,
      resultMessages: run.result?.messages.length,
      outbox: run.outbox.length,
    });
  }

  async delete(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  async entries(): Promise<Iterable<[string, StoredRun<any>]>> {
    return this.runs.entries();
  }
}

class ControlledDelayRunStore implements DurableRunStore {
  readonly runs = new Map<string, StoredRun<any>>();
  readonly pending: Array<{
    type: string;
    runId: string;
    snapshot: {
      status: StoredRun<any>['status'];
      onceRunEntries: number;
      resultMessages?: number;
    };
    resolve: () => void;
  }> = [];

  async get(runId: string): Promise<StoredRun<any> | undefined> {
    return this.runs.get(runId);
  }

  create(runId: string, run: StoredRun<any>): Promise<void> {
    return new Promise((resolve) => {
      this.pending.push({
        type: 'create',
        runId,
        snapshot: {
          status: run.status,
          onceRunEntries: run.once.run.size,
          resultMessages: run.result?.messages.length,
        },
        resolve: () => {
          this.runs.set(runId, run);
          resolve();
        },
      });
    });
  }

  async has(runId: string): Promise<boolean> {
    return this.runs.has(runId);
  }

  patch(runId: string, patch: StoredRunPatch): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return Promise.resolve();
    }
    Object.assign(run, patch);
    return this.delayWrite('patch', runId, run, () => {});
  }

  appendInbox(runId: string, inbound: Inbound): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.inbox[inbound.offset]) {
      return Promise.resolve();
    }
    run.inbox.push(inbound);
    return this.delayWrite('appendInbox', runId, run, () => {});
  }

  appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return Promise.resolve();
    }
    applyDelta(run, delta);
    return this.delayWrite('appendSessionDelta', runId, run, () => {});
  }

  recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return Promise.resolve();
    }
    run.once[scope].set(key, value);
    return this.delayWrite('recordOnce', runId, run, () => {});
  }

  upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return Promise.resolve();
    }
    upsertOutbox(run, entry);
    return this.delayWrite('upsertOutbox', runId, run, () => {});
  }

  recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return Promise.resolve();
    }
    run.providerSessions = {
      ...(run.providerSessions ?? {}),
      [nodePath]: binding,
    };
    return this.delayWrite('recordProviderSession', runId, run, () => {});
  }

  async delete(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  async entries(): Promise<Iterable<[string, StoredRun<any>]>> {
    return this.runs.entries();
  }

  async resolveNext(): Promise<void> {
    const pending = this.pending.shift();
    if (!pending) {
      throw new Error('No pending store write to resolve.');
    }
    pending.resolve();
    await Promise.resolve();
  }

  private delayWrite(
    type: string,
    runId: string,
    run: StoredRun<any>,
    apply: () => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      this.pending.push({
        type,
        runId,
        snapshot: {
          status: run.status,
          onceRunEntries: run.once.run.size,
          resultMessages: run.result?.messages.length,
        },
        resolve: () => {
          apply();
          resolve();
        },
      });
    });
  }
}

type RecordedWrite =
  | {
      type: 'create';
      runId: string;
      initialMessages: readonly string[];
      resultMessages?: readonly string[];
      initialVersion: number;
    }
  | { type: 'patch'; runId: string; patch: StoredRunPatch }
  | { type: 'appendInbox'; runId: string; inbound: Inbound }
  | {
      type: 'appendSessionDelta';
      runId: string;
      delta: SessionCheckpointDelta<any>;
    }
  | { type: 'recordOnce'; runId: string; scope: OnceScope; key: string }
  | {
      type: 'upsertOutbox';
      runId: string;
      idempotencyKey: string;
      message: string;
    }
  | {
      type: 'recordProviderSession';
      runId: string;
      nodePath: string;
      binding: ProviderSessionBinding;
    }
  | { type: 'delete'; runId: string };

class RecordingRunStore implements DurableRunStore {
  readonly runs = new Map<string, StoredRun<any>>();
  readonly writes: RecordedWrite[] = [];

  async get(runId: string): Promise<StoredRun<any> | undefined> {
    return this.runs.get(runId);
  }

  async has(runId: string): Promise<boolean> {
    return this.runs.has(runId);
  }

  async entries(): Promise<Iterable<[string, StoredRun<any>]>> {
    return this.runs.entries();
  }

  async create(runId: string, run: StoredRun<any>): Promise<void> {
    this.runs.set(runId, run);
    this.writes.push({
      type: 'create',
      runId,
      initialMessages: run.initial.messages.map((message) => message.content),
      resultMessages: run.result?.messages.map((message) => message.content),
      initialVersion: run.initial.version,
    });
  }

  async patch(runId: string, patch: StoredRunPatch): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    Object.assign(run, patch);
    this.writes.push({ type: 'patch', runId, patch });
  }

  async appendInbox(runId: string, inbound: Inbound): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.inbox[inbound.offset]) {
      return;
    }
    run.inbox.push(inbound);
    this.writes.push({ type: 'appendInbox', runId, inbound });
  }

  async appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    applyDelta(run, delta);
    this.writes.push({ type: 'appendSessionDelta', runId, delta });
  }

  async recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.once[scope].set(key, value);
    this.writes.push({ type: 'recordOnce', runId, scope, key });
  }

  async upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    upsertOutbox(run, entry);
    this.writes.push({
      type: 'upsertOutbox',
      runId,
      idempotencyKey: entry.idempotencyKey,
      message: entry.message.content,
    });
  }

  async recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.providerSessions = {
      ...(run.providerSessions ?? {}),
      [nodePath]: binding,
    };
    this.writes.push({
      type: 'recordProviderSession',
      runId,
      nodePath,
      binding,
    });
  }

  async delete(runId: string): Promise<void> {
    this.runs.delete(runId);
    this.writes.push({ type: 'delete', runId });
  }
}

describe('checkpoint app runtime', () => {
  it('can run graph Agents through PromptTrail.app ephemerally', async () => {
    const events: string[] = [];
    const assistant = Agent.create('graphAssistant')
      .inbox('inbound')
      .assistant('reply', Source.literal('ok'));
    const app = PromptTrail.app({
      agents: { assistant },
      observers: [
        {
          handle(event) {
            events.push(
              `${event.seq}:${event.type}:${event.conversationId}:${event.source}`,
            );
          },
        },
      ],
    });

    const result = await app.run({
      agent: 'assistant',
      input: 'hello',
    });

    expect(result.status).toBe('done');
    expect(result.runId).toBe('graphAssistant-1');
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'hello',
      'ok',
    ]);
    expect(events).toEqual([
      '0:run.started:graphAssistant-1:app',
      '1:run.completed:graphAssistant-1:app',
    ]);
  });

  it('stores checkpoint app runs for graph Agents', async () => {
    const store = memoryStore();
    const events: string[] = [];
    const assistant = Agent.create('graphAssistant').assistant(
      'reply',
      Source.literal('ok'),
    );
    const app = PromptTrail.app({
      store,
      agents: { assistant },
      observers: [
        {
          handle(event) {
            events.push(`${event.seq}:${event.type}:${event.source}`);
          },
        },
      ],
    });

    const result = await app.run({
      agent: 'assistant',
      checkpoint: true,
    });

    expect(result.status).toBe('done');
    expect(result.runId).toBe('graphAssistant-1');
    expect(result.session.getLastMessage()?.content).toBe('ok');
    expect(await store.get(result.runId)).toMatchObject({
      status: 'done',
      graphCursor: 0,
    });
    expect(events).toEqual([
      '0:run.started:graph',
      '1:model.started:model',
      '2:model.completed:model',
      '3:run.completed:graph',
    ]);
  });

  it('persists once memo entries and assistant delivery outbox before completion', async () => {
    const store = new TrackingRunStore();
    const assistant = Agent.create('persisted')
      .tool('write', {
        kind: 'tool',
        name: 'write',
        description: 'Write.',
        inputSchema: {
          parse: (input: unknown) => input,
        } as any,
        effect: { idempotencyKey: 'write:1' },
        execute: () => 'written',
      })
      .assistant('reply', () => ({
        content: 'need write',
        toolCalls: [{ id: 'call-1', name: 'write', arguments: {} }],
      }))
      .tools('run');
    const app = PromptTrail.app({
      agents: { persisted: assistant },
      store,
    });

    await app.run({
      agent: 'persisted',
      runId: 'run-persist-commits',
      checkpoint: true,
      context: {
        delivery: {
          platform: 'fake-chat',
          channel: 'C_general',
        },
      },
    });

    expect(store.snapshots).toContainEqual(
      expect.objectContaining({
        runId: 'run-persist-commits',
        status: 'open',
        onceRunEntries: 1,
      }),
    );
    expect(
      await app.assistantDeliveryOutbox('run-persist-commits'),
    ).toHaveLength(1);
  });

  it('awaits async once memo and final run persists at effect boundaries', async () => {
    const store = new ControlledDelayRunStore();
    const events: string[] = [];
    const assistant = Agent.create('ordered-persist')
      .tool('write', {
        kind: 'tool',
        name: 'write',
        description: 'Write.',
        inputSchema: {
          parse: (input: unknown) => input,
        } as any,
        effect: { idempotencyKey: 'write:ordered' },
        execute: () => {
          events.push('external-write');
          return 'written';
        },
      })
      .assistant('reply', () => ({
        content: 'need write',
        toolCalls: [{ id: 'call-1', name: 'write', arguments: {} }],
      }))
      .tools('run')
      .transform('after-write', (session) => {
        events.push('next-node');
        return session;
      });
    const app = PromptTrail.app({
      agents: { ordered: assistant },
      store,
    });
    const runPromise = app
      .run({
        agent: 'ordered',
        runId: 'run-ordered-persists',
        checkpoint: true,
      })
      .then((result) => {
        events.push(`reported:${result.status}`);
        return result;
      });

    await resolveUntilPendingWrite(store, (pending) => {
      return (
        pending.type === 'recordOnce' &&
        pending.snapshot.status === 'open' &&
        pending.snapshot.onceRunEntries === 1
      );
    });

    expect(events).toContain('external-write');
    expect(events).not.toContain('next-node');

    await store.resolveNext();
    await waitFor(() => events.includes('next-node'));

    await resolveUntilPendingWrite(store, (pending) => {
      return (
        pending.snapshot.status === 'done' &&
        pending.snapshot.resultMessages === 2
      );
    });

    expect(events).not.toContain('reported:done');

    await store.resolveNext();
    await resolvePendingWritesUntil(
      () => events.includes('reported:done'),
      store,
    );
    const result = await runPromise;

    expect(result.status).toBe('done');
    expect(events).toContain('reported:done');
  });

  it('persists session content only as deltas after initial create', async () => {
    const store = new RecordingRunStore();
    const assistant = Agent.create('delta-writes')
      .transform('vars-only', (session) => session.withVar('stage', 'waiting'))
      .awaitInput('input')
      .assistant(
        'reply',
        (session) => `reply:${session.getLastMessage()?.content ?? ''}`,
      );
    const app = PromptTrail.app({
      agents: { delta: assistant },
      store,
    });

    const first = await app.run({
      agent: 'delta',
      runId: 'run-delta-writes',
      checkpoint: true,
      session: Session.create({
        messages: [{ type: 'system', content: 'seed' }],
      }),
    });
    const second = await app.send({
      runId: 'run-delta-writes',
      input: 'continue',
    });

    expect(first.status).toBe('suspended');
    expect(second.status).toBe('done');
    expect(store.writes[0]).toMatchObject({
      type: 'create',
      initialMessages: ['seed'],
    });
    expect(
      store.writes.slice(1).filter((write) => write.type === 'create'),
    ).toEqual([]);

    const deltas = store.writes.filter(
      (
        write,
      ): write is Extract<RecordedWrite, { type: 'appendSessionDelta' }> =>
        write.type === 'appendSessionDelta',
    );
    expect(deltas[0]?.delta).toMatchObject({
      appendedMessages: [],
      varsSet: { stage: 'waiting' },
    });
    expect(
      deltas[1]?.delta.appendedMessages.map((message) => message.content),
    ).toEqual(['continue', 'reply:continue']);
    expect(
      deltas.some(
        (write) =>
          write.delta.appendedMessages
            .map((message) => message.content)
            .join('|') === 'seed|continue|reply:continue',
      ),
    ).toBe(false);
  });

  it('chains session deltas by contiguous session versions', async () => {
    const store = new RecordingRunStore();
    const assistant = Agent.create('delta-chain')
      .transform('vars-only', (session) => session.withVar('stage', 'waiting'))
      .awaitInput('input')
      .assistant('reply', () => 'done');
    const app = PromptTrail.app({
      agents: { delta: assistant },
      store,
    });

    await app.run({
      agent: 'delta',
      runId: 'run-delta-chain',
      checkpoint: true,
    });
    await app.send({
      runId: 'run-delta-chain',
      input: 'continue',
    });

    const create = store.writes.find(
      (write): write is Extract<RecordedWrite, { type: 'create' }> =>
        write.type === 'create',
    );
    const deltas = store.writes.filter(
      (
        write,
      ): write is Extract<RecordedWrite, { type: 'appendSessionDelta' }> =>
        write.type === 'appendSessionDelta',
    );

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas[0]?.delta.fromVersion).toBe(create?.initialVersion);
    for (let index = 1; index < deltas.length; index++) {
      expect(deltas[index]?.delta.fromVersion).toBe(
        deltas[index - 1]?.delta.toVersion,
      );
    }
  });

  it('falls back to a rewrite delta when message history is replaced', async () => {
    const store = new RecordingRunStore();
    const assistant = Agent.create('rewriter')
      .assistant('reply', () => 'draft')
      .transform('redact', (session) =>
        Session.create({
          messages: session.messages.map((message) =>
            message.type === 'assistant'
              ? { ...message, content: 'redacted' }
              : message,
          ),
          vars: { ...session.vars },
        }),
      )
      .awaitInput('input')
      .assistant('after', () => 'done');
    const app = PromptTrail.app({
      agents: { rewriter: assistant },
      store,
    });

    const first = await app.run({
      agent: 'rewriter',
      runId: 'run-rewrite-delta',
      checkpoint: true,
    });
    const second = await app.send({
      runId: 'run-rewrite-delta',
      input: 'continue',
    });

    expect(first.status).toBe('suspended');
    expect(second.status).toBe('done');

    const deltas = store.writes.filter(
      (
        write,
      ): write is Extract<RecordedWrite, { type: 'appendSessionDelta' }> =>
        write.type === 'appendSessionDelta',
    );
    expect(deltas[0]?.delta.rewrite).toBe(true);
    expect(
      deltas[0]?.delta.appendedMessages.map((message) => message.content),
    ).toEqual(['redacted']);
    expect(deltas.slice(1).every((write) => !write.delta.rewrite)).toBe(true);
    expect(deltas[1]?.delta.fromVersion).toBe(deltas[0]?.delta.toVersion);
    expect(
      deltas[1]?.delta.appendedMessages.map((message) => message.content),
    ).toEqual(['continue', 'done']);
    expect(
      (await store.get('run-rewrite-delta'))?.result?.messages.map(
        (message: { content: string }) => message.content,
      ),
    ).toEqual(['redacted', 'continue', 'done']);
  });

  it('rolls the checkpoint back to a consistent point when a node throws after appending a message', async () => {
    const store = memoryStore();
    let fail = true;
    const assistant = Agent.create('rollback')
      .inbox('in')
      .assistant('reply', Source.literal('ok'))
      .transform('boom', (session) => {
        if (fail) {
          throw new Error('boom');
        }
        return session;
      });
    const app = PromptTrail.app({ agents: { rollback: assistant }, store });

    await expect(
      app.run({
        agent: 'rollback',
        runId: 'run-rollback',
        input: 'hello',
        checkpoint: true,
      }),
    ).rejects.toThrow('boom');

    // At rest after the error the persisted cursor and session must agree on how
    // much of the inbox has been consumed: nothing was durably consumed.
    const afterError = await store.get('run-rollback');
    expect(afterError?.graphCursor).toBe(0);
    expect(
      afterError?.result?.messages.map((message) => message.content) ?? [],
    ).toEqual([]);

    // A retry replays the (still unconsumed) inbox against the entry-point
    // session, so the message is not duplicated.
    fail = false;
    const retry = await app.resume('run-rollback');
    expect(retry.status).toBe('done');
    expect(retry.session.messages.map((message) => message.content)).toEqual([
      'hello',
      'ok',
    ]);
  });

  it('rolls back to a consistent point after an error on a continuation and does not duplicate input', async () => {
    const store = memoryStore();
    let fail = false;
    const assistant = Agent.create('rollback-cont')
      .inbox('in')
      .assistant('reply', Source.literal('ok'))
      .transform('boom', (session) => {
        if (fail) {
          throw new Error('boom');
        }
        return session;
      });
    const app = PromptTrail.app({ agents: { rollback: assistant }, store });

    const first = await app.run({
      agent: 'rollback',
      runId: 'run-rollback-cont',
      input: 'hello',
      checkpoint: true,
    });
    expect(first.session.messages.map((message) => message.content)).toEqual([
      'hello',
      'ok',
    ]);

    fail = true;
    await expect(
      app.send({ runId: 'run-rollback-cont', input: 'world' }),
    ).rejects.toThrow('boom');

    // The prior completion is preserved (consumed 'hello'), the cursor points at
    // 'world' as the next unconsumed input, and 'world' is not yet in the
    // session — cursor and session stay mutually consistent.
    const afterError = await store.get('run-rollback-cont');
    expect(afterError?.graphCursor).toBe(1);
    expect(
      afterError?.result?.messages.map((message) => message.content),
    ).toEqual(['hello', 'ok']);

    fail = false;
    const retry = await app.resume('run-rollback-cont');
    expect(retry.session.messages.map((message) => message.content)).toEqual([
      'hello',
      'ok',
      'world',
      'ok',
    ]);
  });

  it('a fresh app instance sharing the store retries a failed run consistently', async () => {
    const store = memoryStore();
    let fail = true;
    const build = () =>
      Agent.create('cold')
        .inbox('in')
        .assistant('reply', Source.literal('ok'))
        .transform('boom', (session) => {
          if (fail) {
            throw new Error('boom');
          }
          return session;
        });

    const app = PromptTrail.app({ agents: { cold: build() }, store });
    await expect(
      app.run({
        agent: 'cold',
        runId: 'run-cold',
        input: 'hello',
        checkpoint: true,
      }),
    ).rejects.toThrow('boom');

    // A fresh app instance (cold restart) rebinds the agent and shares the store
    // but has an empty in-memory session baseline.
    fail = false;
    const restarted = PromptTrail.app({ agents: { cold: build() }, store });
    const retry = await restarted.resume('run-cold');
    expect(retry.status).toBe('done');
    expect(retry.session.messages.map((message) => message.content)).toEqual([
      'hello',
      'ok',
    ]);
  });

  it('delete removes the run from the store and prunes the process-local maps', async () => {
    const store = memoryStore();
    const assistant = Agent.create('deletable')
      .assistant('reply', () => 'hello')
      .awaitInput('input');
    const app = PromptTrail.app({ agents: { deletable: assistant }, store });

    const first = await app.run({
      agent: 'deletable',
      runId: 'run-delete',
      checkpoint: true,
    });
    expect(first.status).toBe('suspended');

    // The maps keyed by runId hold entries for a live run: the event sequence
    // (populated as the graph emits events) and the persisted-session baseline.
    const internals = app as unknown as {
      runEventSeqs: Map<string, unknown>;
      persistedSessions: Map<string, unknown>;
    };
    expect(internals.runEventSeqs.has('run-delete')).toBe(true);
    expect(internals.persistedSessions.has('run-delete')).toBe(true);
    expect(await store.get('run-delete')).toBeDefined();

    await app.delete('run-delete');

    expect(await store.get('run-delete')).toBeUndefined();
    expect(internals.runEventSeqs.has('run-delete')).toBe(false);
    expect(internals.persistedSessions.has('run-delete')).toBe(false);
  });

  it('resumes an awaitInput suspension in a fresh app instance without duplicating prompts', async () => {
    const store = memoryStore();
    const build = () =>
      Agent.create('cold-suspend')
        .system('sys', 'System')
        .assistant('greet', Source.literal('hello'))
        .awaitInput('input')
        .assistant(
          'reply',
          (session) => `reply:${session.getLastMessage()?.content}`,
        );

    const app = PromptTrail.app({ agents: { cold: build() }, store });
    const first = await app.run({
      agent: 'cold',
      runId: 'run-cold-suspend',
      checkpoint: true,
    });
    expect(first.status).toBe('suspended');

    // A fresh app instance (cold restart) shares the store but starts with empty
    // in-memory session/event baselines. Sending the awaited input must resume
    // to completion with the correct message order and no duplicated prompt.
    const restarted = PromptTrail.app({ agents: { cold: build() }, store });
    const resumed = await restarted.send({
      runId: 'run-cold-suspend',
      input: 'world',
    });

    expect(resumed.status).toBe('done');
    expect(resumed.session.messages.map((message) => message.content)).toEqual([
      'System',
      'hello',
      'world',
      'reply:world',
    ]);
    expect(
      resumed.session.messages.filter((message) => message.content === 'hello'),
    ).toHaveLength(1);
  });

  it('does not re-execute a keyed effect after cold restart resume', async () => {
    const store = memoryStore();
    let executions = 0;
    const build = () =>
      Agent.create('cold-once')
        .tool('write', {
          kind: 'tool',
          name: 'write',
          description: 'Write.',
          inputSchema: {
            parse: (input: unknown) => input,
          } as any,
          effect: { idempotencyKey: 'write:cold' },
          execute: () => {
            executions++;
            return 'written';
          },
        })
        .assistant('call', () => ({
          content: 'need write',
          toolCalls: [{ id: 'call-1', name: 'write', arguments: {} }],
        }))
        .tools('run')
        .awaitInput('input')
        .assistant('after', () => 'done');

    const app = PromptTrail.app({ agents: { cold: build() }, store });
    const first = await app.run({
      agent: 'cold',
      runId: 'run-cold-once',
      checkpoint: true,
    });
    expect(first.status).toBe('suspended');
    // The keyed effect ran once in instance A before the suspension, and its
    // once memo is recorded in the shared store.
    expect(executions).toBe(1);

    // Resuming in a fresh instance (empty in-memory once boundary) must consult
    // the store's once memo and must not re-run the effect body.
    const restarted = PromptTrail.app({ agents: { cold: build() }, store });
    const resumed = await restarted.send({
      runId: 'run-cold-once',
      input: 'go',
    });

    expect(resumed.status).toBe('done');
    expect(executions).toBe(1);
    expect(resumed.session.getLastMessage()?.content).toBe('done');
  });

  it('surfaces both the run error and the rollback error when rollback persistence fails', async () => {
    class RollbackFailStore extends MemoryRunStore {
      private advanced = false;
      async patch(
        runId: string,
        patch: Parameters<MemoryRunStore['patch']>[1],
      ): Promise<void> {
        if (patch.graphCursor === 1) {
          this.advanced = true;
        }
        // Fail only the rewind write (cursor regressing to 0 after advancing).
        if (this.advanced && patch.graphCursor === 0) {
          throw new Error('store patch failed');
        }
        return super.patch(runId, patch);
      }
    }

    const store = new RollbackFailStore();
    const assistant = Agent.create('rollback-fail')
      .inbox('in')
      .assistant('reply', Source.literal('ok'))
      .transform('boom', () => {
        throw new Error('boom');
      });
    const app = PromptTrail.app({ agents: { rollback: assistant }, store });

    let caught: unknown;
    try {
      await app.run({
        agent: 'rollback',
        runId: 'run-rollback-fail',
        input: 'hello',
        checkpoint: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CheckpointRollbackError);
    const rollback = caught as CheckpointRollbackError;
    expect((rollback.runError as Error).message).toBe('boom');
    expect((rollback.rollbackError as Error).message).toBe(
      'store patch failed',
    );
    // The original run error is preserved as the cause chain.
    expect((rollback.cause as Error).message).toBe('boom');
  });

  it('uses resolved keyed declarations as the checkpoint tool once dep', async () => {
    const run = { once: createCheckpointOnceMemoStore() };
    let persists = 0;
    let executions = 0;
    const boundary = createCheckpointOnceBoundary(run, async () => {
      persists++;
    });
    const tool = Tool.create({
      name: 'lookup',
      description: 'Look up a value.',
      inputSchema: {
        parse: (input: unknown) => input,
      } as any,
      effect: {
        idempotencyKey: (input) => `lookup:${(input as { id: string }).id}`,
      },
      execute: (_input, context) => {
        executions++;
        expect(context.idempotencyKey).toBe(`lookup:same`);
        return `value:${executions}`;
      },
    });
    const session = Session.create();

    const first = await executePromptTrailTool(
      tool,
      { id: 'same' },
      {
        session,
        durable: boundary,
      },
    );
    const second = await executePromptTrailTool(
      tool,
      { id: 'same' },
      {
        session,
        durable: boundary,
      },
    );
    const advanced = session.addMessage({ type: 'user', content: 'advance' });
    const third = await executePromptTrailTool(
      tool,
      { id: 'same' },
      {
        session: advanced,
        durable: boundary,
      },
    );

    expect(first.content).toEqual([{ type: 'text', text: 'value:1' }]);
    expect(second.content).toEqual([{ type: 'text', text: 'value:1' }]);
    expect(third.content).toEqual([{ type: 'text', text: 'value:1' }]);
    expect(executions).toBe(1);
    expect(persists).toBe(1);
    expect(run.once.run.size).toBe(1);
  });

  it('does not duplicate graph goal prompts when resuming checkpoint app runs', async () => {
    const assistant = Agent.create('graphAssistant').goal(
      'collect',
      'Collect input',
      {
        interaction: 'required',
        model: Source.literal('question?'),
      },
    );
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: { assistant },
    });

    const first = await app.run({
      agent: 'assistant',
      runId: 'run-graph-goal',
      checkpoint: true,
    });
    const second = await app.resume('run-graph-goal');

    expect(first.status).toBe('suspended');
    expect(second.status).toBe('suspended');
    expect(
      second.session.messages.filter(
        (message) => message.content === 'Collect input',
      ),
    ).toHaveLength(1);
  });

  it('uses app checkpoint defaults for send and gateway-created runs', async () => {
    const defaultStore = memoryStore();
    const disabledStore = memoryStore();
    const source = manualGateway();
    const assistant = Agent.create('send-default')
      .inbox('inbound')
      .assistant('reply', () => 'hello');
    const durableApp = PromptTrail.app({
      agents: { assistant },
      store: defaultStore,
      defaults: {
        checkpoint: true,
      },
    });
    const ephemeralApp = PromptTrail.app({
      agents: { assistant },
      gateways: { manual: source },
      store: disabledStore,
    });

    await durableApp.send({
      agent: 'assistant',
      runId: 'run-send-default-durable',
      input: 'hello',
    });
    await ephemeralApp.start();
    await source.emit({
      source: 'manual',
      agent: 'assistant',
      runId: 'run-source-default-ephemeral',
      input: 'hello',
    });

    expect(await defaultStore.get('run-send-default-durable')).toBeDefined();
    expect(
      await disabledStore.get('run-source-default-ephemeral'),
    ).toBeUndefined();
  });

  it('emits checkpoint app lifecycle observer events across resume', async () => {
    const events: string[] = [];
    const assistant = Agent.create('observed')
      .assistant('reply', () => 'hello')
      .awaitInput('input');
    const app = PromptTrail.app({
      agents: { observed: assistant },
      observers: [
        (event) => {
          if (!event.type.startsWith('run.')) {
            return;
          }
          events.push(
            `${event.seq}:${event.type}:${event.stepId ?? '-'}:${event.sessionVersion ?? '-'}`,
          );
        },
      ],
      store: memoryStore(),
    });

    const first = await app.run({
      agent: 'observed',
      runId: 'run-observed',
      checkpoint: true,
    });
    const second = await app.send({
      runId: 'run-observed',
      input: 'continue',
    });

    expect(first.status).toBe('suspended');
    expect(second.status).toBe('done');
    expect(events).toEqual([
      '0:run.started:-:0',
      '3:run.suspended:observed/input:1',
      '4:run.started:-:1',
      '5:run.completed:-:2',
    ]);
  });

  it('routes events from app gateways into checkpoint runs', async () => {
    const source = manualGateway();
    const assistant = Agent.create('assistant')
      .system('system', 'System')
      .inbox('inbox')
      .assistant(
        'reply',
        (session) => `seen:${session.getMessagesByType('user').length}`,
      )
      .awaitInput('next');
    const app = PromptTrail.app({
      agents: { assistant },
      gateways: { manual: source },
      store: memoryStore(),
    });

    await app.start();
    await source.emit({
      source: 'manual',
      agent: 'assistant',
      runId: 'run-6',
      input: 'hello',
      checkpoint: true,
    });

    const result = await app.resume('run-6');

    expect(result.status).toBe('suspended');
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'System',
      'hello',
      'seen:1',
    ]);
  });

  it('serializes concurrent sends to the same runId without racing the cursor', async () => {
    const delay = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    // A slow assistant keeps each resume in flight long enough that two
    // concurrent sends overlap; without per-run serialization they race on the
    // shared graph cursor / inbox / session and lose or double-consume input.
    const assistant = Agent.create('slow-echo')
      .awaitInput('input')
      .assistant('reply', async (session) => {
        await delay(20);
        return `reply:${session.getLastMessage()?.content}`;
      });
    const store = memoryStore();
    const app = PromptTrail.app({
      agents: { slow: assistant },
      store,
    });

    const first = await app.run({
      agent: 'slow',
      runId: 'run-race',
      checkpoint: true,
    });
    expect(first.status).toBe('suspended');

    await Promise.all([
      app.send({ runId: 'run-race', input: 'A' }),
      app.send({ runId: 'run-race', input: 'B' }),
    ]);

    const finalRun = await store.get('run-race');
    const contents = (finalRun?.result?.messages ?? []).map(
      (message) => message.content,
    );
    const userContents = (finalRun?.result?.messages ?? [])
      .filter((message) => message.type === 'user')
      .map((message) => message.content);

    // Both inputs must be consumed exactly once and both replies retained.
    expect(userContents.sort()).toEqual(['A', 'B']);
    expect(contents.filter((content) => content === 'reply:A')).toHaveLength(1);
    expect(contents.filter((content) => content === 'reply:B')).toHaveLength(1);
    expect(contents).toHaveLength(4);
  });

  it('runs sends for different runIds concurrently', async () => {
    let entered = 0;
    let releaseAll: () => void = () => undefined;
    const bothEntered = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    // Each send blocks until two runs are simultaneously in flight. Distinct
    // runIds must not serialize, so both must enter before either is released;
    // if the lock over-serialized, only one would enter and this would hang.
    const assistant = Agent.create('gated')
      .awaitInput('input')
      .assistant('reply', async () => {
        entered += 1;
        if (entered === 2) {
          releaseAll();
        }
        await bothEntered;
        return 'ok';
      });
    const store = memoryStore();
    const app = PromptTrail.app({
      agents: { gated: assistant },
      store,
    });

    await app.run({ agent: 'gated', runId: 'run-a', checkpoint: true });
    await app.run({ agent: 'gated', runId: 'run-b', checkpoint: true });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('different runIds did not run concurrently')),
        1000,
      ),
    );
    const results = await Promise.race([
      Promise.all([
        app.send({ runId: 'run-a', input: 'a' }),
        app.send({ runId: 'run-b', input: 'b' }),
      ]),
      timeout,
    ]);

    expect(results.map((result) => result.status)).toEqual(['done', 'done']);
    expect(entered).toBe(2);
  });
});

async function resolveUntilPendingWrite(
  store: ControlledDelayRunStore,
  predicate: (pending: ControlledDelayRunStore['pending'][number]) => boolean,
): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts++) {
    await waitFor(() => store.pending.length > 0);
    if (predicate(store.pending[0])) {
      return;
    }
    await store.resolveNext();
  }
  throw new Error('Timed out waiting for matching pending store write.');
}

async function resolvePendingWritesUntil(
  predicate: () => boolean,
  store: ControlledDelayRunStore,
): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) {
      return;
    }
    if (store.pending.length > 0) {
      await store.resolveNext();
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error('Timed out resolving pending store writes.');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition.');
}

function applyDelta(
  run: StoredRun<any>,
  delta: SessionCheckpointDelta<any>,
): void {
  const current = run.result ?? run.initial;
  if (current.version >= delta.toVersion) {
    return;
  }
  if (delta.rewrite) {
    run.result = new Session(
      [...delta.appendedMessages],
      { ...(delta.varsSet ?? {}) },
      current.print,
      delta.toVersion,
      delta.toVersion,
    );
    return;
  }
  const vars = { ...current.vars };
  for (const key of delta.varsDeleted ?? []) {
    delete vars[key];
  }
  Object.assign(vars, delta.varsSet);
  run.result = new Session(
    [...current.messages, ...delta.appendedMessages],
    vars,
    current.print,
    delta.toVersion,
  );
}

function upsertOutbox(
  run: StoredRun<any>,
  entry: AssistantDeliveryOutboxEntry,
): void {
  const index = run.outbox.findIndex(
    (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
  );
  if (index >= 0) {
    run.outbox[index] = entry;
  } else {
    run.outbox.push(entry);
  }
}
