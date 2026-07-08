import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  Agent,
  createAgentGraphManifest,
  Session,
  Source,
} from '@prompttrail/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authorTurn,
  AuthoringMutex,
  createClawSkillAgent,
  findClawRoot,
  loadStagedSkills,
  parseInstruction,
  promoteAndRegister,
  renderSkillModule,
  runGate,
  SkillRegistry,
  templateSynthesizer,
  type Skill,
  type SkillLoaderContext,
  type SkillProvenance,
} from './index.js';

const clawRoot = findClawRoot();
let root: string;

beforeAll(() => {
  mkdirSync(join(clawRoot, '.data'), { recursive: true });
  root = mkdtempSync(join(clawRoot, '.data', 'authoring-test-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const provenance: SkillProvenance = {
  authoredBy: 'test',
  motivation: 'unit test',
  createdAt: '2026-07-08T00:00:00.000Z',
};

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

interface Fixture {
  base: string;
  registry: SkillRegistry;
  skills: Map<string, Skill>;
  ctx: SkillLoaderContext;
}

function makeFixture(name: string): Fixture {
  const base = join(root, name);
  mkdirSync(base, { recursive: true });
  const registry = new SkillRegistry(join(base, 'skills.db'));
  const skills = new Map<string, Skill>();
  const ctx: SkillLoaderContext = {
    registry,
    skills,
    skillsDir: join(base, 'skills'),
    replySource: Source.callback(async () => 'reply-ok'),
    gateOptions: { clawRoot, stagingRoot: join(base, 'staging') },
  };
  return { base, registry, skills, ctx };
}

describe('synthesizer (deterministic, no subprocess)', () => {
  it('parses trigger, channel, and id from an instruction', () => {
    const spec = parseInstruction(
      'in channel control when a message starts with "!foo" reply politely',
    );
    expect(spec.startsWith).toBe('!foo');
    expect(spec.channels).toEqual(['control']);
    expect(spec.id).toBe('foo');
    const source = renderSkillModule(spec);
    expect(source).toContain('startsWith: "!foo"');
    expect(source).toContain('channels: ["control"]');
    expect(source).toContain('export function behavior(');
  });
});

describe('authoring end-to-end (subprocess: full gate)', () => {
  it('gate → promote → dispatch, with version + tier recorded', async () => {
    const { registry, skills, ctx } = makeFixture('e2e');
    const source = await templateSynthesizer.synthesize(
      'when a message starts with "!weather" reply with the weather',
    );
    const gate = await runGate({ id: 'weather', source }, ctx.gateOptions);
    expect(gate.result.passed).toBe(true);

    const skill = promoteAndRegister(ctx, {
      module: gate.module!,
      stagingSourcePath: gate.sourcePath!,
      stagingBuiltPath: gate.builtPath!,
      source,
      gateResult: gate.result,
      provenance,
    });
    expect(skill.id).toBe('weather');

    // The dispatcher now routes the trigger to the freshly authored skill.
    const agent = createClawSkillAgent({
      registry,
      skills,
      defaultReply: echoDefault,
    });
    const matched = await agent.execute({
      session: userSession('!weather today'),
    });
    expect(lastContent(matched)).toBe('reply-ok');
    const missed = await agent.execute({ session: userSession('unrelated') });
    expect(lastContent(missed)).toBe('ack: unrelated');

    const row = registry.get('weather');
    expect(row?.tier).toBe('staged');
    expect(row?.manifestHash).toBe(gate.result.manifestHash);
    expect(row?.activeVersion).toBe(gate.result.manifestHash);
    expect(registry.listVersions('weather')).toHaveLength(1);
    registry.close();
  }, 120_000);

  it('parent graph manifest hash is unchanged after authoring', async () => {
    const { registry, skills, ctx } = makeFixture('manifest');
    const build = () =>
      createClawSkillAgent({ registry, skills, defaultReply: echoDefault });
    const before = createAgentGraphManifest(build().toGraph()).hash;

    const source = await templateSynthesizer.synthesize(
      'when a message starts with "!ping" reply pong',
    );
    const gate = await runGate({ id: 'ping', source }, ctx.gateOptions);
    expect(gate.result.passed).toBe(true);
    promoteAndRegister(ctx, {
      module: gate.module!,
      stagingSourcePath: gate.sourcePath!,
      stagingBuiltPath: gate.builtPath!,
      source,
      gateResult: gate.result,
      provenance,
    });

    const after = createAgentGraphManifest(build().toGraph()).hash;
    expect(after).toBe(before);
    registry.close();
  }, 120_000);
});

describe('restart reload', () => {
  it('a new registry + skills dir re-loads the skill so it still dispatches', async () => {
    const { base, registry, ctx } = makeFixture('reload');
    const source = await templateSynthesizer.synthesize(
      'when a message starts with "!echo2" reply echo',
    );
    const gate = await runGate({ id: 'echo2', source }, ctx.gateOptions);
    expect(gate.result.passed).toBe(true);
    promoteAndRegister(ctx, {
      module: gate.module!,
      stagingSourcePath: gate.sourcePath!,
      stagingBuiltPath: gate.builtPath!,
      source,
      gateResult: gate.result,
      provenance,
    });
    registry.close();

    // Simulate a restart: fresh registry (same file) + fresh in-process map.
    const registry2 = new SkillRegistry(join(base, 'skills.db'));
    const skills2 = new Map<string, Skill>();
    const ctx2: SkillLoaderContext = {
      registry: registry2,
      skills: skills2,
      skillsDir: ctx.skillsDir,
      replySource: Source.callback(async () => 'reply-ok'),
      gateOptions: ctx.gateOptions,
    };
    const loaded = await loadStagedSkills(ctx2);
    expect(loaded.map((s) => s.id)).toContain('echo2');
    expect(skills2.has('echo2')).toBe(true);

    const agent = createClawSkillAgent({
      registry: registry2,
      skills: skills2,
      defaultReply: echoDefault,
    });
    const result = await agent.execute({ session: userSession('!echo2 hi') });
    expect(lastContent(result)).toBe('reply-ok');
    registry2.close();
  }, 120_000);
});

describe('authorization boundary', () => {
  it('refuses to author outside the privileged channel', async () => {
    const { registry, ctx } = makeFixture('deny-channel');
    const reply = await authorTurn({
      content: '!skill when starts with "!nope" reply nope',
      channel: 'random',
      authoringChannels: ['control'],
      authors: [],
      mutex: new AuthoringMutex(),
      deps: { loaderContext: ctx, synthesizer: templateSynthesizer },
    });
    expect(reply).toContain('not permitted in this channel');
    expect(registry.get('nope')).toBeUndefined();
    registry.close();
  });

  it('refuses an author not on the allowlist', async () => {
    const { registry, ctx } = makeFixture('deny-author');
    const reply = await authorTurn({
      content: '!skill when starts with "!nope" reply nope',
      channel: 'control',
      authorId: '999',
      authoringChannels: ['control'],
      authors: ['123'],
      mutex: new AuthoringMutex(),
      deps: { loaderContext: ctx, synthesizer: templateSynthesizer },
    });
    expect(reply).toContain('allowlist');
    expect(registry.get('nope')).toBeUndefined();
    registry.close();
  });

  it('authors successfully in the privileged channel for an allowed author', async () => {
    const { registry, ctx } = makeFixture('allow');
    const reply = await authorTurn({
      content: '!skill when a message starts with "!hola" reply hola',
      channel: 'control',
      authorId: '123',
      authoringChannels: ['control'],
      authors: ['123'],
      mutex: new AuthoringMutex(),
      deps: { loaderContext: ctx, synthesizer: templateSynthesizer },
    });
    expect(reply).toContain('Authored and activated');
    expect(registry.get('hola')?.tier).toBe('staged');
    registry.close();
  }, 120_000);

  it('rate-limits to one authoring run at a time', async () => {
    const mutex = new AuthoringMutex();
    const first = mutex.run(
      () => new Promise<string>((r) => setTimeout(() => r('done'), 50)),
    );
    const second = await mutex.run(async () => 'should-not-run');
    expect(second.ran).toBe(false);
    expect((await first).ran).toBe(true);
  });
});
