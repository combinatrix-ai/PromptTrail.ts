import type { CallToolResult, ReplayLeafSource } from './capabilities';
import type {
  AssistantDeliveryOutboxInput,
  ModelCallRecord,
  NodeBreadcrumb,
  RunRecordEntry,
  StoredRun,
  ToolCallRecord,
} from './durable';
import { executeAgentGraph } from './graph_executor';
import type { GraphInboundInput } from './graph_executor';
import type { Message } from './message';
import { createRunRecorder, digest, stableStringify } from './recording';
import type { DeliveryTarget } from './runtime_bindings';
import { assistantDeliveryKey } from './runtime_delivery_keys';
import type { Session, Vars } from './session';
import {
  resetSourceRuntimeDeterminism,
  setSourceRuntimeDeterminism,
} from './source';
import type { Agent } from './templates';

/**
 * B1 — positional replay executor (design-docs replay-and-self-deploy.md §2,
 * §8). This module re-runs a recorded {@link StoredRun} through the REAL
 * execution engine ({@link executeAgentGraph}), serving every external leaf
 * (model/provider calls, tool calls) from a cassette built out of the run's B0
 * recording instead of hitting a provider or executing a tool. Side effects are
 * sealed: no real store, no delivery drivers, deliveries are captured into
 * `trace.wouldDeliver` rather than sent.
 *
 * SCOPE (B1 only): positional keying — the Nth model call is served the Nth
 * recorded model response, the Nth tool call the Nth recorded tool result (each
 * kind a separate FIFO queue). `agent` defaults to `run.agent`. The only miss
 * policy is `error`: an exhausted cassette or a provider/kind mismatch throws a
 * {@link ReplayMissError} with position and node-path context. There is no
 * differ, no request-hash / node-path keying, and no green-vs-blue comparison —
 * those are B2+. A CHANGED agent (e.g. different prompt text) still replays
 * under positional keying by design; divergence detection is deferred to B2.
 *
 * The clock and rng are pinned so non-LLM nondeterminism cannot manufacture a
 * false divergence: the recorder timestamps use a fixed `now`, the graph
 * `eventScopeId` is pinned (avoiding the random scope-id seed), and the two
 * direct `Date.now`/`Math.random` sites in `source.ts` are pinned via the
 * module-level source-determinism override for the duration of the replay.
 */

/** Fixed epoch used for record timestamps during replay (pinned clock). */
const REPLAY_FIXED_NOW = 0;
/** Stable seed so two replays of the same cassette pin rng identically. */
const REPLAY_RNG_SEED = 0x1b1b1b1b;
/** Stable event scope / conversation id used when the caller supplies none. */
const REPLAY_EVENT_SCOPE = 'replay';

/**
 * The positional record of every external interaction a recorded run produced,
 * bucketed per kind and consumed in seq order during replay. Built from a
 * {@link StoredRun}'s B0 recording by {@link buildCassette}.
 */
export interface Cassette {
  /** Model/provider outputs (assistant/Codex/Claude), in record order. */
  model: ModelCallRecord[];
  /** Tool results (PromptTrail + graph ai-sdk-wrapped tools), in record order. */
  tools: ToolCallRecord[];
  /** Node-enter breadcrumbs, in record order (control-flow reference). */
  nodes: NodeBreadcrumb[];
}

/**
 * The comparable trace a replay emits (design-docs §2). It is the B1 subset of
 * the doc's sketch — the keying fields are omitted since B1 is positional-only.
 */
export interface ReplayTrace {
  /** Node-path breadcrumbs emitted during the replay, in order. */
  nodes: string[];
  /** Each served model leaf: where it fired and the recorded output. */
  modelCalls: { nodePath: string; hit: true; output: unknown }[];
  /** Each served tool leaf: the tool, its arg digest, and hit=true. */
  toolCalls: { name: string; argsDigest: string; hit: true }[];
  /** Structured outputs the replay produced (from message structuredContent). */
  structured: unknown[];
  /** The final delivered assistant message(s) of the replay. */
  finalReply: Message[];
  /** Deliveries captured but never sent (no drivers on the throwaway path). */
  wouldDeliver: AssistantDeliveryOutboxInput[];
  /** Always empty under B1's `miss: 'error'` policy (a miss throws instead). */
  misses: { at: string; kind: 'model' | 'tool' }[];
}

