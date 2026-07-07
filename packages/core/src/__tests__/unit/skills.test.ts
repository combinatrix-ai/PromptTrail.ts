import { describe, expect, it, vi } from 'vitest';
import {
  appendSkillInstructions,
  buildSkillInstructionInjection,
  warnSkillInstructionLoss,
} from '../../skills';

describe('RuntimeSkill instruction injection', () => {
  it('builds instruction text from runtime skills', () => {
    expect(
      buildSkillInstructionInjection([
        {
          kind: 'skill',
          name: 'review',
          description: 'Review code',
          instructions: 'Check risky changes first.',
        },
      ]),
    ).toEqual({
      instructions:
        'Available runtime skills:\n\nSkill: review\nReview code\nCheck risky changes first.',
      warnings: [],
    });
  });

  it('warns or errors when file-backed skills are injected as text', () => {
    expect(
      buildSkillInstructionInjection([
        {
          kind: 'skill',
          name: 'file-skill',
          instructions: 'Use files.',
          path: '.claude/skills/file-skill',
        },
      ]),
    ).toMatchObject({
      warnings: [
        'RuntimeSkill "file-skill" carries files or materialization metadata that cannot be represented by instruction injection.',
      ],
    });

    expect(() =>
      buildSkillInstructionInjection(
        [
          {
            kind: 'skill',
            name: 'file-skill',
            path: '.claude/skills/file-skill',
          },
        ],
        'error',
      ),
    ).toThrow('RuntimeSkill "file-skill" carries files');
  });

  it('appends skill instructions to existing system instructions', () => {
    expect(
      appendSkillInstructions('Base system.', [
        {
          kind: 'skill',
          name: 'docs',
          instructions: 'Prefer repo docs.',
        },
      ]).instructions,
    ).toBe(
      'Base system.\n\nAvailable runtime skills:\n\nSkill: docs\nPrefer repo docs.',
    );
  });

  it('emits warnings through console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnSkillInstructionLoss(['warning one', 'warning two']);

    expect(warn).toHaveBeenCalledWith('warning one');
    expect(warn).toHaveBeenCalledWith('warning two');
    warn.mockRestore();
  });
});
