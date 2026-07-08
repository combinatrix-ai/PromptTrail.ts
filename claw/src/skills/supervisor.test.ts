import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Session, Source } from '@prompttrail/core';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  createClawSkillAgent,
  createSupervisorSkill,
  findClawRoot,
  promoteAndRegister,
  quarantineScan,
  runGate,
  runSkillInstrumented,
  runSupervisorCommand,
  SkillRegistry,
  supervisorAuthorized,
  templateSynthesizer,
  type Skill,
  type SkillLoaderContext,
  type SkillProvenance,
  type SkillRegistryRow,
  type SupervisionConfig,
} from './index.js';

const provenance: SkillProvenance = {
  authoredBy: 'test',
  motivation: 'phase-2 supervision test',
  createdAt: '2026-07-08T00:00:00.000Z',
};

const supervision: SupervisionConfig = { promoteAfter: 3, quarantineAfter: 3 };

const echoDefault = (agent: Agent): Agent =>
  agent.assistant(
    'reply',
    (session: Session) => `ack: ${session.getLastMessage()?.content ?? ''}`,
  );

function userSession(content: string, channel?: string): Session {
  return Session.create().addMessage({
    type: 'user',
    content,
    attrs: channel ? { channel } : undefined,
  });
}

function lastContent(session: Session): string {
  return session.getLastMessage()?.content ?? '';
}

/** A registry row for a self-authored skill parked at a given tier. */
function row(id: string, tier: SkillRegistryRow['tier']): SkillRegistryRow {
  return {
    id,
    name: id,
    channel: null,
    predicateKey: `startsWith:!${id}`,
    behaviorRef: id,
    provenance,
    enabled: true,
    createdAt: provenance.createdAt,
    tier,
    sourcePath: null,
    sourceHash: null,
    manifestHash: `hash-${id}`,
    activeVersion: `hash-${id}`,
    gateResult: { passed: true, stages: [{ name: 'typecheck', ok: true }] },
  };
}

function okSkill(id: string): Skill {
  return {
    id,
    name: id,
    trigger: {
      predicateKey: `startsWith:!${id}`,
      when: (c) => c.startsWith(`!${id}`),
    },
    behavior: (agent) => agent.assistant(Source.literal('ok')),
    provenance,
  };
}

function boomSkill(id: string): Skill {
  return {
    id,
    name: id,
    trigger: {
      predicateKey: `startsWith:!${id}`,
      when: (c) => c.startsWith(`!${id}`),
    },
    behavior: (agent) =>
      agent.assistant(
        Source.callback(async () => {
          throw new Error('boom');
        }),
      ),
    provenance,
  };
}

describe('reactive supervision (health wrapper)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claw-sup-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('auto-quarantines a canary after K consecutive failures, with notice + audit', async () => {
    const registry = new SkillRegistry(join(tmp, 's.db'));
    registry.upsert(row('boom', 'canary'));
    const skill = boomSkill('boom');

    for (let i = 0; i < supervision.quarantineAfter; i += 1) {
      await expect(
        runSkillInstrumented(
          registry,
          skill,
          userSession('!boom'),
          Date.now,
          supervision,
        ),
      ).rejects.toThrow('boom');
    }

    expect(registry.get('boom')?.tier).toBe('quarantined');
    const audit = registry.listAudit('boom');
    expect(audit[0]).toMatchObject({ to: 'quarantined', actor: 'auto' });
    const notices = registry.listPendingNotices();
    expect(notices.map((n) => n.skillId)).toContain('boom');
    registry.close();
  });

  it('auto-promotes a clean canary to trusted after N successes, with audit', async () => {
    const registry = new SkillRegistry(join(tmp, 's.db'));
    registry.upsert(row('good', 'canary'));
    const skill = okSkill('good');

    for (let i = 0; i < supervision.promoteAfter; i += 1) {
      await runSkillInstrumented(
        registry,
        skill,
        userSession('!good'),
        Date.now,
        supervision,
      );
    }

    expect(registry.get('good')?.tier).toBe('trusted');
    expect(registry.listAudit('good')[0]).toMatchObject({
      from: 'canary',
      to: 'trusted',
      actor: 'auto',
    });
    registry.close();
  });

  it('does not touch builtin skills', async () => {
    const registry = new SkillRegistry(join(tmp, 's.db'));
    registry.upsert(row('bi', 'builtin'));
    const skill = okSkill('bi');
    for (let i = 0; i < 5; i += 1) {
      await runSkillInstrumented(
        registry,
        skill,
        userSession('!bi'),
        Date.now,
        supervision,
      );
    }
    expect(registry.get('bi')?.tier).toBe('builtin');
    registry.close();
  });
});

