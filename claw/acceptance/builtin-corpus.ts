import {
  type AcceptanceCase,
  type ReplayTrace,
  type Session,
  Source,
} from '@prompttrail/core';
import {
  createAuthorSkill,
  createClawSkillAgent,
  createStatusSkill,
  createSupervisorSkill,
  findClawRoot,
  MATCHED_SKILL_VAR,
  registerBuiltinSkills,
  SkillRegistry,
  templateSynthesizer,
  type Skill,
  type SkillLoaderContext,
} from '../src/skills/index.js';

/**
 * B3 — claw's builtin acceptance corpus (design-docs/replay-and-self-deploy.md
 * §4, §6, §8 B3).
 *
 * TRUST BOUNDARY (design §6). This corpus and the agent it targets live under
 * `claw/acceptance/` — REPO SOURCE, checked into git. The self-authoring loader
 * and gate only ever write to env-configured `.data` paths (`CLAW_SKILLS_DIR`,
 * its `staging/` subdir, and the `*.db` files — see `claw/src/index.ts` and
 * `skills/loader.ts`/`gate.ts`); they never touch `claw/acceptance/` or
 * `claw/src/`. So a self-authored / self-modified build under test CANNOT edit
 * this corpus or weaken the checks it asserts — the acceptance suite is
 * trusted-root owned, and green only ever RUNS it against itself.
 *
 * Every case runs on the deterministic ECHO reply mode with callback/transform
 * skills (status, supervisor, author), so no case reaches the network: the
 * builtin behaviors make no model calls, and the acceptance containment seals
 * tools and captures deliveries regardless.
 */

/** A privileged channel the supervisor/author skills are narrowed to. */
const PRIVILEGED_CHANNEL = 'ops';
/** An ordinary channel with no elevated capability. */
const PUBLIC_CHANNEL = 'general';

/** Deterministic status facts (pinned clock → stable uptime). */
const STATUS_INFO = {
  version: '9.9.9',
  replyMode: 'echo',
  startedAt: 0,
  now: () => 42_000,
};

/**
 * Build the acceptance TARGET: claw's static registry-dispatch agent wired with
 * the builtin skills exactly as production does, minus any network reply mode.
 * A fresh in-memory registry keeps every run hermetic.
 */
export function buildAcceptanceTarget() {
  const registry = new SkillRegistry(':memory:');
  const loaderContext: SkillLoaderContext = {
    registry,
    skills: new Map<string, Skill>(),
    // Never written during acceptance (gate/loader are not invoked), but the
    // path is required by the type; it points at the env .data surface, which is
    // outside this corpus (the trust boundary above).
    skillsDir: '.data/skills',
    replySource: Source.callback(async () => '(echo mode: skill reply)'),
    gateOptions: {
      clawRoot: findClawRoot(),
      stagingRoot: '.data/skills/staging',
    },
  };
  const authorSkill = createAuthorSkill({
    loaderContext,
    synthesizer: templateSynthesizer,
    authoringChannels: [PRIVILEGED_CHANNEL],
    authors: [],
  });
  const supervisorSkill = createSupervisorSkill({
    loaderContext,
    supervisorChannels: [PRIVILEGED_CHANNEL],
    authors: [],
  });
  const statusSkill = createStatusSkill(STATUS_INFO);

  const skills = registerBuiltinSkills(registry, [
    statusSkill,
    supervisorSkill,
    authorSkill,
  ]);
  loaderContext.skills = skills;

  return createClawSkillAgent({
    registry,
    skills,
    defaultReply: (agent) =>
      agent.assistant(
        'reply',
        (session: Session) => `ack: ${session.getLastMessage()?.content ?? ''}`,
      ),
  });
}

/** Read the dispatch-written matched skill id off the final session. */
function matchedSkill(session: Session): string {
  const value = (session.getVarsObject() as Record<string, unknown>)[
    MATCHED_SKILL_VAR
  ];
  return typeof value === 'string' ? value : '';
}

/** The last assistant reply text. */
function reply(session: Session): string {
  return session.getLastMessage()?.content ?? '';
}

/** The `route` conditional's branch decision (routing dimension). */
function routeBranch(trace: ReplayTrace): string | undefined {
  return trace.routing.find((r) => r.at.endsWith('/route'))?.branch;
}

/**
 * Corpus v1 — the forward assertions on claw's builtin dispatch behavior. Each
 * asserts on the DETERMINISTIC dimensions (routing branch + which skill matched)
 * plus a text regex; no case depends on live model output.
 */
export const builtinCorpus: AcceptanceCase[] = [
  {
    name: 'status skill answers !status',
    inbox: ['!status'],
    assert: (trace, session) => {
      // Routing: dispatch → status skill (then branch).
      expect(routeBranch(trace)).toBe('then');
      expect(matchedSkill(session)).toBe('status');
      // Text: version | reply-mode | uptime shape.
      expect(reply(session)).toMatch(
        /^claw v\d.*\|\s*reply-mode:\s*\S+\s*\|\s*uptime:\s*\d+s$/,
      );
    },
  },
  {
    name: 'unauthorized channel does NOT trigger authoring',
    inbox: [
      { content: '!skill add a greeter', attrs: { channel: PUBLIC_CHANNEL } },
    ],
    assert: (trace, session) => {
      // The author skill is channel-narrowed to PRIVILEGED_CHANNEL, so on a
      // public channel it never matches — dispatch takes the else (default)
      // branch and NOTHING authored.
      expect(matchedSkill(session)).toBe('');
      expect(routeBranch(trace)).toBe('else');
      expect(reply(session)).toBe('ack: !skill add a greeter');
    },
  },
  {
    name: 'supervisor !skills is rejected on a public channel',
    inbox: [{ content: '!skills', attrs: { channel: PUBLIC_CHANNEL } }],
    assert: (trace, session) => {
      // Supervisor is channel-narrowed; a public !skills falls through to echo.
      expect(matchedSkill(session)).toBe('');
      expect(routeBranch(trace)).toBe('else');
      expect(reply(session)).toBe('ack: !skills');
    },
  },
  {
    name: 'supervisor !skills runs on the privileged channel',
    inbox: [{ content: '!skills', attrs: { channel: PRIVILEGED_CHANNEL } }],
    assert: (trace, session) => {
      expect(routeBranch(trace)).toBe('then');
      expect(matchedSkill(session)).toBe('supervisor');
      // The skills listing renders (privileged capability exercised).
      expect(reply(session)).toMatch(/Skills \(\d+\)/);
    },
  },
  {
    name: 'default echo reply for an unmatched message',
    inbox: ['just saying hello'],
    assert: (trace, session) => {
      expect(matchedSkill(session)).toBe('');
      expect(routeBranch(trace)).toBe('else');
      expect(reply(session)).toBe('ack: just saying hello');
    },
  },
];

/**
 * Minimal assertion helper so the corpus stays dependency-free of the test
 * runner: each case throws on a mismatch, which {@link runAcceptance} captures.
 */
function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) {
        throw new Error(
          `expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`,
        );
      }
    },
    toMatch(re: RegExp) {
      if (typeof actual !== 'string' || !re.test(actual)) {
        throw new Error(
          `expected ${JSON.stringify(actual)} to match ${re.toString()}`,
        );
      }
    },
  };
}
