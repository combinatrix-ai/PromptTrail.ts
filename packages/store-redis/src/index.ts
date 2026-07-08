import IORedis from 'ioredis';
import type { Redis } from 'ioredis';
import type {
  Agent,
  AssistantDeliveryOutboxEntry,
  DurableRunStore,
  DurableTimer,
  Inbound,
  OnceScope,
  ProviderSessionBinding,
  RunStoreLease,
  RunStoreLeaseState,
  SessionCheckpointDelta,
  StoredRun,
  StoredRunPatch,
} from '@prompttrail/core';
import { assertFenceAllowed } from '@prompttrail/core';
import {
  jsonOrNull,
  normalizeStoredMessages,
  parseJson,
  parseJsonRequired,
  reconstructStoredRun,
  type ReconstructOnceEntry,
} from '@prompttrail/store-common';

// ---------------------------------------------------------------------------
// Document shape stored under each key
// ---------------------------------------------------------------------------

/**
 * The raw JSON document stored in Redis for a single run.
 * This contains the exact components that reconstructStoredRun consumes.
 */
interface RunDocument {
  agentName: string;
  status: StoredRun<any>['status'];
  graphCursor?: number;
  graphSuspendedAt?: string;
  context?: unknown;
  /** Session.toJSON() snapshot captured at run creation. */
  initialSession: unknown;
  graphManifest?: unknown;
  /** Ordered list of session checkpoint deltas (seq = array index). */
  deltas: SerializedDelta[];
  /** Once-memo entries (upserted by scope+key). */
  once: SerializedOnce[];
  /** Inbound messages ordered by offset. */
  inbox: Inbound[];
  /** Outbox entries (upserted by idempotencyKey). */
  outbox: AssistantDeliveryOutboxEntry[];
  /** Provider session bindings keyed by nodePath. */
  providerSessions: Record<string, ProviderSessionBinding>;
  /** Durable timers, upserted by id. Optional so old docs stay readable. */
  timers?: DurableTimer[];
}

interface SerializedDelta {
  fromVersion: number;
  toVersion: number;
  /** JSON-serialized appendedMessages array. */
  appendedMessagesJson: string;
  varsSetJson: string | null;
  varsDeletedJson: string | null;
  rewrite: boolean;
}

interface SerializedOnce {
  scope: OnceScope;
  key: string;
  valueJson: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RedisRunStoreOptions {
  /** Pre-constructed ioredis client. Mutually exclusive with `url`. */
  client?: Redis;
  /** Redis connection URL. Used if `client` is not provided. */
  url?: string;
  /** Agent registry used when reconstructing runs. */
  agents: Record<string, Agent>;
  /**
   * Key namespace prefix. Defaults to `"prompttrail"`.
   * All keys written by this store will be prefixed with `${keyPrefix}:`.
   */
  keyPrefix?: string;
  /** Injectable clock for the lease (defaults to `Date.now`). Tests only. */
  now?: () => number;
}

interface RedisLeaseDoc {
  holder: string;
  token: number;
  expiresAt: number;
  ttlMs: number;
}

/**
 * Store-wide single-writer lease stored as a single JSON doc under
 * `${keyPrefix}:lease`.
 *
 * Atomicity note: acquire/renew/handoff use a plain GET → mutate → SET
 * (read-modify-write). This is BEST-EFFORT under ioredis-mock, whose
 * WATCH/MULTI support is unreliable; the single-writer arbitration this lease
 * provides is serialized by the launcher/heartbeat, so a lock-free RMW is
 * acceptable. A production Redis deployment should upgrade this to a WATCH/MULTI
 * (optimistic) or a Lua script for strict cross-process atomicity. The fencing
 * token persists in the doc, so it stays monotonic across reopens.
 */
class RedisLease implements RunStoreLease {
  constructor(
    private readonly client: Redis,
    private readonly leaseKey: string,
    private readonly now: () => number,
  ) {}

  private async readDoc(): Promise<RedisLeaseDoc | undefined> {
    const raw = await this.client.get(this.leaseKey);
    return raw === null ? undefined : (JSON.parse(raw) as RedisLeaseDoc);
  }

  private async write(doc: RedisLeaseDoc): Promise<void> {
    await this.client.set(this.leaseKey, JSON.stringify(doc));
  }