describe('dispatcher tier handling', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claw-sup-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('skips a quarantined skill exactly like a disabled one', async () => {
    const registry = new SkillRegistry(join(tmp, 's.db'));
    registry.upsert(row('q', 'quarantined'));
    const skills = new Map<string, Skill>([['q', okSkill('q')]]);
    const agent = createClawSkillAgent({
      registry,
      skills,
      defaultReply: echoDefault,
      supervision,
    });
    const out = await agent.execute({ session: userSession('!q now') });
    expect(lastContent(out)).toBe('ack: !q now');
    registry.close();
  });

  it('dispatches a canary/trusted skill normally', async () => {
    const registry = new SkillRegistry(join(tmp, 's.db'));
    registry.upsert(row('c', 'canary'));
    const skills = new Map<string, Skill>([['c', okSkill('c')]]);
    const agent = createClawSkillAgent({
      registry,
      skills,
      defaultReply: echoDefault,
      supervision,
    });
    const out = await agent.execute({ session: userSession('!c go') });
    expect(lastContent(out)).toBe('ok');
    registry.close();
  });
});

describe('supervisor commands', () => {
  let tmp: string;
  let registry: SkillRegistry;
  let ctx: SkillLoaderContext;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claw-sup-'));
    registry = new SkillRegistry(join(tmp, 's.db'));
    ctx = {
      registry,
      skills: new Map<string, Skill>(),
      skillsDir: join(tmp, 'skills'),
      replySource: Source.callback(async () => 'reply'),
      gateOptions: {
        clawRoot: findClawRoot(),
        stagingRoot: join(tmp, 'staging'),
      },
    };
  });
  afterEach(() => {
    registry.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('!promote steps staged→canary then canary→trusted, auditing each', async () => {
    registry.upsert(row('p', 'staged'));
    const r1 = await runSupervisorCommand(
      { loaderContext: ctx },
      '!promote p',
      'alice',
    );
    expect(r1).toContain('staged → canary');
    expect(registry.get('p')?.tier).toBe('canary');

    const r2 = await runSupervisorCommand(
      { loaderContext: ctx },
      '!promote p',
      'alice',
    );
    expect(r2).toContain('canary → trusted');
    expect(registry.get('p')?.tier).toBe('trusted');

    const r3 = await runSupervisorCommand(
      { loaderContext: ctx },
      '!promote p',
      'alice',
    );
    expect(r3).toContain('Cannot promote');

    const audit = registry.listAudit('p');
    expect(audit.map((a) => `${a.from}->${a.to}`)).toEqual([
      'canary->trusted',
      'staged->canary',
    ]);
    expect(audit.every((a) => a.actor === 'alice')).toBe(true);
  });

  it('!quarantine then !restore resets the consecutive-failure streak', async () => {
    registry.upsert(row('r', 'canary'));
    registry.recordHealth('r', { success: false, latencyMs: 1, error: 'x' });
    registry.recordHealth('r', { success: false, latencyMs: 1, error: 'x' });
    expect(registry.getHealth('r')?.consecutiveFailures).toBe(2);

    const q = await runSupervisorCommand(
      { loaderContext: ctx },
      '!quarantine r',
      'bob',
    );
    expect(q).toContain('→ quarantined');
    expect(registry.get('r')?.tier).toBe('quarantined');

    const res = await runSupervisorCommand(
      { loaderContext: ctx },
      '!restore r',
      'bob',
    );
    expect(res).toContain('quarantined → canary');
    expect(registry.get('r')?.tier).toBe('canary');
    expect(registry.getHealth('r')?.consecutiveFailures).toBe(0);
    expect(registry.getHealth('r')?.lastError).toBeNull();
  });

  it('!skills lists tiers and drains pending notices; !why shows audit + gate', async () => {
    registry.upsert(row('a', 'canary'));
    registry.recordNotice({
      skillId: 'a',
      message: 'test notice',
      at: provenance.createdAt,
    });

    const list = await runSupervisorCommand(
      { loaderContext: ctx },
      '!skills',
      'sup',
    );
    expect(list).toContain('Supervisor notices (1)');
    expect(list).toContain('a: test notice');
    expect(list).toContain('tier=canary');
    // Notices are drained (delivered) after being surfaced once.
    expect(registry.listPendingNotices()).toHaveLength(0);

    await runSupervisorCommand({ loaderContext: ctx }, '!quarantine a', 'sup');
    const why = await runSupervisorCommand(
      { loaderContext: ctx },
      '!why a',
      'sup',
    );
    expect(why).toContain('why a');
    expect(why).toContain('→ quarantined');
    expect(why).toContain('gate:');
  });

  it('rejects unknown skills and bad usage', async () => {
    expect(
      await runSupervisorCommand({ loaderContext: ctx }, '!promote', 'x'),
    ).toContain('Usage');
    expect(
      await runSupervisorCommand({ loaderContext: ctx }, '!why ghost', 'x'),
    ).toContain('Unknown skill');
    expect(
      await runSupervisorCommand({ loaderContext: ctx }, '!nope', 'x'),
    ).toContain('Unknown supervisor command');
  });
});

