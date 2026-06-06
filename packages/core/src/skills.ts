import type { CapabilitySet, RuntimeSkill } from './capabilities';

export type SkillInjectionPolicy = 'warn' | 'error' | 'silent';

export interface SkillInstructionInjectionResult {
  instructions?: string;
  warnings: string[];
}

export function getRuntimeSkills(
  capabilities: CapabilitySet | undefined,
): RuntimeSkill[] {
  return (capabilities ?? []).filter(
    (capability): capability is RuntimeSkill => capability.kind === 'skill',
  );
}

export function buildSkillInstructionInjection(
  capabilities: CapabilitySet | undefined,
  policy: SkillInjectionPolicy = 'warn',
): SkillInstructionInjectionResult {
  const warnings: string[] = [];
  const instructionBlocks: string[] = [];

  for (const skill of getRuntimeSkills(capabilities)) {
    if (skill.instructions) {
      instructionBlocks.push(
        `Skill: ${skill.name}\n${skill.description ? `${skill.description}\n` : ''}${skill.instructions}`,
      );
    }

    if (skill.path || skill.materialize) {
      const warning = `RuntimeSkill "${skill.name}" carries files or materialization metadata that cannot be represented by instruction injection.`;
      if (policy === 'error') {
        throw new Error(warning);
      }
      if (policy === 'warn') {
        warnings.push(warning);
      }
    }
  }

  return {
    instructions:
      instructionBlocks.length > 0
        ? ['Available runtime skills:', ...instructionBlocks].join('\n\n')
        : undefined,
    warnings,
  };
}

export function appendSkillInstructions(
  baseInstructions: string | undefined,
  capabilities: CapabilitySet | undefined,
  policy: SkillInjectionPolicy = 'warn',
): { instructions?: string; warnings: string[] } {
  const injection = buildSkillInstructionInjection(capabilities, policy);
  return {
    instructions: [baseInstructions, injection.instructions]
      .filter(Boolean)
      .join('\n\n'),
    warnings: injection.warnings,
  };
}

export function warnSkillInstructionLoss(warnings: readonly string[]): void {
  for (const warning of warnings) {
    console.warn(warning);
  }
}