  private isActive(doc: RedisLeaseDoc | undefined, at: number): boolean {
    return doc !== undefined && doc.expiresAt > at;
  }

  private view(doc: RedisLeaseDoc): RunStoreLeaseState {
    return { holder: doc.holder, token: doc.token, expiresAt: doc.expiresAt };
  }

  /** Active-token read used by the store's fence check. */
  async activeToken(): Promise<number | undefined> {
    const doc = await this.readDoc();
    return this.isActive(doc, this.now()) ? doc!.token : undefined;
  }

  async acquire(
    holder: string,
    ttlMs: number,
  ): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const doc = await this.readDoc();
    if (this.isActive(doc, at)) {
      if (doc!.holder !== holder) {
        return undefined;
      }
      const renewed: RedisLeaseDoc = {
        holder,
        token: doc!.token,
        expiresAt: at + ttlMs,
        ttlMs,
      };
      await this.write(renewed);
      return this.view(renewed);
    }
    const next: RedisLeaseDoc = {
      holder,
      token: (doc?.token ?? 0) + 1,
      expiresAt: at + ttlMs,
      ttlMs,
    };
    await this.write(next);
    return this.view(next);
  }

  async renew(
    holder: string,
    ttlMs?: number,
  ): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const doc = await this.readDoc();
    if (!this.isActive(doc, at) || doc!.holder !== holder) {
      return undefined;
    }
    const ttl = ttlMs ?? doc!.ttlMs;
    const renewed: RedisLeaseDoc = {
      holder,
      token: doc!.token,
      expiresAt: at + ttl,
      ttlMs: ttl,
    };
    await this.write(renewed);
    return this.view(renewed);
  }

  async release(holder: string): Promise<void> {
    const at = this.now();
    const doc = await this.readDoc();
    if (this.isActive(doc, at) && doc!.holder === holder) {
      await this.write({ ...doc!, expiresAt: 0 });
    }
  }

  async handoff(opts: {
    from: string;
    to: string;
    ttlMs: number;
  }): Promise<RunStoreLeaseState | undefined> {
    const at = this.now();
    const doc = await this.readDoc();
    if (!this.isActive(doc, at) || doc!.holder !== opts.from) {
      return undefined;
    }
    const next: RedisLeaseDoc = {
      holder: opts.to,
      token: doc!.token + 1,
      expiresAt: at + opts.ttlMs,
      ttlMs: opts.ttlMs,
    };
    await this.write(next);
    return this.view(next);
  }

  async current(): Promise<RunStoreLeaseState | undefined> {
    const doc = await this.readDoc();
    return this.isActive(doc, this.now()) ? this.view(doc!) : undefined;
  }
}

// ---------------------------------------------------------------------------
// RedisRunStore
// ---------------------------------------------------------------------------

/**
 * Redis durable run store for PromptTrail.
 *
 * Storage model: ONE JSON document per run under `${keyPrefix}:run:${runId}`,
 * plus a Redis SET `${keyPrefix}:runs` that tracks live run IDs.
 *
 * Reads (get/has/entries) are LAZY: each call fetches and reconstructs a fresh
 * StoredRun from the stored document. There is no in-memory hydration at open.
 *
 * Writes use a READ-MODIFY-WRITE pattern (GET → mutate → SET). This is correct
 * for a single-process writer. Multi-writer safety would require WATCH/MULTI or
 * a single-writer lease (roadmap §2) — that is out of scope here.
 *
 * Construction is async: use `RedisRunStore.open(options)`.
 */
export class RedisRunStore implements DurableRunStore {
  readonly lease: RunStoreLease;
  private readonly redisLease: RedisLease;

  private constructor(
    private readonly client: Redis,
    private readonly agents: Record<string, Agent>,
    private readonly keyPrefix: string,
    now: () => number,
  ) {
    this.redisLease = new RedisLease(client, `${keyPrefix}:lease`, now);
    this.lease = this.redisLease;
  }

  private async assertFence(fence: number | undefined): Promise<void> {
    assertFenceAllowed(await this.redisLease.activeToken(), fence);
  }

