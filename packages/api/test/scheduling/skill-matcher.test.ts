import { describe, it, expect } from 'vitest';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';

describe('StubSkillMatcher', () => {
  const m = new StubSkillMatcher();

  it('returns empty required skills for any job', async () => {
    expect(await m.requiredSkillsForJob('t', 'j')).toEqual([]);
  });

  it('returns empty held skills for any technician', async () => {
    expect(await m.skillsForTechnician('t', 'u')).toEqual([]);
  });
});
