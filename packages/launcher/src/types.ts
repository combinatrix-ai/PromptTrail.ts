import type {
  AcceptanceCase,
  AcceptanceReport,
  Agent,
  ChangeScope,
  DiffReport,
  DurableRunStore,
} from '@prompttrail/core';

/**
 * B5 — the immutable launcher (design-docs replay-and-self-deploy.md §5–§8).
 *
 * The launcher is the TRUST ROOT: a tiny, never-self-modified orchestrator that
 * DECIDES and EXECUTES the irreversible parts of a self-deploy (lease handoff +
 * rollback). It never imports candidate code into its own decision logic —
 * verification runs are launcher-owned executions over launcher-owned corpus
 * definitions (`DeployTarget.corpus`), and the candidate only ever appears as a
 * loaded {@link Agent} passed *into* the trusted replay/diff/acceptance
 * machinery. "Green proposes evidence, the launcher disposes." See §6.
 */

/**
 * A deployable a launcher can (a) VERIFY against and (b) SERVE. v1 contract.
 *
 * The verification inputs are LAUNCHER-OWNED (they live on the target the
 * trusted root constructs, NOT read out of the candidate directory), so a
 * self-modified candidate cannot weaken its own gate (design §6).
 */
export interface DeployTarget {
  /** Stable name for this deployable (surfaced in logs + the report). */
  name: string;
  /**
   * Verification inputs. All launcher-owned: the launcher decides what to replay
   * and what "regression" means; the candidate only supplies the agent to run.
   */
  corpus: {
    /**
     * Directory of recorded {@link import('@prompttrail/core').StoredRun} JSON
     * fixtures (see `serializeRunFixture`) replayed for the diff. Each file is
     * one past run; the launcher builds its cassette + golden outcome and
     * replays the CANDIDATE agent against it. Omit to skip replay-diff.
     */
    runsDir?: string;
    /** The declared intended blast radius; any diff outside it is a regression. */
    scope: ChangeScope;
    /** Forward fake-request acceptance cases (design §4). Omit to skip. */
    acceptance?: AcceptanceCase[];
  };
  /**
   * Load the candidate's agent for runner-executed verification — e.g. a dynamic
   * import of the candidate's built dist. The launcher runs this agent through
   * the TRUSTED replay/diff/acceptance machinery; it is never trusted to grade
   * itself. `candidateDir` is the directory passed to {@link deploy}.
   */
  loadAgent: (candidateDir: string) => Promise<Agent>;
  /**
   * How to SERVE the candidate: the command the launcher spawns as the green
   * child process. The child configures its OWN store/lease from this env; the
   * launcher only injects the role + holder id (see {@link LAUNCHER_ENV}) and
   * orchestrates who HOLDS the lease via the store handle it owns.
   */
  serve: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  };
  /**
   * The shared durable store whose single-writer lease arbitrates serving. The
   * launcher OWNS this handle: it discovers the current (blue) holder and
   * performs the atomic handoff/rollback directly on `store.lease`. Fencing
   * makes a drained blue's late writes fail safely (the B4 guarantee).
   */
  store: DurableRunStore;
  /**
   * Independent, launcher-owned health probes (design §5/§6). Each throws to
   * signal UNHEALTHY. They are re-verified by the launcher AFTER the cutover —
   * they are NOT green's self-report. Used both to confirm green took over and
   * to watch the post-cutover health window.
   */
  probes?: Array<(ctx: ProbeContext) => void | Promise<void>>;
}

/** Context handed to each health probe so it can inspect the green candidate. */
export interface ProbeContext {
  /** The lease holder id the launcher assigned to the green child. */
  greenHolder: string;
  /**
   * Absolute path of the green child's status file (the launcher assigns it and
   * passes it to the child via {@link LAUNCHER_ENV.statusFile}). A probe may read
   * it, but the store lease is the authoritative signal.
   */
  statusFile: string;
  /** The shared store, for lease-based liveness checks. */
  store: DurableRunStore;
}