  /**
   * Open a RedisRunStore.
   * Pass an injected `client` (e.g. ioredis-mock) for testing or a `url` for
   * production use. If neither is provided, connects to the default Redis URL
   * (redis://localhost:6379).
   */
  static async open(options: RedisRunStoreOptions): Promise<RedisRunStore> {
    const keyPrefix = options.keyPrefix ?? 'prompttrail';
    let client: Redis;
    if (options.client) {
      client = options.client;
    } else {
      // ioredis accepts undefined url — falls back to default 127.0.0.1:6379
      client = new IORedis(options.url as string);
    }
    return new RedisRunStore(
      client,
      options.agents,
      keyPrefix,
      options.now ?? Date.now,
    );
  }

  // -------------------------------------------------------------------------
  // Key helpers
  // -------------------------------------------------------------------------

  private runKey(runId: string): string {
    return `${this.keyPrefix}:run:${runId}`;
  }

  private indexKey(): string {
    return `${this.keyPrefix}:runs`;
  }

  // -------------------------------------------------------------------------
  // Document helpers
  // -------------------------------------------------------------------------

  private async loadDoc(runId: string): Promise<RunDocument | undefined> {
    const raw = await this.client.get(this.runKey(runId));
    if (raw === null) {
      return undefined;
    }
    return JSON.parse(raw) as RunDocument;
  }

  private async saveDoc(runId: string, doc: RunDocument): Promise<void> {
    await this.client.set(this.runKey(runId), JSON.stringify(doc));
  }

  // -------------------------------------------------------------------------
  // DurableRunStore — reads
  // -------------------------------------------------------------------------

  async get(runId: string): Promise<StoredRun<any> | undefined> {
    const doc = await this.loadDoc(runId);
    if (!doc) {
      return undefined;
    }
    return this.reconstructFromDoc(doc);
  }

  async has(runId: string): Promise<boolean> {
    const exists = await this.client.exists(this.runKey(runId));
    return exists === 1;
  }

  async entries(): Promise<Iterable<[string, StoredRun<any>]>> {
    const runIds = await this.client.smembers(this.indexKey());
    const pairs: [string, StoredRun<any>][] = [];
    for (const runId of runIds) {
      const run = await this.get(runId);
      if (run !== undefined) {
        pairs.push([runId, run]);
      }
    }
    return pairs;
  }

  // -------------------------------------------------------------------------
  // DurableRunStore — writes
  // -------------------------------------------------------------------------

  async create(
    runId: string,
    run: StoredRun<any>,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const doc: RunDocument = {
      agentName: run.agentName,
      status: run.status,
      graphCursor: run.graphCursor,
      graphSuspendedAt: run.graphSuspendedAt,
      context: run.context,
      initialSession: run.initial.toJSON(),
      graphManifest: run.graphManifest,
      deltas: [],
      once: [],
      inbox: [],
      outbox: [],
      providerSessions: {},
      timers: [],
    };
    await this.saveDoc(runId, doc);
    await this.client.sadd(this.indexKey(), runId);
  }

  async patch(
    runId: string,
    patch: StoredRunPatch,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const doc = await this.loadDoc(runId);
    if (!doc) {
      // Run has been deleted; no-op (mirrors relational store behaviour)
      return;
    }

    if ('agentName' in patch) {
      doc.agentName = patch.agentName ?? doc.agentName;
    }
    if ('status' in patch) {
      doc.status = patch.status ?? doc.status;
    }
    if ('graphCursor' in patch) {
      doc.graphCursor = patch.graphCursor ?? undefined;
    }
    if ('graphSuspendedAt' in patch) {
      doc.graphSuspendedAt = patch.graphSuspendedAt ?? undefined;
    }
    if ('context' in patch) {
      doc.context = patch.context;
    }
    if ('graphManifest' in patch) {
      doc.graphManifest = patch.graphManifest;
    }

    await this.saveDoc(runId, doc);
  }

  async appendInbox(
    runId: string,
    inbound: Inbound,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const doc = await this.loadDoc(runId);
    if (!doc) {
      return;
    }
    // Offset idempotency: only append if no existing entry has the same offset.
    const alreadyPresent = doc.inbox.some((i) => i.offset === inbound.offset);
    if (!alreadyPresent) {
      doc.inbox.push(inbound);
    }
    await this.saveDoc(runId, doc);
  }