export interface ReplayOptions {
  /** The cassette to replay against; defaults to `buildCassette(run)`. */
  cassette?: Cassette;
  /**
   * The agent to replay; defaults to `run.agent`. B1 supports a changed agent
   * under positional keying (divergence detection is B2).
   */
  agent?: Agent<Vars>;
  /** Miss policy. B1 supports only `error` (strict reproduction). */
  miss?: 'error';
  /** Pinned clock for record timestamps; defaults to a fixed epoch. */
  now?: () => number;
  /** Pinned event scope / conversation id; defaults to a stable constant. */
  eventScopeId?: string;
}

export interface ReplayResult<TVars extends Vars = Vars> {
  trace: ReplayTrace;
  session: Session<TVars>;
  /**
   * The record stream the replay itself emitted (node/model/tool), seq-ordered.
   * A faithful replay reproduces the original run's recording; {@link
   * replaySelfCheck} compares the two at digest level.
   */
  recording: RunRecordEntry[];
}

/**
 * Thrown when the cassette cannot serve a leaf the engine asked for under the
 * `miss: 'error'` policy — the cassette is exhausted or the recorded entry does
 * not match the kind/provider the engine reached. Carries the queue position
 * and node path so a divergence pinpoints where the replay left the recording.
 */
export class ReplayMissError extends Error {
  readonly kind: 'model' | 'tool';
  readonly position: number;
  readonly nodePath: string;
  readonly expected: string;
  readonly actual: string;
  constructor(details: {
    kind: 'model' | 'tool';
    position: number;
    nodePath: string;
    expected: string;
    actual: string;
  }) {
    super(
      `Replay miss at ${details.kind} position ${details.position} ` +
        `(nodePath ${details.nodePath}): expected ${details.expected}, ` +
        `got ${details.actual}.`,
    );
    this.name = 'ReplayMissError';
    this.kind = details.kind;
    this.position = details.position;
    this.nodePath = details.nodePath;
    this.expected = details.expected;
    this.actual = details.actual;
  }
}

/**
 * Build a {@link Cassette} from a recorded run by walking `run.recording` in seq
 * order and bucketing entries per kind. Throws when the run was not recorded
 * (`recordLevel` `off`/absent or empty recording) or when it carries byte/file
 * content placeholders (excluded from the v1 replay corpus — such content
 * cannot be re-digested or re-sent faithfully).
 */
export function buildCassette(run: StoredRun<any>): Cassette {
  if (!run.recordLevel || run.recordLevel === 'off') {
    throw new Error(
      'Cannot build a replay cassette: the run was not recorded ' +
        `(recordLevel ${run.recordLevel ?? 'undefined'}). Record with ` +
        "recording: 'decisions' or 'full' first.",
    );
  }
  const recording = run.recording ?? [];
  if (recording.length === 0) {
    throw new Error(
      'Cannot build a replay cassette: the run has an empty recording stream.',
    );
  }
  assertNoOmittedByteContent(run);

  const entries = [...recording].sort((a, b) => a.record.seq - b.record.seq);
  const cassette: Cassette = { model: [], tools: [], nodes: [] };
  for (const entry of entries) {
    if (entry.kind === 'model') {
      cassette.model.push(entry.record);
    } else if (entry.kind === 'tool') {
      cassette.tools.push(entry.record);
    } else {
      cassette.nodes.push(entry.record);
    }
  }
  return cassette;
}

const OMITTED_BYTES_MARKER = 'prompttrail://omitted-bytes';

function assertNoOmittedByteContent(run: StoredRun<any>): void {
  const carriesOmittedBytes = (session: Session<any> | undefined): boolean =>
    session !== undefined &&
    stableStringify(session.messages).includes(OMITTED_BYTES_MARKER);
  if (carriesOmittedBytes(run.initial) || carriesOmittedBytes(run.result)) {
    throw new Error(
      'Cannot build a replay cassette: the run carries byte/file content ' +
        '(omitted-bytes placeholders). Such runs are excluded from the v1 ' +
        'replay corpus — they cannot be re-digested or re-sent faithfully.',
    );
  }
}

/**
 * The positional leaf server: hands out cassette entries in FIFO order per kind
 * and records each served leaf into the trace. A miss throws {@link
 * ReplayMissError} (the only B1 policy).
 */