export interface DeployOptions {
  /** Lease TTL in ms used for handoff/rollback. Default 30_000. */
  ttlMs?: number;
  /**
   * How long (ms) to keep re-running the probes after the cutover before
   * declaring the deploy healthy. A probe failure at any point rolls back.
   * Default 3_000.
   */
  healthWindowMs?: number;
  /** How long (ms) to wait for blue to drain + exit on promote. Default 5_000. */
  drainTimeoutMs?: number;
  /** Interval (ms) between probe iterations. Default 200. */
  probeIntervalMs?: number;
  /**
   * How long (ms) to wait for the green child to signal ready (and, after
   * cutover, to become healthy) before giving up. Default 10_000.
   */
  readyTimeoutMs?: number;
  /**
   * The currently-serving process the launcher manages (blue), if any. When
   * present, deploy() drains+SIGTERMs it on a successful promote and leaves it
   * WARM (untouched) through the health window so a rollback is an instant lease
   * handoff back, not a cold restart (design §5). When absent, the launcher
   * relies on blue self-exiting once it detects the lease loss.
   */
  current?: LaunchedProcess;
  /** Clock for report timestamps. Defaults to `Date.now`. */
  now?: () => number;
  /** Structured log sink for every stage transition. */
  log?: (event: DeployLogEvent) => void;
}

/** The launcher's terminal verdict for a deploy attempt. */
export type DeployVerdict = 'promoted' | 'rejected' | 'rolled-back';

/** One replay-diff result over a single recorded fixture. */
export interface FixtureDiff {
  fixture: string;
  kind: DiffReport['kind'];
  outOfScope: DiffReport['outOfScope'];
  misses: number;
}

export interface DeployReport {
  verdict: DeployVerdict;
  target: string;
  /** Per-stage outcomes, filled in as the deploy progresses. */
  stages: {
    verify?: {
      ok: boolean;
      fixtures: number;
      regressions: number;
      acceptanceOk?: boolean;
      error?: string;
    };
    launch?: { ok: boolean; holder?: string; pid?: number; error?: string };
    cutover?: {
      ok: boolean;
      from?: string;
      to?: string;
      token?: number;
      error?: string;
    };
    health?: { ok: boolean; error?: string; rolledBack?: boolean };
    promote?: { ok: boolean; blueStopped?: boolean };
  };
  /** Every fixture's replay-diff classification (populated by VERIFY). */
  diffs?: FixtureDiff[];
  /** The acceptance report (populated by VERIFY when acceptance cases exist). */
  acceptance?: AcceptanceReport;
  /** Terminal error message when the deploy went to a safe state. */
  error?: string;
}

/** A structured launcher log event (every stage transition emits one). */
export interface DeployLogEvent {
  stage:
    | 'verify'
    | 'launch'
    | 'drain'
    | 'cutover'
    | 'health'
    | 'promote'
    | 'rollback'
    | 'safe-state';
  message: string;
  at: number;
  data?: Record<string, unknown>;
}

/** Role the launcher assigns to a spawned server child. */
export type ServerRole = 'blue' | 'green';

/**
 * A handle to a spawned server child (blue or green). The launcher owns the OS
 * process; the store lease (not this handle) is the source of truth for who is
 * actually serving.
 */
export interface LaunchedProcess {
  readonly holder: string;
  readonly role: ServerRole;
  readonly pid: number | undefined;
  /** Absolute path of the child's status file (JSON, rewritten each tick). */
  readonly statusFile: string;
  /** True once the OS process has exited. */
  readonly exited: boolean;
  /** Resolve when the child signals ready; reject on timeout or early exit. */
  waitReady(timeoutMs?: number): Promise<void>;
  /** SIGTERM and await exit up to `timeoutMs`, then SIGKILL. Idempotent. */
  stop(timeoutMs?: number): Promise<void>;
  /** SIGKILL immediately (best-effort). Idempotent. */
  kill(): void;
}

/**
 * The environment variables the launcher injects into a server child. The
 * deployable's OWN config (store path, etc.) rides `DeployTarget.serve.env`; the
 * launcher only owns role + holder identity + the ready/status/ttl handshake.
 */
export const LAUNCHER_ENV = {
  role: 'LAUNCHER_ROLE',
  holder: 'LAUNCHER_LEASE_HOLDER',
  ttlMs: 'LAUNCHER_TTL_MS',
  readyFile: 'LAUNCHER_READY_FILE',
  statusFile: 'LAUNCHER_STATUS_FILE',
} as const;
