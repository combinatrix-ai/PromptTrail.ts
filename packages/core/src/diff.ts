import { z } from 'zod';
import type { AssistantDeliveryOutboxEntry, StoredRun } from './durable';
import type { Message } from './message';
import { digest, stableStringify } from './recording';
import type { ReplayTrace } from './replay';
import type { Session } from './session';

/**
 * B2 — the differ (design-docs replay-and-self-deploy.md §3). It classifies each
 * candidate-vs-golden difference as `same | intended | regression` against a
 * declared {@link ChangeScope}.
 *
 * The differ is GENERIC: it knows nothing about deployment. Deploy gating is the
 * consumer's job (claw takes the {@link DiffReport} and decides whether to
 * promote). Likewise the SCHEMA of `ChangeScope` lives here (in core, so the
 * meaning of "regression" cannot be weakened by a self-authored build), but the
 * scope VALUES for a given deploy — which node ids and dimensions are the
 * intended blast radius — are authored by the consumer (claw / the supervisor),
 * not here. See design §3/§6 (trust boundaries).
 *
 * The executor ({@link replayRun}) and the differ are separate: the executor
 * only emits a comparable {@link ReplayTrace}; {@link GoldenOutcome} is the same
 * shape projected out of the ORIGINAL recording, so golden and candidate diff
 * dimension by dimension.
 */

/**
 * The behavioral dimensions the differ compares (design §3). A difference is
 * attributed to a KIND, not a blob — so a change is localizable and scopable.
 */
export type Dimension =
  /** Dispatch / conditional branch decisions (from the branch breadcrumbs). */
  | 'routing'
  /** Executed node-path sequence (order + set). */
  | 'control-flow'
  /** Same tool calls with the same argument digests, in order. */
  | 'tool-args'
  /** Structured outputs deep-equal. */
  | 'structured'
  /** Final reply — exact under a cassette LLM (B2). */
  | 'text';

/** One attributed difference between golden and candidate. */
export interface Difference {
  /** Which behavioral dimension diverged. */
  dimension: Dimension;
  /** Node id the difference is anchored at, when the dimension has one. */
  at?: string;
  /** Human-readable detail (for reporting; not part of classification). */
  detail?: string;
}

/**
 * The golden side of the diff (design §1): a {@link ReplayTrace}-shaped
 * projection of what the ORIGINAL run did, extracted from its B0 recording +
 * final session + outbox.
 */
export interface GoldenOutcome {
  /** Executed node path (breadcrumbs), in seq order. */
  nodes: string[];
  /** Branch decisions taken, in order (routing). */
  routing: { at: string; branch: string }[];
  /** Model/provider calls: digests + recorded outputs. */
  modelCalls: {
    nodePath: string;
    provider: string;
    requestDigest: string;
    output: unknown;
  }[];
  /** Tool calls: name + argsDigest + result digest, in order. */
  toolCalls: {
    nodePath: string;
    name: string;
    argsDigest: string;
    resultDigest: string;
  }[];
  /** Structured outputs the run produced. */
  structured: unknown[];
  /** The delivered assistant message(s). */
  finalReply: Message[];
  /** Deliveries the run emitted (from the outbox). */
  deliveries: AssistantDeliveryOutboxEntry[];
}

/**
 * The declared intended blast radius of a change (design §3, v1 shape). A
 * difference is in-scope iff its dimension is listed AND (`nodeIds` is absent, or
 * the difference's anchor node id is in `nodeIds`). v1 is deliberately a set of
 * node ids + a set of dimensions, NOT an arbitrary predicate (a predicate is
 * itself code the gate would have to trust — design §3/§9).
 */
export interface ChangeScope {
  /** Node ids the change is allowed to touch; absent = any node. */
  nodeIds?: string[];
  /** Dimensions the change is allowed to alter; absent/empty = none. */
  dimensions?: Dimension[];
}

/** Zod schema for {@link ChangeScope} so consumers validate authored values. */
export const ChangeScopeSchema = z
  .object({
    nodeIds: z.array(z.string()).optional(),
    dimensions: z
      .array(
        z.enum(['routing', 'control-flow', 'tool-args', 'structured', 'text']),
      )
      .optional(),
  })
  .strict();

/** The differ verdict for one candidate-vs-golden comparison (design §3). */
export interface DiffReport {
  /**
   * `same` — no differences; `intended` — every difference ⊆ scope; `regression`
   * — at least one difference outside scope (blocks release).
   */
  kind: 'same' | 'intended' | 'regression';
  /** All attributed differences. */
  differences: Difference[];
  /** The subset that falls within the declared scope. */
  inScope: Difference[];
  /** The subset that falls outside the declared scope (the regression set). */
  outOfScope: Difference[];
}

/**
 * Project a {@link GoldenOutcome} out of a recorded run — the golden side of the
 * diff. Reads the ORIGINAL B0 recording (node/model/tool records) for the
 * deterministic dimensions and the final session + outbox for structured / text
 * / deliveries. Throws when the run carries no recording (nothing to diff).
 */