class PositionalReplaySource implements ReplayLeafSource {
  private modelIndex = 0;
  private toolIndex = 0;
  readonly modelCalls: ReplayTrace['modelCalls'] = [];
  readonly toolCalls: ReplayTrace['toolCalls'] = [];

  constructor(private readonly cassette: Cassette) {}

  model(input: { nodePath: string; provider: string }): unknown {
    const record = this.cassette.model[this.modelIndex];
    if (!record) {
      throw new ReplayMissError({
        kind: 'model',
        position: this.modelIndex,
        nodePath: input.nodePath,
        expected: 'a recorded model call',
        actual: 'cassette exhausted',
      });
    }
    if (record.provider !== input.provider) {
      throw new ReplayMissError({
        kind: 'model',
        position: this.modelIndex,
        nodePath: input.nodePath,
        expected: `provider ${record.provider}`,
        actual: `provider ${input.provider}`,
      });
    }
    this.modelIndex += 1;
    const output = cloneValue(record.response);
    this.modelCalls.push({ nodePath: input.nodePath, hit: true, output });
    return output;
  }

  tool(input: {
    nodePath: string;
    toolName: string;
    argsDigest: string;
  }): CallToolResult {
    const record = this.cassette.tools[this.toolIndex];
    if (!record) {
      throw new ReplayMissError({
        kind: 'tool',
        position: this.toolIndex,
        nodePath: input.nodePath,
        expected: 'a recorded tool call',
        actual: 'cassette exhausted',
      });
    }
    this.toolIndex += 1;
    this.toolCalls.push({
      name: input.toolName,
      argsDigest: input.argsDigest,
      hit: true,
    });
    return cloneValue(record.result) as CallToolResult;
  }
}

/**
 * Re-run a recorded run through the real engine with every external leaf served
 * from the cassette (positional, `miss: 'error'`). Deliveries are captured into
 * `trace.wouldDeliver`, never sent; the clock/rng are pinned. Returns the
 * emitted {@link ReplayTrace}, the resulting session, and the fresh record
 * stream the replay produced (for {@link replaySelfCheck}).
 */
export async function replayRun<TVars extends Vars = Vars>(
  run: StoredRun<TVars>,
  opts: ReplayOptions = {},
): Promise<ReplayResult<TVars>> {
  if (opts.miss !== undefined && opts.miss !== 'error') {
    throw new Error(
      `Replay miss policy '${opts.miss}' is not supported in B1 (only 'error').`,
    );
  }
  const cassette = opts.cassette ?? buildCassette(run as StoredRun<any>);
  const agent = (opts.agent ?? run.agent) as Agent<TVars>;
  const now = opts.now ?? (() => REPLAY_FIXED_NOW);
  const eventScopeId = opts.eventScopeId ?? REPLAY_EVENT_SCOPE;

  const source = new PositionalReplaySource(cassette);
  const recording: RunRecordEntry[] = [];
  // A fresh recorder captures the replay's own record stream (node breadcrumbs
  // + the substituted model/tool records) into memory — never the real store.
  // Digests are always recorded ('decisions' suffices), so self-check can
  // compare requestDigest/argsDigest against the original recording.
  const recorder = createRunRecorder({
    level: 'decisions',
    initialSeq: -1,
    append: async (entry) => {
      recording.push(entry);
    },
    now,
  });

  const rng = makeSeededRng(REPLAY_RNG_SEED);
  setSourceRuntimeDeterminism({ now, random: rng });
  let session: Session<TVars>;
  try {
    session = await executeAgentGraph<TVars>(agent.toGraph(), {
      session: run.initial,
      input: inboxToGraphInput(run),
      services: cloneValue(run.services),
      eventScopeId,
      recorder,
      replay: source,
    });
  } finally {
    resetSourceRuntimeDeterminism();
    await recorder.drain();
  }

  const trace: ReplayTrace = {
    nodes: recording
      .filter(
        (entry): entry is Extract<RunRecordEntry, { kind: 'node' }> =>
          entry.kind === 'node',
      )
      .map((entry) => entry.record.nodePath),
    modelCalls: source.modelCalls,
    toolCalls: source.toolCalls,
    structured: collectStructured(session),
    finalReply: assistantMessages(session),
    wouldDeliver: computeWouldDeliver(run, session, eventScopeId),
    misses: [],
  };

  return { trace, session, recording };
}

