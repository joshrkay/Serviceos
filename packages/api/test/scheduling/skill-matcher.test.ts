import { describe, it, expect } from 'vitest';
import { RepoSkillMatcher } from '../../src/scheduling/skill-matcher';

/**
 * Dispatch FR-2 phase 2 — the wired matcher. Tag normalization is pinned in
 * packages/shared/src/contracts/skill-tags.test.ts. What an empty
 * required list MEANS downstream (`skillConstraints: 'none_configured'`) is
 * pinned in test/scheduling/feasibility-skill.test.ts.
 */
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