describe('supervisor command channel/author gating', () => {
  it('supervisorAuthorized enforces channel and author allowlists', () => {
    expect(
      supervisorAuthorized({
        channel: 'random',
        supervisorChannels: ['control'],
        authors: [],
      }),
    ).toContain('not permitted in this channel');
    expect(
      supervisorAuthorized({
        channel: 'control',
        authorId: '999',
        supervisorChannels: ['control'],
        authors: ['123'],
      }),
    ).toContain('allowlist');
    expect(
      supervisorAuthorized({
        channel: 'control',
        authorId: '123',
        supervisorChannels: ['control'],
        authors: ['123'],
      }),
    ).toBeUndefined();
  });

  it('the supervisor skill runs only in its channel via dispatch', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claw-sup-'));
    const registry = new SkillRegistry(join(tmp, 's.db'));
    const ctx: SkillLoaderContext = {
      registry,
      skills: new Map<string, Skill>(),
      skillsDir: join(tmp, 'skills'),
      replySource: Source.callback(async () => 'reply'),
      gateOptions: {
        clawRoot: findClawRoot(),
        stagingRoot: join(tmp, 'staging'),
      },
    };
    const supervisorSkill = createSupervisorSkill({
      loaderContext: ctx,
      supervisorChannels: ['control'],
      authors: [],
    });
    registry.upsert({
      id: supervisorSkill.id,
      name: supervisorSkill.name,
      channel: supervisorSkill.trigger.channel ?? null,
      predicateKey: supervisorSkill.trigger.predicateKey,
      behaviorRef: supervisorSkill.id,
      provenance: supervisorSkill.provenance,
      enabled: true,
      createdAt: supervisorSkill.provenance.createdAt,
      tier: 'builtin',
      sourcePath: null,
      sourceHash: null,
      manifestHash: null,
      activeVersion: null,
      gateResult: null,
    });
    ctx.skills.set(supervisorSkill.id, supervisorSkill);

    const agent = createClawSkillAgent({
      registry,
      skills: ctx.skills,
      defaultReply: echoDefault,
    });

    // Wrong channel: trigger channel narrowing means the skill never matches.
    const wrong = await agent.execute({
      session: userSession('!skills', 'random'),
    });
    expect(lastContent(wrong)).toBe('ack: !skills');

    // Right channel: the supervisor command runs.
    const right = await agent.execute({
      session: userSession('!skills', 'control'),
    });
    expect(lastContent(right)).toContain('Skills (');
    registry.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('scheduled scan', () => {
  it('quarantines a skill that failed while idle (direct scan call)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claw-sup-'));
    const registry = new SkillRegistry(join(tmp, 's.db'));
    registry.upsert(row('idle', 'canary'));
    registry.upsert(row('healthy', 'canary'));
    // 'idle' accrued failures without the reactive wrapper firing (e.g. failed
    // deliveries recorded out-of-band).
    for (let i = 0; i < 3; i += 1) {
      registry.recordHealth('idle', {
        success: false,
        latencyMs: 1,
        error: 'stale',
      });
    }

    const quarantined = quarantineScan(registry, supervision);
    expect(quarantined).toEqual(['idle']);
    expect(registry.get('idle')?.tier).toBe('quarantined');
    expect(registry.get('healthy')?.tier).toBe('canary');
    expect(registry.listAudit('idle')[0]).toMatchObject({
      to: 'quarantined',
      actor: 'auto',
    });
    expect(registry.listPendingNotices().map((n) => n.skillId)).toContain(
      'idle',
    );
    registry.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('rollback (subprocess: full gate, two versions)', () => {
  const clawRoot = findClawRoot();
  let base: string;
  beforeAll(() => {
    mkdirSync(join(clawRoot, '.data'), { recursive: true });
    base = mkdtempSync(join(clawRoot, '.data', 'rollback-test-'));
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // v1/v2 differ by a serializable system-prompt literal (so their manifest
  // hashes differ — closure bodies alone are not hashed) AND by the var each
  // sets, which the injected reply source surfaces to make them observable.
  const version = (marker: string, value: string) =>
    `import type { Agent, Source } from '@prompttrail/core';
export const meta = { id: 'ver', name: 'Ver', description: '${value}' };
export const trigger = { startsWith: '!ver' };
export const examples: string[] = ['!ver'];
export function behavior(agent: Agent, reply: Source<string>): Agent {
  return agent
    .system('behavior ${value}')
    .transform('${marker}', (session) => session.withVar('ver', '${value}'))
    .assistant('reply', reply);
}
`;

  it('author v1, author v2 (same id), rollback → v1 behavior dispatches again', async () => {
    const registry = new SkillRegistry(join(base, 'skills.db'));
    const skills = new Map<string, Skill>();
    const ctx: SkillLoaderContext = {
      registry,
      skills,
      skillsDir: join(base, 'skills'),
      // The injected reply surfaces the version marker each behavior sets.
      replySource: Source.callback(async ({ context }) =>
        String((context as Record<string, unknown> | undefined)?.ver ?? 'none'),
      ),
      gateOptions: { clawRoot, stagingRoot: join(base, 'staging') },
    };

    // Distinct STAGING ids (the modules both carry meta.id 'ver') so the two
    // gate builds live at different paths — vitest's import layer caches an
    // absolute path across `?t=` queries, unlike plain Node used in production.
    const g1 = await runGate(
      { id: 'ver-1', source: version('mark1', 'v1') },
      ctx.gateOptions,
    );
    expect(g1.result.passed).toBe(true);
    promoteAndRegister(ctx, {
      module: g1.module!,
      stagingSourcePath: g1.sourcePath!,
      stagingBuiltPath: g1.builtPath!,
      source: version('mark1', 'v1'),
      gateResult: g1.result,
      provenance,
    });

    const g2 = await runGate(
      { id: 'ver-2', source: version('mark2', 'v2') },
      ctx.gateOptions,
    );
    expect(g2.result.passed).toBe(true);
    expect(g2.result.manifestHash).not.toBe(g1.result.manifestHash);
    promoteAndRegister(ctx, {
      module: g2.module!,
      stagingSourcePath: g2.sourcePath!,
      stagingBuiltPath: g2.builtPath!,
      source: version('mark2', 'v2'),
      gateResult: g2.result,
      provenance,
    });

    expect(registry.listVersions('ver')).toHaveLength(2);
    expect(registry.get('ver')?.activeVersion).toBe(g2.result.manifestHash);

    const build = () =>
      createClawSkillAgent({ registry, skills, defaultReply: echoDefault });

    // v2 is active.
    const before = await build().execute({ session: userSession('!ver go') });
    expect(lastContent(before)).toBe('v2');

    // Roll the active-version pointer back to v1 and re-dispatch.
    const msg = await runSupervisorCommand(
      { loaderContext: ctx },
      '!rollback ver',
      'ops',
    );
    expect(msg).toContain('Rolled "ver" back');
    expect(registry.get('ver')?.activeVersion).toBe(g1.result.manifestHash);

    const after = await build().execute({ session: userSession('!ver go') });
    expect(lastContent(after)).toBe('v1');

    // A rollback audit row exists; and no earlier version to roll back to now.
    expect(
      registry.listAudit('ver').some((a) => a.reason.includes('rollback')),
    ).toBe(true);
    const again = await runSupervisorCommand(
      { loaderContext: ctx },
      '!rollback ver',
      'ops',
    );
    expect(again).toContain('no previous version');
    registry.close();
  }, 180_000);
});
