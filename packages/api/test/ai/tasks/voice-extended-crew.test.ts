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
