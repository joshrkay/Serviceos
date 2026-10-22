import type { Appointment, AppointmentRepository, AppointmentStatus } from '../appointments/appointment';
import { MAX_APPOINTMENT_LIMIT } from '../appointments/appointment';
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
const ACTIVE_STATUSES: readonly AppointmentStatus[] = ['scheduled', 'confirmed', 'in_progress'];
const ACTIVE: ReadonlySet<AppointmentStatus> = new Set(ACTIVE_STATUSES);

export interface SkillEditGuardDeps {
  appointmentRepo: Pick<AppointmentRepository, 'findByJob' | 'listWithMeta'>;
  assignmentRepo: Pick<AssignmentRepository, 'findByAppointment'>;
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

/**
 * A technician's ACTIVE visits only — a filtered, paged query per status
 * (Pg: one EXISTS-on-assignments query each), never a walk over their whole
 * assignment history.
 */
async function activeVisitsForTechnician(
  appointmentRepo: SkillEditGuardDeps['appointmentRepo'],
  tenantId: string,
  technicianId: string,
): Promise<Appointment[]> {
  if (!appointmentRepo.listWithMeta) {
    throw new Error('skill edit guard needs AppointmentRepository.listWithMeta');
  }
  const visits: Appointment[] = [];
  for (const status of ACTIVE_STATUSES) {
    for (let offset = 0; ; offset += MAX_APPOINTMENT_LIMIT) {
      const page = await appointmentRepo.listWithMeta(tenantId, {
        technicianId, status, limit: MAX_APPOINTMENT_LIMIT, offset,
      });
      visits.push(...page.data);
      if (page.data.length < MAX_APPOINTMENT_LIMIT) break;
    }
  }
  return visits;
}

/** A technician's new skills against the required skills of their active visits. */
export async function assertTechnicianSkillEditKeepsVisitsQualified(
  deps: SkillEditGuardDeps,
  tenantId: string,
  technicianId: string,
  skills: readonly string[],
): Promise<void> {
  const held = normalizeSkillTags([...skills]);
  const jobIds = new Set(
    (await activeVisitsForTechnician(deps.appointmentRepo, tenantId, technicianId)).map((a) => a.jobId).filter(Boolean),
  );
  for (const jobId of jobIds) {
    const missing = missingSkills(await deps.skillMatcher.requiredSkillsForJob(tenantId, jobId), held);
    if (missing.length > 0) {
      throw new ConflictError(
        `This technician is assigned to an upcoming visit that needs: ${missing.join(', ')}. Reassign it first.`,
      );
    }
  }
}
