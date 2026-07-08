import type { SkillRegistry, SkillRegistryRow } from './registry.js';
import type { Skill } from './types.js';

export * from './types.js';
export * from './registry.js';
export * from './dispatch.js';
export * from './status.js';
export * from './skill-module.js';
export * from './authoring.js';
export * from './gate.js';
export * from './loader.js';
export * from './author-skill.js';

/**
 * Derive the serializable registry row from an in-process skill. Used for
 * seeding hand-written skills, which are tier 'builtin' and carry no
 * self-authored source/gate/version provenance.
 */
export function skillToRow(skill: Skill): SkillRegistryRow {
  return {
    id: skill.id,
    name: skill.name,
    channel: skill.trigger.channel ?? null,
    predicateKey: skill.trigger.predicateKey,
    behaviorRef: skill.id,
    provenance: skill.provenance,
    enabled: true,
    createdAt: skill.provenance.createdAt,
    tier: 'builtin',
    sourcePath: null,
    sourceHash: null,
    manifestHash: null,
    activeVersion: null,
    gateResult: null,
  };
}

/**
 * Register built-in (hand-written) skills: build the in-process map and seed a
 * registry row for each on first boot (idempotent — existing rows, including
 * disabled ones, are left untouched).
 */
export function registerBuiltinSkills(
  registry: SkillRegistry,
  skills: readonly Skill[],
): Map<string, Skill> {
  const map = new Map<string, Skill>();
  for (const skill of skills) {
    map.set(skill.id, skill);
    registry.seedIfMissing(skillToRow(skill));
  }
  return map;
}
