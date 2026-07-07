import IORedis from 'ioredis';
import type { Redis } from 'ioredis';
import type {
  Agent,
  AssistantDeliveryOutboxEntry,
  DurableRunStore,
  Inbound,
  OnceScope,
  ProviderSessionBinding,
  SessionCheckpointDelta,
  StoredRun,
  StoredRunPatch,
} from '@prompttrail/core';
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
  private constructor(
    private readonly client: Redis,
    private readonly agents: Record<string, Agent>,
    private readonly keyPrefix: string,
  ) {}

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
    return new RedisRunStore(client, options.agents, keyPrefix);
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

  async create(runId: string, run: StoredRun<any>): Promise<void> {
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
    };
    await this.saveDoc(runId, doc);
    await this.client.sadd(this.indexKey(), runId);
  }

  async patch(runId: string, patch: StoredRunPatch): Promise<void> {
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

  async appendInbox(runId: string, inbound: Inbound): Promise<void> {
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
  ): Promise<void> {
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
  ): Promise<void> {
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
  ): Promise<void> {
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
  ): Promise<void> {
    const doc = await this.loadDoc(runId);
    if (!doc) {
      return;
    }
    doc.providerSessions[nodePath] = binding;
    await this.saveDoc(runId, doc);
  }

  async delete(runId: string): Promise<void> {
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
      },
      this.agents,
    );
  }
}
