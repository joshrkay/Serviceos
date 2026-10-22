import type { SkillMatcher } from '../../src/scheduling/skill-matcher';

/**
 * A matcher for tests that are not about skills: every job has no required
 * skills, so feasibility reports `skillConstraints: 'none_configured'`.
 */
export function noSkillConstraints(): SkillMatcher {
  return {
    requiredSkillsForJob: async () => [],
    skillsForTechnician: async () => [],
  };
}