export interface ReplaySelfCheck {
  /** True iff the replay reproduced the original recording at digest level. */
  identical: boolean;
  /** The first seq-position where replay and original diverge, if any. */
  firstDivergence?: {
    index: number;
    expected: RecordSignature | undefined;
    actual: RecordSignature | undefined;
  };
}

interface RecordSignature {
  kind: RunRecordEntry['kind'];
  nodePath: string;
  digest: string;
}

/**
 * Replay a run against its own cassette and compare the replay's emitted record
 * stream to the original recording at digest level (same seq of
 * kinds/nodePaths/digests). This is the §8 acceptance primitive: every stored
 * run should self-check `identical: true`, and it doubles as a deterministic
 * repro / debugging tool.
 */
export async function replaySelfCheck<TVars extends Vars = Vars>(
  run: StoredRun<TVars>,
): Promise<ReplaySelfCheck> {
  const { recording } = await replayRun(run);
  const expected = signatures(run.recording ?? []);
  const actual = signatures(recording);
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    if (!signatureEquals(expected[index], actual[index])) {
      return {
        identical: false,
        firstDivergence: {
          index,
          expected: expected[index],
          actual: actual[index],
        },
      };
    }
  }
  return { identical: true };
}

function signatures(recording: readonly RunRecordEntry[]): RecordSignature[] {
  return [...recording]
    .sort((a, b) => a.record.seq - b.record.seq)
    .map((entry) => {
      if (entry.kind === 'model') {
        return {
          kind: 'model' as const,
          nodePath: entry.record.nodePath,
          digest: entry.record.requestDigest,
        };
      }
      if (entry.kind === 'tool') {
        return {
          kind: 'tool' as const,
          nodePath: entry.record.nodePath,
          digest: entry.record.argsDigest,
        };
      }
      return {
        kind: 'node' as const,
        nodePath: entry.record.nodePath,
        digest: digest({
          nodeType: entry.record.nodeType,
          branch: entry.record.branch ?? null,
        }),
      };
    });
}

function signatureEquals(
  left: RecordSignature | undefined,
  right: RecordSignature | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.kind === right.kind &&
    left.nodePath === right.nodePath &&
    left.digest === right.digest
  );
}

function inboxToGraphInput(run: StoredRun<any>): GraphInboundInput[] {
  return (run.inbox ?? []).map((input) => ({
    kind: input.kind,
    content: input.content,
    attrs: input.attrs,
  }));
}

function assistantMessages(session: Session<any>): Message[] {
  return session.messages.filter(
    (message): message is Message & { type: 'assistant' } =>
      message.type === 'assistant',
  );
}

function collectStructured(session: Session<any>): unknown[] {
  const structured: unknown[] = [];
  for (const message of session.messages) {
    if (message.structuredContent !== undefined) {
      structured.push(message.structuredContent);
    }
  }
  return structured;
}

function computeWouldDeliver(
  run: StoredRun<any>,
  session: Session<any>,
  conversationId: string,
): AssistantDeliveryOutboxInput[] {
  const target = deliveryTargetFromServices(run.services);
  return assistantMessages(session).map((message, assistantIndex) => ({
    message: message as AssistantDeliveryOutboxInput['message'],
    assistantIndex,
    idempotencyKey: assistantDeliveryKey(
      conversationId,
      assistantIndex,
      target,
    ),
    target,
  }));
}

function deliveryTargetFromServices(
  services: Record<string, unknown> | undefined,
): DeliveryTarget | undefined {
  const delivery = services?.delivery;
  if (
    delivery &&
    typeof delivery === 'object' &&
    'platform' in delivery &&
    typeof (delivery as { platform?: unknown }).platform === 'string'
  ) {
    return delivery as DeliveryTarget;
  }
  return undefined;
}

function cloneValue<T>(value: T): T {
  if (!value || typeof value !== 'object') {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    if (Array.isArray(value)) {
      return [...value] as T;
    }
    return { ...(value as Record<string, unknown>) } as T;
  }
}

/**
 * Deterministic mulberry32 PRNG seeded from a constant so two replays of the
 * same cassette pin `Math.random`-driven sources identically.
 */
function makeSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
