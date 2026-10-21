import type { AppointmentRepository, AppointmentStatus } from '../appointments/appointment';
import type { AssignmentRepository } from '../appointments/assignment';
import { ConflictError } from '../shared/errors';
import { normalizeSkillTags } from '@ai-service-os/shared';
import { SkillMatcher, missingSkills } from './skill-matcher';

/**
 * Dispatch FR-2 — editing skills must not strand a dispatched visit with a
 * technician who no longer qualifies. Both edits are refused (409) while an
 * active visit would break the rule; the fix is to reassign first. Finished,
 * canceled and no-show visits are history and are not re-judged.
 */
const ACTIVE: ReadonlySet<AppointmentStatus> = new Set(['scheduled', 'confirmed', 'in_progress']);

export interface SkillEditGuardDeps {
  appointmentRepo: Pick<AppointmentRepository, 'findByJob' | 'findById'>;
  assignmentRepo: Pick<AssignmentRepository, 'findByAppointment' | 'findByTechnician'>;
  skillMatcher: SkillMatcher;
}

/** A job's new required skills against every technician on its active visits. */
export async function assertJobSkillEditKeepsAssigneesQualified(
  deps: SkillEditGuardDeps,
  tenantId: string,
  jobId: string,
  requiredSkills: readonly string[],
): Promise<void> {
  const required = normalizeSkillTags([...requiredSkills]);
  if (required.length === 0) return;
  const active = (await deps.appointmentRepo.findByJob(tenantId, jobId)).filter((a) => ACTIVE.has(a.status));
  for (const appt of active) {
    for (const assignment of await deps.assignmentRepo.findByAppointment(tenantId, appt.id)) {
      const held = await deps.skillMatcher.skillsForTechnician(tenantId, assignment.technicianId);
      const missing = missingSkills(required, held);
      if (missing.length > 0) {
        throw new ConflictError(
          `A technician on this job's upcoming visit is missing: ${missing.join(', ')}. Reassign the visit first.`,
        );
      }
    }
  }
}

/** A technician's new skills against the required skills of their active visits. */
export async function assertTechnicianSkillEditKeepsVisitsQualified(
  deps: SkillEditGuardDeps,
  tenantId: string,
  technicianId: string,
  skills: readonly string[],
): Promise<void> {
  const held = normalizeSkillTags([...skills]);
  for (const assignment of await deps.assignmentRepo.findByTechnician(tenantId, technicianId)) {
    const appt = await deps.appointmentRepo.findById(tenantId, assignment.appointmentId);
    if (!appt?.jobId || !ACTIVE.has(appt.status)) continue;
    const missing = missingSkills(await deps.skillMatcher.requiredSkillsForJob(tenantId, appt.jobId), held);
    if (missing.length > 0) {
      throw new ConflictError(
        `This technician is assigned to an upcoming visit that needs: ${missing.join(', ')}. Reassign it first.`,
      );
    }
  }
}
