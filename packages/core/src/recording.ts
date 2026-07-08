import { createHash } from 'node:crypto';
import type {
  ModelCallRecord,
  NodeBreadcrumb,
  RecordLevel,
  RunRecordEntry,
  ToolCallRecord,
} from './durable';
import type { Message } from './message';
import type { Session } from './session';

/**
 * B0 recording — capture half of the replay layer (design-docs
 * replay-and-self-deploy.md, Appendix B0). A per-run {@link Recorder} is created
 * when `recordLevel !== 'off'`; it assigns a monotonic per-run `seq`, digests
 * requests/args deterministically, and appends entries to the store's
 * seq-ordered recording stream via a fire-ordered async sink.
 *
 * The three funnels feed this handle:
 * - node-enter breadcrumbs (graph_executor `executeGraphNode`),
 * - model calls at the `wrapModelCall` boundary (assistant via
 *   `executeRuntimeModelCall`, plus Codex/Claude turns — three per-provider
 *   normalizers, NOT one unified hash, per round-3),
 * - tool calls at the `executePromptTrailTool` funnel (PromptTrail + graph
 *   ai-sdk-wrapped tools; builtin/MCP/vendor-loop tools ride the model response).
 */

/**
 * Deterministic stable JSON stringify with recursively sorted object keys, so a
 * digest is stable across processes and independent of key insertion order.
 * `undefined` and functions are dropped (objects) or nulled (array holes),
 * matching JSON semantics for a content hash.
 */