  async appendSessionDelta(
    runId: string,
    delta: SessionCheckpointDelta<any>,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const doc = await this.loadDoc(runId);
    if (!doc) {
      return;
    }
    const serialized: SerializedDelta = {
      fromVersion: delta.fromVersion,
      toVersion: delta.toVersion,
      appendedMessagesJson: JSON.stringify(delta.appendedMessages),
      varsSetJson: jsonOrNull(delta.varsSet),
      varsDeletedJson: jsonOrNull(delta.varsDeleted),
      rewrite: delta.rewrite === true,
    };
    doc.deltas.push(serialized);
    await this.saveDoc(runId, doc);
  }

  async recordOnce(
    runId: string,
    scope: OnceScope,
    key: string,
    value: unknown,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const doc = await this.loadDoc(runId);
    if (!doc) {
      return;
    }
    const idx = doc.once.findIndex((o) => o.scope === scope && o.key === key);
    const entry: SerializedOnce = {
      scope,
      key,
      valueJson: JSON.stringify(value),
    };
    if (idx === -1) {
      doc.once.push(entry);
    } else {
      doc.once[idx] = entry;
    }
    await this.saveDoc(runId, doc);
  }

  async upsertOutbox(
    runId: string,
    entry: AssistantDeliveryOutboxEntry,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const doc = await this.loadDoc(runId);
    if (!doc) {
      return;
    }
    const idx = doc.outbox.findIndex(
      (o) => o.idempotencyKey === entry.idempotencyKey,
    );
    if (idx === -1) {
      doc.outbox.push(entry);
    } else {
      doc.outbox[idx] = entry;
    }
    await this.saveDoc(runId, doc);
  }

  async recordProviderSession(
    runId: string,
    nodePath: string,
    binding: ProviderSessionBinding,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const doc = await this.loadDoc(runId);
    if (!doc) {
      return;
    }
    doc.providerSessions[nodePath] = binding;
    await this.saveDoc(runId, doc);
  }

  async upsertTimer(
    runId: string,
    timer: DurableTimer,
    fence?: number,
  ): Promise<void> {
    await this.assertFence(fence);
    const doc = await this.loadDoc(runId);
    if (!doc) {
      return;
    }
    const timers = (doc.timers ??= []);
    const idx = timers.findIndex((t) => t.id === timer.id);
    if (idx === -1) {
      timers.push(timer);
    } else {
      timers[idx] = timer;
    }
    await this.saveDoc(runId, doc);
  }

  async delete(runId: string, fence?: number): Promise<void> {
    await this.assertFence(fence);
    await this.client.del(this.runKey(runId));
    await this.client.srem(this.indexKey(), runId);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Gracefully close the Redis client connection. */
  async close(): Promise<void> {
    await this.client.quit();
    this.client.disconnect();
  }

  // -------------------------------------------------------------------------
  // Reconstruction
  // -------------------------------------------------------------------------

  private reconstructFromDoc(doc: RunDocument): StoredRun<any> {
    // Deserialize deltas: parse appendedMessages JSON + normalize.
    const deltas: SessionCheckpointDelta<any>[] = doc.deltas.map((d) => ({
      fromVersion: d.fromVersion,
      toVersion: d.toVersion,
      appendedMessages: normalizeStoredMessages(
        parseJsonRequired(d.appendedMessagesJson),
      ),
      varsSet: parseJson(d.varsSetJson),
      varsDeleted: parseJson(d.varsDeletedJson),
      rewrite: d.rewrite,
    }));

    // Deserialize once entries.
    const once: ReconstructOnceEntry[] = doc.once.map((o) => ({
      scope: o.scope,
      key: o.key,
      value: parseJson(o.valueJson),
    }));

    return reconstructStoredRun(
      {
        agentName: doc.agentName,
        status: doc.status,
        graphCursor: doc.graphCursor,
        graphSuspendedAt: doc.graphSuspendedAt,
        context: doc.context,
        initialSession: doc.initialSession,
        graphManifest: doc.graphManifest,
        deltas,
        once,
        inbox: doc.inbox,
        outbox: doc.outbox,
        providerSessions: doc.providerSessions,
        timers: doc.timers ?? [],
      },
      this.agents,
    );
  }
}
