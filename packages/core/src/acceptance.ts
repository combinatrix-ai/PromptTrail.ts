import { createCheckpointOnceMemoStore } from './checkpoint_continuation';
import type { Inbound, ModelCallRecord, StoredRun } from './durable';
import type { Cassette, ReplayTrace } from './replay';
import { replayRun } from './replay';
import type { Session, Vars } from './session';
import { createSession } from './session';
import type { Agent } from './templates';

/**
 * B3 — the acceptance suite (design-docs replay-and-self-deploy.md §4, §8).
 *
 * Acceptance validates NEW behavior FORWARD: a corpus of synthetic fake
 * requests, each asserting what the target agent should now do (routes to the
 * right skill, calls the right tool with the right args, replies within budget,
 * terminates). Past requests cannot exercise behavior that postdates them, so
 * this is the complement to the replay-diff over the historical corpus.
 *
 * It runs on the SAME containment as {@link replayRun} — a fresh throwaway run,
 * side effects sealed, deliveries captured into `trace.wouldDeliver` and never
 * sent — with one delta: `miss: 'live'` under `acceptance: true`, so a MODEL
 * call the case did not stub falls through to the real provider (new behavior =
 * genuinely new LLM output). TOOL calls stay SEALED even here (a tool miss is a
 * stub/sentinel, never a live execution — see `replay.ts`), so assertions on the
 * deterministic dimensions (routing / tool / structured) hold even when the text
 * dimension is live.
 *
 * TRUST BOUNDARY (design §6). This harness — like the corpus that feeds it — is
 * TRUSTED-ROOT: it must live outside what a self-authored / self-modified build
 * under test can edit, so a broken green cannot ship with a weakened self-check.
 * A green build RUNS this against itself as a target; it can never rewrite it.
 */

/** One synthetic fake request in a case's inbox (a `string` = a user message). */
export type AcceptanceInboxItem =
  | string
  | {
      kind?: Inbound['kind'];
      content: string;
      /** Routing attrs (e.g. `channel`) the dispatch path reads. */
      attrs?: Record<string, unknown>;
    };

export interface AcceptanceCase {
  /** Stable, human-readable case id (surfaced in the report). */
  name: string;
  /** The synthetic fake requests fed to the target agent, in order. */
  inbox: AcceptanceInboxItem[];
  /** Services made available to the run (e.g. a delivery target). */
  services?: Record<string, unknown>;
  /**
   * An explicit cassette to stub model AND tool leaves for this case. Consumed
   * positionally. Tool stubs are the ONLY way to give a tool call a specific
   * result — tools never go live. Mutually rich with {@link modelStubs}; if both
   * are set, `cassette` wins.
   */
  cassette?: Cassette;
  /**
   * Sugar for the common case: positional model responses (assistant text), in
   * order. Built into a model-only cassette. A model call past the last stub
   * falls through to the real provider (`miss: 'live'`). Ignored if
   * {@link cassette} is set.
   */
  modelStubs?: string[];
  /**
   * The assertion. Throwing (e.g. a failed `expect`) fails the case; the thrown
   * error is captured into the report. May be async.
   */
  assert: (trace: ReplayTrace, session: Session) => void | Promise<void>;
}

export interface AcceptanceCaseResult {
  name: string;
  ok: boolean;
  durationMs: number;
  /** The failure message when `ok` is false (assertion throw or run error). */
  error?: string;
}

export interface AcceptanceReport {
  /** True iff EVERY case passed. */
  ok: boolean;
  cases: AcceptanceCaseResult[];
}

export interface RunAcceptanceOptions {
  /**
   * Keying tried per model/tool call (design §2). Defaults to `['positional']`
   * — stubs are positional and forward cases assume no historical divergence.
   */
  keying?: readonly ('request-hash' | 'node-path' | 'positional')[];
  /** Pinned clock; defaults to the replay's fixed epoch. */
  now?: () => number;
  /** Pinned event scope / conversation id; defaults to `acceptance:<name>`. */
  eventScopeId?: (name: string) => string;
}

/** Build a model-only cassette from positional assistant-text stubs. */
function modelStubsToCassette(stubs: readonly string[]): Cassette {
  const model: ModelCallRecord[] = stubs.map((text, index) => ({
    seq: index,
    nodePath: '',
    callIndex: index,
    provider: 'assistant',
    // Positional keying only reads insertion order, so a placeholder digest is
    // fine; a request-hash keyed acceptance would supply a real `cassette`.
    requestDigest: '',
    response: { content: text },
    at: 0,
  }));
  return { model, tools: [], nodes: [] };
}

const EMPTY_CASSETTE: Cassette = { model: [], tools: [], nodes: [] };

/** Normalize an inbox item into a stored {@link Inbound}. */
function toInbound(item: AcceptanceInboxItem, offset: number): Inbound {
  if (typeof item === 'string') {
    return { offset, kind: 'user', content: item };
  }
  return {
    offset,
    kind: item.kind ?? 'user',
    content: item.content,
    attrs: item.attrs,
  };
}

/**
 * Build the synthetic {@link StoredRun} for one case. It carries no recording
 * (the cassette is supplied explicitly, so `buildCassette` is never reached) and
 * an empty initial session — the fake requests drive everything from the inbox.
 */
function syntheticRun(agent: Agent, testCase: AcceptanceCase): StoredRun<Vars> {
  return {
    agent,
    agentName: agent.name ?? 'acceptance',
    initial: createSession(),
    status: 'open',
    once: createCheckpointOnceMemoStore(),
    outbox: [],
    inbox: testCase.inbox.map((item, index) => toInbound(item, index)),
    services: testCase.services,
  };
}

/**
 * Run an acceptance corpus against a target agent, sequentially, collecting
 * every case's outcome WITHOUT aborting the suite on a failure (design §4/§8).
 * Each case runs through the {@link replayRun} acceptance containment.
 */
export async function runAcceptance(
  agent: Agent,
  cases: readonly AcceptanceCase[],
  opts: RunAcceptanceOptions = {},
): Promise<AcceptanceReport> {
  const keying = opts.keying ?? (['positional'] as const);
  const eventScopeId =
    opts.eventScopeId ?? ((name: string) => `acceptance:${name}`);
  const results: AcceptanceCaseResult[] = [];

  for (const testCase of cases) {
    const start = Date.now();
    const cassette =
      testCase.cassette ??
      (testCase.modelStubs
        ? modelStubsToCassette(testCase.modelStubs)
        : EMPTY_CASSETTE);
    try {
      const { trace, session } = await replayRun(
        syntheticRun(agent, testCase),
        {
          agent,
          cassette,
          keying,
          miss: 'live',
          acceptance: true,
          now: opts.now,
          eventScopeId: eventScopeId(testCase.name),
        },
      );
      await testCase.assert(trace, session);
      results.push({
        name: testCase.name,
        ok: true,
        durationMs: Date.now() - start,
      });
    } catch (error) {
      results.push({
        name: testCase.name,
        ok: false,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ok: results.every((result) => result.ok), cases: results };
}
