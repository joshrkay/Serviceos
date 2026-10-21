import type { JobRepository } from '../jobs/job';
import type { UserRepository } from '../users/user';
import { normalizeSkillTags } from '@ai-service-os/shared';
import { ConflictError } from '../shared/errors';

/**
 * Skill constraints for feasibility (4.9 / issue #1001; Dispatch FR-2 phase 2).
 *
 * `requiredSkillsForJob` returning `[]` is a REAL answer — "this job has no
 * skill constraints" — not an unknown and not a silent pass.
 * `checkFeasibility` reports it as `skillConstraints: 'none_configured'`, so a
 * reader can tell "nothing was configured" apart from "skills were checked
 * and matched".
 */
export interface SkillMatcher {
  requiredSkillsForJob(tenantId: string, jobId: string): Promise<string[]>;
  skillsForTechnician(tenantId: string, technicianId: string): Promise<string[]>;
}

/**
 * The wired matcher: a job's `requiredSkills` against a technician's
 * `skills`, both read through the domain repositories so the Postgres and
 * in-memory stacks behave the same. A missing job or user reads as no tags.
 */
export class RepoSkillMatcher implements SkillMatcher {
  constructor(
    private readonly jobRepo: Pick<JobRepository, 'findById'>,
    private readonly userRepo: Pick<UserRepository, 'findById'>,
  ) {}

  async requiredSkillsForJob(tenantId: string, jobId: string): Promise<string[]> {
    const job = await this.jobRepo.findById(tenantId, jobId);
    return normalizeSkillTags(job?.requiredSkills ?? []);
  }

  async skillsForTechnician(tenantId: string, technicianId: string): Promise<string[]> {
    const user = await this.userRepo.findById(tenantId, technicianId);
    return normalizeSkillTags(user?.skills ?? []);
  }
}

/** The required skills a technician does not hold, in the job's order. */
export function missingSkills(required: readonly string[], held: readonly string[]): string[] {
  return required.filter((s) => !held.includes(s));
}

/**
 * The skill precondition for every write that commits a technician to a job's
 * appointment (assign, reassign, schedule-with-tech), so a direct route can't
 * skip what the feasibility gate enforces. Throws ConflictError (409); a job
 * with no required skills is unconstrained.
 */
export async function assertTechnicianHoldsRequiredSkills(
  tenantId: string,
  technicianId: string,
  jobId: string,
  matcher: SkillMatcher,
): Promise<void> {
  const required = await matcher.requiredSkillsForJob(tenantId, jobId);
  if (required.length === 0) return;
  const missing = missingSkills(required, await matcher.skillsForTechnician(tenantId, technicianId));
  if (missing.length > 0) {
    throw new ConflictError(`Technician is missing required skill(s): ${missing.join(', ')}`);
  }
}
