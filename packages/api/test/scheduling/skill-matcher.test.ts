import { describe, it, expect } from 'vitest';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';

/**
 * 4.9 / issue #1001 — the nine-line module. `[]` is a REAL answer ("this
 * tenant has modeled no skill constraints"), not an unknown and not a silent
 * pass. What that `[]` MEANS downstream is pinned in
 * test/scheduling/feasibility-skill.test.ts: `checkFeasibility` must report
 * it as `skillConstraints: 'none_configured'` rather than an empty issue list
 * that reads as "always feasible".
 */
describe('StubSkillMatcher', () => {
  const m = new StubSkillMatcher();

  it('returns empty required skills for any job', async () => {
    expect(await m.requiredSkillsForJob('t', 'j')).toEqual([]);
  });

  it('returns empty held skills for any technician', async () => {
    expect(await m.skillsForTechnician('t', 'u')).toEqual([]);
  });
});
