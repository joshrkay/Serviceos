/**
 * U6 — crew add/remove voice on-ramp (task-handler level).
 *
 * The execution handlers for add_crew_member / remove_crew_member already
 * exist; this proves the FRONT half: the classifier's ExtractedEntities
 * (a technician name + an appointment reference, never UUIDs) become a typed
 * proposal that always flags appointmentId + technicianId as missing so the
 * review UI resolves both names before the mutation can run — the same
 * contract as reassign_appointment.
 */
import { describe, it, expect } from 'vitest';
import {
  AddCrewMemberTaskHandler,
  RemoveCrewMemberTaskHandler,
} from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import {
  AddCrewMemberExecutionHandler,
  RemoveCrewMemberExecutionHandler,
} from '../../../src/proposals/execution/crew-handler';
import { InMemoryAssignmentRepository } from '../../../src/appointments/assignment';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'test transcript', ...overrides };
}

describe('AddCrewMemberTaskHandler', () => {
  it('maps appointment + technician references and always flags both ids missing', async () => {
    const res = await new AddCrewMemberTaskHandler().handle(
      ctx({
        existingEntities: {
          appointmentReference: 'the Garcia appointment',
          targetTechnicianName: 'Carlos',
        },
      }),
    );
    expect(res.proposal.proposalType).toBe('add_crew_member');
    expect(res.proposal.payload.appointmentReference).toBe('the Garcia appointment');
    expect(res.proposal.payload.targetTechnicianName).toBe('Carlos');
    // Names must resolve to ids before the mutation runs — never auto-approve.
    expect(missingFieldsFor(res.proposal)).toContain('appointmentId');
    expect(missingFieldsFor(res.proposal)).toContain('technicianId');
    expect(res.proposal.status).toBe('draft');
  });

  it('still flags both ids missing when the classifier extracted nothing', async () => {
    const res = await new AddCrewMemberTaskHandler().handle(ctx({ existingEntities: {} }));
    expect(missingFieldsFor(res.proposal)).toEqual(
      expect.arrayContaining(['appointmentId', 'technicianId']),
    );
  });
});

describe('RemoveCrewMemberTaskHandler', () => {
  it('maps references and flags both ids missing', async () => {
    const res = await new RemoveCrewMemberTaskHandler().handle(
      ctx({
        existingEntities: {
          appointmentReference: "Tuesday's job",
          targetTechnicianName: 'Carlos',
        },
      }),
    );
    expect(res.proposal.proposalType).toBe('remove_crew_member');
    expect(res.proposal.payload.targetTechnicianName).toBe('Carlos');
    expect(missingFieldsFor(res.proposal)).toContain('appointmentId');
    expect(missingFieldsFor(res.proposal)).toContain('technicianId');
  });
});

// U1 — the router's technician resolver annotates a verified UUID onto the
// task context (existingEntities.technicianId). The handlers consume it: the
// payload carries the id and technicianId is NOT flagged missing (the
// appointment still is — resolution for it stays a review-time step).
describe('U1: crew handlers consume the resolved technician id', () => {
  const TECH_ID = '33333333-3333-3333-3333-333333333333';

  it('add_crew_member: resolved id lands on the payload, only appointmentId stays missing', async () => {
    const res = await new AddCrewMemberTaskHandler().handle(
      ctx({
        existingEntities: {
          appointmentReference: 'the Garcia appointment',
          targetTechnicianName: 'Carlos',
          technicianId: TECH_ID,
        },
      }),
    );
    expect(res.proposal.payload.technicianId).toBe(TECH_ID);
    expect(res.proposal.payload.targetTechnicianName).toBe('Carlos');
    expect(missingFieldsFor(res.proposal)).toEqual(['appointmentId']);
    expect(res.proposal.status).toBe('draft');
  });

  it('remove_crew_member: resolved id lands on the payload, only appointmentId stays missing', async () => {
    const res = await new RemoveCrewMemberTaskHandler().handle(
      ctx({
        existingEntities: {
          appointmentReference: "Tuesday's job",
          targetTechnicianName: 'Carlos',
          technicianId: TECH_ID,
        },
      }),
    );
    expect(res.proposal.payload.technicianId).toBe(TECH_ID);
    expect(missingFieldsFor(res.proposal)).toEqual(['appointmentId']);
  });
});