export function buildGoldenOutcome(run: StoredRun<any>): GoldenOutcome {
  const recording = [...(run.recording ?? [])].sort(
    (a, b) => a.record.seq - b.record.seq,
  );
  if (recording.length === 0) {
    throw new Error(
      'Cannot build a golden outcome: the run has no recording stream ' +
        "(record with recording: 'decisions' or 'full' first).",
    );
  }
  const nodes: string[] = [];
  const routing: GoldenOutcome['routing'] = [];
  const modelCalls: GoldenOutcome['modelCalls'] = [];
  const toolCalls: GoldenOutcome['toolCalls'] = [];
  for (const entry of recording) {
    if (entry.kind === 'node') {
      nodes.push(entry.record.nodePath);
      if (entry.record.branch !== undefined) {
        routing.push({
          at: entry.record.nodePath,
          branch: entry.record.branch,
        });
      }
    } else if (entry.kind === 'model') {
      modelCalls.push({
        nodePath: entry.record.nodePath,
        provider: entry.record.provider,
        requestDigest: entry.record.requestDigest,
        output: entry.record.response,
      });
    } else {
      toolCalls.push({
        nodePath: entry.record.nodePath,
        name: entry.record.toolName,
        argsDigest: entry.record.argsDigest,
        resultDigest: digest(entry.record.result),
      });
    }
  }
  const finalSession = run.result ?? run.initial;
  return {
    nodes,
    routing,
    modelCalls,
    toolCalls,
    structured: collectStructured(finalSession),
    finalReply: assistantMessages(finalSession),
    deliveries: run.outbox ?? [],
  };
}

/**
 * Compare a candidate {@link ReplayTrace} against a {@link GoldenOutcome} across
 * the behavioral dimensions and classify the result against `scope` (design §3).
 */
export function diffReplay(
  golden: GoldenOutcome,
  candidate: ReplayTrace,
  scope: ChangeScope,
): DiffReport {
  const differences: Difference[] = [];

  const routing = firstRoutingDivergence(golden.routing, candidate.routing);
  if (routing) {
    differences.push({
      dimension: 'routing',
      at: routing.at,
      detail: routing.detail,
    });
  }

  const controlFlow = firstSequenceDivergence(golden.nodes, candidate.nodes);
  if (controlFlow) {
    differences.push({
      dimension: 'control-flow',
      at: controlFlow.at,
      detail: controlFlow.detail,
    });
  }

  const toolArgs = firstToolArgsDivergence(
    golden.toolCalls,
    candidate.toolCalls,
  );
  if (toolArgs) {
    differences.push({
      dimension: 'tool-args',
      at: toolArgs.at,
      detail: toolArgs.detail,
    });
  }

  if (
    stableStringify(golden.structured) !== stableStringify(candidate.structured)
  ) {
    differences.push({
      dimension: 'structured',
      detail: 'structured outputs differ',
    });
  }

  // Text = the reply CONTENT only. Tool-call arguments and structured payloads
  // embedded in the same assistant message are their own dimensions (tool-args /
  // structured), so they must not also register as a text difference.
  if (
    stableStringify(golden.finalReply.map((m) => m.content)) !==
    stableStringify(candidate.finalReply.map((m) => m.content))
  ) {
    differences.push({ dimension: 'text', detail: 'final reply text differs' });
  }

  const inScope = differences.filter((d) => differenceInScope(d, scope));
  const outOfScope = differences.filter((d) => !differenceInScope(d, scope));
  const kind: DiffReport['kind'] =
    differences.length === 0
      ? 'same'
      : outOfScope.length === 0
        ? 'intended'
        : 'regression';
  return { kind, differences, inScope, outOfScope };
}

function differenceInScope(diff: Difference, scope: ChangeScope): boolean {
  if (!scope.dimensions || !scope.dimensions.includes(diff.dimension)) {
    return false;
  }
  if (scope.nodeIds === undefined) {
    return true;
  }
  return diff.at !== undefined && scope.nodeIds.includes(diff.at);
}

function firstSequenceDivergence(
  golden: readonly string[],
  candidate: readonly string[],
): { at?: string; detail: string } | undefined {
  const length = Math.max(golden.length, candidate.length);
  for (let index = 0; index < length; index += 1) {
    if (golden[index] !== candidate[index]) {
      return {
        at: golden[index] ?? candidate[index],
        detail:
          `node path diverges at index ${index}: golden ` +
          `${golden[index] ?? '<end>'} vs candidate ${candidate[index] ?? '<end>'}`,
      };
    }
  }
  return undefined;
}

function firstRoutingDivergence(
  golden: readonly { at: string; branch: string }[],
  candidate: readonly { at: string; branch: string }[],
): { at?: string; detail: string } | undefined {
  const length = Math.max(golden.length, candidate.length);
  for (let index = 0; index < length; index += 1) {
    const g = golden[index];
    const c = candidate[index];
    if (!g || !c || g.at !== c.at || g.branch !== c.branch) {
      return {
        at: (g ?? c)?.at,
        detail:
          `routing diverges at index ${index}: golden ` +
          `${g ? `${g.at}=${g.branch}` : '<end>'} vs candidate ` +
          `${c ? `${c.at}=${c.branch}` : '<end>'}`,
      };
    }
  }
  return undefined;
}

function firstToolArgsDivergence(
  golden: readonly { nodePath: string; name: string; argsDigest: string }[],
  candidate: readonly { nodePath: string; name: string; argsDigest: string }[],
): { at?: string; detail: string } | undefined {
  const length = Math.max(golden.length, candidate.length);
  for (let index = 0; index < length; index += 1) {
    const g = golden[index];
    const c = candidate[index];
    if (!g || !c || g.name !== c.name || g.argsDigest !== c.argsDigest) {
      return {
        at: (c ?? g)?.nodePath,
        detail:
          `tool call diverges at index ${index}: golden ` +
          `${g ? `${g.name}(${g.argsDigest.slice(0, 8)})` : '<end>'} vs candidate ` +
          `${c ? `${c.name}(${c.argsDigest.slice(0, 8)})` : '<end>'}`,
      };
    }
  }
  return undefined;
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