export function stableStringify(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'number') {
    return Number.isFinite(value as number) ? String(value) : 'null';
  }
  if (type === 'boolean') {
    return String(value);
  }
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (type === 'bigint') {
    return JSON.stringify(`${(value as bigint).toString()}n`);
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol') {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => {
      const v = record[key];
      return (
        v !== undefined && typeof v !== 'function' && typeof v !== 'symbol'
      );
    })
    .sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${stringify(record[key])}`,
  );
  return `{${parts.join(',')}}`;
}

/**
 * Stable content digest (sha256 hex of {@link stableStringify}). Exported for
 * B1 replay, which digests the candidate's live request the same way so a
 * `request-hash` match is well-defined.
 */
export function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * Normalize a session's messages down to the deterministic, prompt-defining
 * fields for request digesting. Volatile per-message `attrs` (model metadata,
 * timestamps, ids) are intentionally dropped so identical prompts hash equal.
 *
 * NOTE (byte/file content): `bytes`/`providerFile` parts are already
 * persistence-safe placeholders by the time a `Session` exists
 * (`makeMessagePersistenceSafe` runs in the Session constructor), so there is
 * nothing raw to digest here. Per round-3, v1 excludes byte/file-content runs
 * from the replay corpus at extraction time rather than digesting bytes.
 */
export function normalizeMessagesForDigest(
  messages: readonly Message[],
): unknown {
  return messages.map((message) => {
    const normalized: Record<string, unknown> = {
      type: message.type,
      content: message.content,
    };
    if (message.toolCalls !== undefined) {
      normalized.toolCalls = message.toolCalls;
    }
    if (message.type === 'tool_result' && message.toolCallId !== undefined) {
      normalized.toolCallId = message.toolCallId;
    }
    if (message.structuredContent !== undefined) {
      normalized.structuredContent = message.structuredContent;
    }
    return normalized;
  });
}

export interface RecorderModelInput {
  /** Graph path of the node that issued the call; scopes `callIndex`. */
  nodePath: string;
  /** Provider identity: 'assistant' | 'codex' | 'claude' | ... */
  provider: string;
  /** Session whose messages form the model input (the prompt). */
  requestSession: Session<any>;
  /**
   * Per-provider request metadata folded into the digest and (at `full`) the
   * stored request: assistant threads its resolved LLMOptions manifest (system,
   * params, `toolDefsDigest`); Codex/Claude thread their turn/provider config.
   */
  requestMeta?: unknown;
  /** ModelOutput-shaped response (opaque to the store). */
  response: unknown;
}

export interface RecorderToolInput {
  /** Graph path of the tools node; scopes `callIndex`. */
  nodePath: string;
  toolName: string;
  /** Parsed tool arguments — digested always, stored only at `full`. */
  input: unknown;
  /** CallToolResult-shaped result (opaque to the store). */
  result: unknown;
  /** Declared effect metadata, if any. */
  effect?: unknown;
}

export interface RecorderNodeInput {
  nodePath: string;
  nodeType: string;
  branch?: string;
}

/**
 * Per-run capture handle. All three emit methods assign `seq` synchronously (so
 * order is fixed even when the caller does not await) and enqueue the append on
 * a fire-ordered promise chain — appends never reorder. Call {@link drain} at a
 * terminal boundary (completion/suspension) to flush pending appends.
 */
export interface Recorder {
  readonly level: RecordLevel;
  /**
   * Path of the node currently executing; set on each node entry and used as a
   * fallback nodePath for model/tool calls that do not thread one explicitly
   * (e.g. structured/parallel model calls via `executeSource`).
   */
  currentNodePath?: string;
  node(input: RecorderNodeInput): void;
  model(input: RecorderModelInput): void;
  tool(input: RecorderToolInput): void;
  /** Await all pending appends. */
  drain(): Promise<void>;
}

export interface CreateRecorderOptions {
  level: Exclude<RecordLevel, 'off'>;
  /**
   * Highest `seq` already present in the run's recording (recording spans
   * resumes). The next assigned seq is `initialSeq + 1`; pass `-1` for a fresh
   * run so the first seq is `0`.
   */
  initialSeq: number;
  /** Append sink — the store's (fenced) `appendRecord` for this run. */
  append: (entry: RunRecordEntry) => Promise<void>;
  /** Injected clock for record timestamps (defaults to the app's `now`). */
  now?: () => number;
}

/**
 * Highest seq currently present in a run's recording stream, or `-1` when the
 * stream is empty/absent. Used to seed {@link createRunRecorder} so seq stays
 * monotonic across suspend/resume.
 */
export function maxRecordSeq(
  recording: readonly RunRecordEntry[] | undefined,
): number {
  let max = -1;
  for (const entry of recording ?? []) {
    if (entry.record.seq > max) {
      max = entry.record.seq;
    }
  }
  return max;
}

export function createRunRecorder(options: CreateRecorderOptions): Recorder {
  const now = options.now ?? Date.now;
  const level = options.level;
  const full = level === 'full';
  let seq = options.initialSeq;
  const modelCallIndex = new Map<string, number>();
  const toolCallIndex = new Map<string, number>();
  // Fire-ordered append chain: appends are enqueued in seq order and never
  // reorder. A per-append catch keeps the chain alive on a transient store
  // error (recording is opt-in/best-effort and must not fail the run).
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (entry: RunRecordEntry): void => {
    chain = chain.then(() =>
      options.append(entry).catch((error) => {
        console.warn(
          `Recording append failed for seq ${entry.record.seq}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }),
    );
  };

  const nextCallIndex = (
    map: Map<string, number>,
    nodePath: string,
  ): number => {
    const index = map.get(nodePath) ?? 0;
    map.set(nodePath, index + 1);
    return index;
  };

  const recorder: Recorder = {
    level,
    currentNodePath: undefined,
    node(input) {
      const record: NodeBreadcrumb = {
        seq: ++seq,
        nodePath: input.nodePath,
        nodeType: input.nodeType,
        at: now(),
      };
      if (input.branch !== undefined) {
        record.branch = input.branch;
      }
      enqueue({ kind: 'node', record });
    },
    model(input) {
      const normalizedRequest = {
        messages: normalizeMessagesForDigest(input.requestSession.messages),
        meta: input.requestMeta ?? null,
      };
      const requestDigest = digest({
        provider: input.provider,
        request: normalizedRequest,
      });
      const record: ModelCallRecord = {
        seq: ++seq,
        nodePath: input.nodePath,
        callIndex: nextCallIndex(modelCallIndex, input.nodePath),
        provider: input.provider,
        requestDigest,
        response: input.response,
        at: now(),
      };
      // 'decisions' drops the normalized request; digests are always recorded.
      if (full) {
        record.request = normalizedRequest;
      }
      enqueue({ kind: 'model', record });
    },
    tool(input) {
      const argsDigest = digest(input.input);
      const record: ToolCallRecord = {
        seq: ++seq,
        nodePath: input.nodePath,
        callIndex: nextCallIndex(toolCallIndex, input.nodePath),
        toolName: input.toolName,
        argsDigest,
        result: input.result,
        at: now(),
      };
      // 'decisions' drops the parsed input; digests are always recorded.
      if (full) {
        record.input = input.input;
      }
      if (input.effect !== undefined) {
        record.effect = input.effect;
      }
      enqueue({ kind: 'tool', record });
    },
    drain() {
      return chain;
    },
  };
  return recorder;
}
