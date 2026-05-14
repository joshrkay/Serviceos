import { describe, it, expect, beforeEach } from 'vitest';
import { rejectProposal } from '../../src/proposals/actions';
import { createProposal } from '../../src/proposals/proposal';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { createAppointment } from '../../src/appointments/appointment';

const tenantA = '00000000-0000-4000-8000-00000000000a';

async function heldAppointment(repo: InMemoryAppointmentRepository) {
  return createAppointment(
    {
      tenantId: tenantA,
      jobId: '00000000-0000-4000-8000-0000000000j1',
      scheduledStart: new Date('2026-06-01T17:00:00Z'),
      scheduledEnd: new Date('2026-06-01T18:00:00Z'),
      timezone: 'UTC',
      createdBy: 'agent-1',
      holdPendingApproval: true,
      holdExpiryAt: new Date('2099-01-01T00:00:00Z'),
    },
    repo,
  );
}

describe('rejectProposal releases held slots', () => {
  let proposalRepo: InMemoryProposalRepository;
  let appointmentRepo: InMemoryAppointmentRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
  });

  it('cancels the held appointment when a create_booking proposal is rejected', async () => {
    const appt = await heldAppointment(appointmentRepo);
    const proposal = await proposalRepo.create(
      createProposal({
        tenantId: tenantA,
        proposalType: 'create_booking',
        payload: { appointmentId: appt.id },
        summary: 'Book the held slot',
        createdBy: 'agent-1',
      }),
    );
    // Advance to ready_for_review so the lifecycle permits rejection.
    // This matches the established test pattern in actions.test.ts.
    await proposalRepo.updateStatus(tenantA, proposal.id, 'ready_for_review');

    await rejectProposal(
      proposalRepo,
      tenantA,
      proposal.id,
      'owner-1',
      'owner',
      'changed_mind',
      undefined,
      appointmentRepo,
    );

    const released = await appointmentRepo.findById(tenantA, appt.id);
    expect(released?.status).toBe('canceled');
    expect(released?.holdPendingApproval).toBe(false);
  });

  it('leaves appointments untouched when a non-booking proposal is rejected', async () => {
    const appt = await heldAppointment(appointmentRepo);
    const proposal = await proposalRepo.create(
      createProposal({
        tenantId: tenantA,
        proposalType: 'add_note',
        payload: { entityType: 'job', entityId: 'job-1', body: 'note' },
        summary: 'Add a note',
        createdBy: 'agent-1',
      }),
    );
    // Advance to ready_for_review so the lifecycle permits rejection.
    await proposalRepo.updateStatus(tenantA, proposal.id, 'ready_for_review');

    await rejectProposal(
      proposalRepo,
      tenantA,
      proposal.id,
      'owner-1',
      'owner',
      'not_needed',
      undefined,
      appointmentRepo,
    );

    const untouched = await appointmentRepo.findById(tenantA, appt.id);
    expect(untouched?.status).toBe('scheduled');
  });

  it('does not throw when a create_booking proposal is rejected without an appointmentRepo', async () => {
    const appt = await heldAppointment(appointmentRepo);
    const proposal = await proposalRepo.create(
      createProposal({
        tenantId: tenantA,
        proposalType: 'create_booking',
        payload: { appointmentId: appt.id },
        summary: 'Book the held slot',
        createdBy: 'agent-1',
      }),
    );
    await proposalRepo.updateStatus(tenantA, proposal.id, 'ready_for_review');

    await expect(
      rejectProposal(proposalRepo, tenantA, proposal.id, 'owner-1', 'owner', 'changed_mind'),
    ).resolves.toBeDefined();

    // Best-effort: with no appointmentRepo, the appointment is left as-is.
    const untouched = await appointmentRepo.findById(tenantA, appt.id);
    expect(untouched?.status).toBe('scheduled');
  });
});
