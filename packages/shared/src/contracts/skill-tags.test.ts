import { describe, it, expect } from 'vitest';
import {
  MAX_SKILL_TAGS,
  normalizeSkillTag,
  normalizeSkillTags,
  skillTagsSchema,
} from './skill-tags.js';

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
