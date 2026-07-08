import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  createAgentGraphManifest,
  Session,
  Source,
} from '@prompttrail/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createClawSkillAgent,
  createStatusSkill,
  registerBuiltinSkills,
  runSkillInstrumented,
  SkillRegistry,
  skillToRow,
  statusMessage,
  type Skill,
} from './index.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'claw-skills-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function dbPath(name = 'skills.db'): string {
  return join(tmp, name);
}

/** A default reply builder that echoes the last message (the else branch). */
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

describe('status skill', () => {
  it('formats version, reply mode, and uptime deterministically', () => {
    const message = statusMessage({
      version: '1.2.3',
      replyMode: 'echo',
      startedAt: 1000,
      now: () => 61000,
    });
    expect(message).toBe('claw v1.2.3 | reply-mode: echo | uptime: 60s');
  });
});

describe('dispatch', () => {
  it('runs the matched skill behavior and echoes otherwise', async () => {
    const registry = new SkillRegistry(dbPath());
    const skills = registerBuiltinSkills(registry, [
      createStatusSkill({
        version: '9.9.9',
        replyMode: 'echo',
        startedAt: 0,
        now: () => 5000,
      }),
    ]);
    const agent = createClawSkillAgent({
      registry,
      skills,
      defaultReply: echoDefault,
    });

    const matched = await agent.execute({ session: userSession('!status') });
    expect(lastContent(matched)).toBe(
      'claw v9.9.9 | reply-mode: echo | uptime: 5s',
    );

    const unmatched = await agent.execute({ session: userSession('hello') });
    expect(lastContent(unmatched)).toBe('ack: hello');

    registry.close();
  });

  it('honors trigger.channel narrowing', async () => {
    const registry = new SkillRegistry(dbPath());
    const skill: Skill = {
      id: 'greet',
      name: 'Greet',
      trigger: {
        channel: 'welcome',
        predicateKey: 'startsWith:hi',
        when: (content) => content.startsWith('hi'),
      },
      behavior: (agent) => agent.assistant(Source.literal('hello there')),
      provenance: {
        authoredBy: 'test',
        motivation: 'channel narrowing',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const skills = registerBuiltinSkills(registry, [skill]);
    const agent = createClawSkillAgent({
      registry,
      skills,
      defaultReply: echoDefault,
    });

    const inChannel = await agent.execute({
      session: userSession('hi', 'welcome'),
    });
    expect(lastContent(inChannel)).toBe('hello there');

    const wrongChannel = await agent.execute({
      session: userSession('hi', 'random'),
    });
    expect(lastContent(wrongChannel)).toBe('ack: hi');

    registry.close();
  });
});

describe('registry persistence', () => {
  it('rows survive a simulated restart (new instance, same file)', () => {
    const path = dbPath('persist.db');
    const first = new SkillRegistry(path);
    const seeded = first.seedIfMissing(
      skillToRow(
        createStatusSkill({
          version: '1.0.0',
          replyMode: 'echo',
          startedAt: 0,
        }),
      ),
    );
    expect(seeded).toBe(true);
    first.close();

    const restarted = new SkillRegistry(path);
    const rows = restarted.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'status',
      name: 'Status',
      behaviorRef: 'status',
      enabled: true,
    });
    // Seeding again is idempotent — no duplicate row.
    expect(restarted.seedIfMissing(skillToRow(statusSkill()))).toBe(false);
    expect(restarted.list()).toHaveLength(1);
    restarted.close();
  });
});

function statusSkill(): Skill {
  return createStatusSkill({
    version: '1.0.0',
    replyMode: 'echo',
    startedAt: 0,
  });
}

describe('health record', () => {
  it('increments invocations/successes on success', async () => {
    const registry = new SkillRegistry(dbPath());
    const skills = registerBuiltinSkills(registry, [statusSkill()]);
    const skill = skills.get('status')!;

    let clock = 0;
    await runSkillInstrumented(registry, skill, userSession('!status'), () => {
      clock += 10;
      return clock;
    });

    const health = registry.getHealth('status');
    expect(health).toMatchObject({
      skillId: 'status',
      invocations: 1,
      successes: 1,
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(health?.lastLatencyMs).toBe(10);
    registry.close();
  });

  it('increments consecutiveFailures and records lastError on failure', async () => {
    const registry = new SkillRegistry(dbPath());
    const boom: Skill = {
      id: 'boom',
      name: 'Boom',
      trigger: {
        predicateKey: 'always',
        when: () => true,
      },
      behavior: (agent) =>
        agent.assistant(
          Source.callback(async () => {
            throw new Error('kaboom');
          }),
        ),
      provenance: {
        authoredBy: 'test',
        motivation: 'failure path',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    registerBuiltinSkills(registry, [boom]);

    await expect(
      runSkillInstrumented(registry, boom, userSession('go')),
    ).rejects.toThrow('kaboom');
    await expect(
      runSkillInstrumented(registry, boom, userSession('go')),
    ).rejects.toThrow('kaboom');

    const health = registry.getHealth('boom');
    expect(health).toMatchObject({
      invocations: 2,
      successes: 0,
      consecutiveFailures: 2,
      lastError: 'kaboom',
    });
    registry.close();
  });
});

describe('disabled skills', () => {
  it('are skipped by the dispatcher', async () => {
    const registry = new SkillRegistry(dbPath());
    const skills = registerBuiltinSkills(registry, [
      createStatusSkill({ version: '1.0.0', replyMode: 'echo', startedAt: 0 }),
    ]);
    registry.setEnabled('status', false);

    const agent = createClawSkillAgent({
      registry,
      skills,
      defaultReply: echoDefault,
    });
    const result = await agent.execute({ session: userSession('!status') });
    expect(lastContent(result)).toBe('ack: !status');
    registry.close();
  });
});

describe('parent graph stability', () => {
  it('manifest hash is unchanged when a registry row is added', () => {
    const registry = new SkillRegistry(dbPath());
    const skills = new Map<string, Skill>();
    const build = () =>
      createClawSkillAgent({ registry, skills, defaultReply: echoDefault });

    const before = createAgentGraphManifest(build().toGraph()).hash;

    // Adding a skill row must NOT change the parent graph structure/hash.
    const status = createStatusSkill({
      version: '1.0.0',
      replyMode: 'echo',
      startedAt: 0,
    });
    skills.set(status.id, status);
    registry.seedIfMissing(skillToRow(status));

    const afterOne = createAgentGraphManifest(build().toGraph()).hash;

    const extra: Skill = {
      id: 'extra',
      name: 'Extra',
      trigger: { predicateKey: 'never', when: () => false },
      behavior: (agent) => agent.assistant(Source.literal('x')),
      provenance: {
        authoredBy: 'test',
        motivation: 'second row',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    skills.set(extra.id, extra);
    registry.seedIfMissing(skillToRow(extra));

    const afterTwo = createAgentGraphManifest(build().toGraph()).hash;

    expect(afterOne).toBe(before);
    expect(afterTwo).toBe(before);
    registry.close();
  });
});
