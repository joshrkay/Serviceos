import { describe, it, expect, beforeEach } from 'vitest';
import {
  assertJobSkillEditKeepsAssigneesQualified,
  assertTechnicianSkillEditKeepsVisitsQualified,
} from '../../src/scheduling/skill-edit-guard';
import { InMemoryAppointmentRepository, createAppointment } from '../../src/appointments/appointment';
import { InMemoryAssignmentRepository, assignTechnician } from '../../src/appointments/assignment';

/** Dispatch FR-2 — a skills edit must not strand an active visit with an unqualified tech. */
describe('skill edit guards', () => {
  const T = 'tenant-1';
  let appointmentRepo: InMemoryAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;
  const skills: Record<string, string[]> = {};
  const required: Record<string, string[]> = {};
  const skillMatcher = {
    requiredSkillsForJob: async (_t: string, jobId: string) => required[jobId] ?? [],
    skillsForTechnician: async (_t: string, techId: string) => skills[techId] ?? [],
  };
  const deps = () => ({ appointmentRepo, assignmentRepo, skillMatcher });

  async function visit(jobId: string, techId: string) {
    const appt = await createAppointment(
      {
        tenantId: T, jobId, createdBy: 'disp',
        scheduledStart: new Date('2030-07-01T15:00:00Z'), scheduledEnd: new Date('2030-07-01T16:00:00Z'), timezone: 'UTC',
      },
      appointmentRepo,
    );
    await assignTechnician(
      { tenantId: T, appointmentId: appt.id, technicianId: techId, technicianRole: 'technician', assignedBy: 'disp' },
      assignmentRepo,
    );
    return appt;
  }

  beforeEach(() => {
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
    for (const k of Object.keys(skills)) delete skills[k];
    for (const k of Object.keys(required)) delete required[k];
  });

  it('refuses a job requirement the assigned tech lacks, naming the gap', async () => {
    await visit('job-1', 'tech-1');
    await expect(
      assertJobSkillEditKeepsAssigneesQualified(deps(), T, 'job-1', ['Gas Certified']),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('gas_certified') });
  });

  it('allows the requirement when the assigned tech holds it, or when it is cleared', async () => {
    skills['tech-1'] = ['gas_certified'];
    await visit('job-1', 'tech-1');
    await expect(assertJobSkillEditKeepsAssigneesQualified(deps(), T, 'job-1', ['gas_certified'])).resolves.toBeUndefined();
    await expect(assertJobSkillEditKeepsAssigneesQualified(deps(), T, 'job-1', [])).resolves.toBeUndefined();
  });

  it('ignores finished or canceled visits', async () => {
    const appt = await visit('job-1', 'tech-1');
    await appointmentRepo.update(T, appt.id, { status: 'completed' });
    await expect(assertJobSkillEditKeepsAssigneesQualified(deps(), T, 'job-1', ['gas_certified'])).resolves.toBeUndefined();
  });

  it('refuses removing a skill a tech still needs for an active visit, allows it otherwise', async () => {
    required['job-1'] = ['gas_certified'];
    await visit('job-1', 'tech-1');
    await expect(
      assertTechnicianSkillEditKeepsVisitsQualified(deps(), T, 'tech-1', ['hvac']),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('gas_certified') });
    await expect(
      assertTechnicianSkillEditKeepsVisitsQualified(deps(), T, 'tech-1', ['hvac', 'gas_certified']),
    ).resolves.toBeUndefined();
    await expect(assertTechnicianSkillEditKeepsVisitsQualified(deps(), T, 'tech-2', [])).resolves.toBeUndefined();
  });
});
