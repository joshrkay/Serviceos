/**
 * Skill constraints for feasibility (4.9 / issue #1001).
 *
 * `requiredSkillsForJob` returning `[]` is a REAL answer — "this tenant has
 * modeled no skill constraints for this job" — not an unknown and not a
 * silent pass. `checkFeasibility` reports it as
 * `skillConstraints: 'none_configured'` on the feasibility outcome, and the
 * dispatch creation path persists that outcome on the proposal's
 * `proposal.created` audit row, so a reader can tell "nothing was configured"
 * apart from "skills were checked and matched".
 *
 * Skills-based ASSIGNMENT ("closest certified tech assigned automatically")
 * is deliberately NOT built here — #1001's decision was to fix the silent
 * lie, not to build the feature. A real matcher drops in behind this
 * interface with no change to the feasibility composer.
 */
export interface SkillMatcher {
  requiredSkillsForJob(tenantId: string, jobId: string): Promise<string[]>;
  skillsForTechnician(tenantId: string, technicianId: string): Promise<string[]>;
}

/** The wired implementation: no tenant models skills yet, so both lists are empty. */
export class StubSkillMatcher implements SkillMatcher {
  async requiredSkillsForJob(): Promise<string[]> { return []; }
  async skillsForTechnician(): Promise<string[]> { return []; }
}
