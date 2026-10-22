import { describe, it, expect } from 'vitest';
import { createProposal, InMemoryProposalRepository } from '../../src/proposals/proposal';
import { editProposal } from '../../src/proposals/actions';

/**
 * Dispatch FR-2 phase 3c — the overlap consent on a reassign proposal
 * (acceptOverlap + acceptedOverlapAppointmentIds) is written by the server
 * at creation from the dispatch board's explicit "Book anyway". The edit
 * path merges arbitrary fields into the payload, so it must neither accept
 * those fields from a caller nor carry them onto a retargeted booking.
 */
const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const APPT = '660e8400-e29b-41d4-a716-446655440001';
const TECH_A = '770e8400-e29b-41d4-a716-446655440002';
const TECH_B = '880e8400-e29b-41d4-a716-446655440003';
const BUSY = '990e8400-e29b-41d4-a716-446655440004';

async function seed(payload: Record<string, unknown>) {
  const repo = new InMemoryProposalRepository();
  const proposal = createProposal({
    tenantId: TENANT, proposalType: 'reassign_appointment', payload, summary: 'reassign', createdBy: 'user-1',
  });
  await repo.create(proposal);
  return { repo, proposal };
}

describe('editProposal — overlap consent cannot be forged or carried over', () => {
  it('drops acceptOverlap / acceptedOverlapAppointmentIds from the edits', async () => {
    const { repo, proposal } = await seed({ appointmentId: APPT, toTechnicianId: TECH_A });
    const { proposal: edited, editedFields } = await editProposal(repo, TENANT, proposal.id, 'user-1', 'owner', {
      reason: 'please', acceptOverlap: true, acceptedOverlapAppointmentIds: [BUSY],
    });
    expect(edited.payload).toEqual({ appointmentId: APPT, toTechnicianId: TECH_A, reason: 'please' });
    expect(editedFields).toEqual(['reason']);
  });

  it('keeps a server-pinned consent across an edit that does not retarget', async () => {
    const { repo, proposal } = await seed({
      appointmentId: APPT, toTechnicianId: TECH_A, acceptOverlap: true, acceptedOverlapAppointmentIds: [BUSY],
    });
    const { proposal: edited } = await editProposal(repo, TENANT, proposal.id, 'user-1', 'owner', { reason: 'note' });
    expect(edited.payload).toMatchObject({ acceptOverlap: true, acceptedOverlapAppointmentIds: [BUSY], reason: 'note' });
  });

  it('drops the consent when the edit moves the booking to another technician', async () => {
    const { repo, proposal } = await seed({
      appointmentId: APPT, toTechnicianId: TECH_A, acceptOverlap: true, acceptedOverlapAppointmentIds: [BUSY],
    });
    const { proposal: edited } = await editProposal(repo, TENANT, proposal.id, 'user-1', 'owner', { toTechnicianId: TECH_B });
    expect(edited.payload).toEqual({ appointmentId: APPT, toTechnicianId: TECH_B });
  });
});
