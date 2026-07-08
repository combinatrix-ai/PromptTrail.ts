import type { SkillRegistry, SkillRegistryRow } from './registry.js';
import type { Skill } from './types.js';

export * from './types.js';
export * from './registry.js';
export * from './dispatch.js';
export * from './status.js';

/** Derive the serializable registry row from an in-process skill. */
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