// U2 (B7.10) — add_crew_member/remove_crew_member joined APPOINTMENT_REF_INTENTS,
// so the router's appointment resolver now resolves "the 2pm tomorrow" and a
// unique verified match rides existingEntities.appointmentId (the SAME B5.3
// seam reassign consumes). The handlers lift the gate only on that seam; an
// unresolved (or non-UUID) reference keeps the review-time gate. P-44: the
// fully-resolved cases are proven by EXECUTED EFFECTS — the real crew
// execution handlers mutate the assignment repo and emit audit events.
describe('U2: crew handlers consume the resolved appointment id (resolve-then-gate)', () => {
  const TECH_ID = '33333333-3333-4333-8333-333333333333';
  const APPT_ID = '44444444-4444-4444-8444-444444444444';

  it('add_crew_member: both seams resolved → ungated draft; execution CREATES the non-primary assignment + audit event', async () => {
    const res = await new AddCrewMemberTaskHandler().handle(
      ctx({
        existingEntities: {
          appointmentReference: 'the 2pm tomorrow',
          targetTechnicianName: 'Jake',
          appointmentId: APPT_ID,
          technicianId: TECH_ID,
        },
      }),
    );
    expect(res.proposal.payload.appointmentId).toBe(APPT_ID);
    expect(res.proposal.payload.technicianId).toBe(TECH_ID);
    // Spoken references preserved for the review card's display.
    expect(res.proposal.payload.appointmentReference).toBe('the 2pm tomorrow');
    expect(missingFieldsFor(res.proposal)).toEqual([]);
    // Capture-class with no trust tier — still drafts for a human tap.
    expect(res.proposal.status).toBe('draft');

    // Executed effect — the REAL execution handler writes the crew row.
    const assignmentRepo = new InMemoryAssignmentRepository();
    const auditRepo = new InMemoryAuditRepository();
    const exec = await new AddCrewMemberExecutionHandler(
      undefined,
      assignmentRepo,
      undefined,
      undefined,
      auditRepo,
    ).execute(res.proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(exec.success).toBe(true);

    const rows = await assignmentRepo.findByAppointment('t-1', APPT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].technicianId).toBe(TECH_ID);
    expect(rows[0].isPrimary).toBe(false); // crew never demotes the primary

    const audits = await auditRepo.findByEntity('t-1', 'appointment', APPT_ID);
    expect(audits.map((a) => a.eventType)).toContain('appointment.technician_assigned');
  });

  it('remove_crew_member: both seams resolved → ungated draft; execution REMOVES the crew row + audit event', async () => {
    const assignmentRepo = new InMemoryAssignmentRepository();
    await assignmentRepo.create({
      id: 'assign-1',
      tenantId: 't-1',
      appointmentId: APPT_ID,
      technicianId: TECH_ID,
      isPrimary: false,
      assignedBy: 'u-1',
      assignedAt: new Date(),
    });

    const res = await new RemoveCrewMemberTaskHandler().handle(
      ctx({
        existingEntities: {
          appointmentReference: 'the 2pm tomorrow',
          targetTechnicianName: 'Jake',
          appointmentId: APPT_ID,
          technicianId: TECH_ID,
        },
      }),
    );
    expect(res.proposal.payload.appointmentId).toBe(APPT_ID);
    expect(missingFieldsFor(res.proposal)).toEqual([]);
    expect(res.proposal.status).toBe('draft');

    const auditRepo = new InMemoryAuditRepository();
    const exec = await new RemoveCrewMemberExecutionHandler(
      undefined,
      assignmentRepo,
      undefined,
      auditRepo,
    ).execute(res.proposal, { tenantId: 't-1', executedBy: 'u-1' });
    expect(exec.success).toBe(true);

    expect(await assignmentRepo.findByAppointment('t-1', APPT_ID)).toHaveLength(0);
    const audits = await auditRepo.findByEntity('t-1', 'appointment', APPT_ID);
    expect(audits.map((a) => a.eventType)).toContain('appointment.technician_unassigned');
  });

  it('a non-UUID value in the appointmentId seam never lifts the gate (shape check, no silent guess)', async () => {
    const res = await new AddCrewMemberTaskHandler().handle(
      ctx({
        existingEntities: {
          appointmentReference: 'the 2pm tomorrow',
          appointmentId: 'the 2pm tomorrow',
          technicianId: TECH_ID,
        },
      }),
    );
    expect(res.proposal.payload.appointmentId).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).toEqual(['appointmentId']);
  });

  it('appointment resolved but technician name unresolvable → technicianId still gated', async () => {
    const res = await new AddCrewMemberTaskHandler().handle(
      ctx({
        existingEntities: {
          appointmentReference: 'the 2pm tomorrow',
          targetTechnicianName: 'Jakeee',
          appointmentId: APPT_ID,
        },
      }),
    );
    expect(res.proposal.payload.appointmentId).toBe(APPT_ID);
    expect(missingFieldsFor(res.proposal)).toEqual(['technicianId']);
  });
});
