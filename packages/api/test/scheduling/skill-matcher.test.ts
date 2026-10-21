import { describe, it, expect } from 'vitest';
import { RepoSkillMatcher } from '../../src/scheduling/skill-matcher';
import {
  MAX_SKILL_TAGS,
  normalizeSkillTag,
  normalizeSkillTags,
  skillTagsSchema,
} from '../../src/shared/skill-tags';

/**
 * Dispatch FR-2 phase 2 — skill tags and the wired matcher. What an empty
 * required list MEANS downstream (`skillConstraints: 'none_configured'`) is
 * pinned in test/scheduling/feasibility-skill.test.ts.
 */
describe('normalizeSkillTag', () => {
  it('trims, lower-cases and folds inner whitespace to _', () => {
    expect(normalizeSkillTag('  EPA   608 ')).toBe('epa_608');
    expect(normalizeSkillTag('Gas-Certified')).toBe('gas-certified');
  });

  it('rejects empty, overlong and punctuated tags', () => {
    expect(normalizeSkillTag('   ')).toBeNull();
    expect(normalizeSkillTag('a'.repeat(41))).toBeNull();
    expect(normalizeSkillTag('R&D')).toBeNull();
    expect(normalizeSkillTag('_leading')).toBeNull();
  });
});

describe('normalizeSkillTags', () => {
  it('de-duplicates on canonical form, keeping first-seen order, and drops unusable entries', () => {
    expect(normalizeSkillTags(['HVAC', 'gas certified', 'hvac', '', 'Gas_Certified'])).toEqual([
      'hvac',
      'gas_certified',
    ]);
  });
});

describe('skillTagsSchema', () => {
  it('normalizes a valid list', () => {
    expect(skillTagsSchema.parse(['Backflow', ' lift required '])).toEqual(['backflow', 'lift_required']);
  });

  it('accepts an empty list (clears the tags)', () => {
    expect(skillTagsSchema.parse([])).toEqual([]);
  });

  it('rejects a tag it cannot normalize instead of silently dropping it', () => {
    const r = skillTagsSchema.safeParse(['hvac', 'R&D']);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toContain('R&D');
  });

  it(`rejects more than ${MAX_SKILL_TAGS} tags`, () => {
    const tags = Array.from({ length: MAX_SKILL_TAGS + 1 }, (_, i) => `skill_${i}`);
    expect(skillTagsSchema.safeParse(tags).success).toBe(false);
  });
});

describe('RepoSkillMatcher', () => {
  const jobRepo = {
    findById: async (tenantId: string, id: string) =>
      tenantId === 't-1' && id === 'j-1' ? ({ requiredSkills: ['Gas Certified'] } as any) : null,
  };
  const userRepo = {
    findById: async (tenantId: string, id: string) =>
      tenantId === 't-1' && id === 'u-1' ? ({ skills: ['HVAC', 'gas_certified'] } as any) : null,
  };
  const m = new RepoSkillMatcher(jobRepo, userRepo);

  it("reads the job's required skills in canonical form", async () => {
    expect(await m.requiredSkillsForJob('t-1', 'j-1')).toEqual(['gas_certified']);
  });

  it("reads the technician's skills in canonical form", async () => {
    expect(await m.skillsForTechnician('t-1', 'u-1')).toEqual(['hvac', 'gas_certified']);
  });

  it('treats a missing job or technician (or another tenant) as no tags', async () => {
    expect(await m.requiredSkillsForJob('t-2', 'j-1')).toEqual([]);
    expect(await m.skillsForTechnician('t-1', 'nobody')).toEqual([]);
  });

  it('treats a row without the field as no tags', async () => {
    const bare = new RepoSkillMatcher(
      { findById: async () => ({}) as any },
      { findById: async () => ({}) as any },
    );
    expect(await bare.requiredSkillsForJob('t-1', 'j-1')).toEqual([]);
    expect(await bare.skillsForTechnician('t-1', 'u-1')).toEqual([]);
  });
});
