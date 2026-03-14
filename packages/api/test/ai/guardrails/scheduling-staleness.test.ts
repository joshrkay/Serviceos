import { describe, it, expect } from 'vitest';
import { checkSchedulingProposalFreshness, isSchedulingProposalType } from '../../../src/ai/guardrails/scheduling-staleness';
import { Proposal } from '../../../src/proposals/proposal';
import { Appointment } from '../../../src/appointments/appointment';

describe('P6-023 — Stale scheduling proposal invalidation', () => {
  const baseAppointment: Appointment = {
    id: 'appt-1',
    tenantId: 'tenant-1',
    jobId: 'job-1',
    scheduledStart: new Date('2026-03-14T09:00:00Z'),
    scheduledEnd: new Date('2026-03-14T11:00:00Z'),
    timezone: 'America/New_York',
    status: 'scheduled',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function makeProposal(sourceContext?: Record<string, unknown>): Proposal {
    return {
      id: 'prop-1',
      tenantId: 'tenant-1',
      proposalType: 'reschedule_appointment',
      status: 'approved',
      payload: { appointmentId: 'appt-1' },
      summary: 'Reschedule',
      sourceContext,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it('considers proposal fresh when no source context', () => {
    const result = checkSchedulingProposalFreshness(
      makeProposal(undefined),
      baseAppointment,
    );
    expect(result.fresh).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('considers proposal fresh when context matches', () => {
    const result = checkSchedulingProposalFreshness(
      makeProposal({
        status: 'scheduled',
        scheduledStart: '2026-03-14T09:00:00.000Z',
        scheduledEnd: '2026-03-14T11:00:00.000Z',
      }),
      baseAppointment,
    );
    expect(result.fresh).toBe(true);
  });

  it('detects stale when status changed', () => {
    const result = checkSchedulingProposalFreshness(
      makeProposal({ status: 'scheduled' }),
      { ...baseAppointment, status: 'confirmed' },
    );
    expect(result.fresh).toBe(false);
    expect(result.reasons).toContain(
      "Appointment status changed from 'scheduled' to 'confirmed'"
    );
  });

  it('detects stale when scheduledStart changed', () => {
    const result = checkSchedulingProposalFreshness(
      makeProposal({
        scheduledStart: '2026-03-14T09:00:00.000Z',
      }),
      { ...baseAppointment, scheduledStart: new Date('2026-03-14T10:00:00Z') },
    );
    expect(result.fresh).toBe(false);
    expect(result.reasons).toContain('Appointment scheduledStart has changed');
  });

  it('detects stale when scheduledEnd changed', () => {
    const result = checkSchedulingProposalFreshness(
      makeProposal({
        scheduledEnd: '2026-03-14T11:00:00.000Z',
      }),
      { ...baseAppointment, scheduledEnd: new Date('2026-03-14T12:00:00Z') },
    );
    expect(result.fresh).toBe(false);
    expect(result.reasons).toContain('Appointment scheduledEnd has changed');
  });

  it('reports multiple stale reasons', () => {
    const result = checkSchedulingProposalFreshness(
      makeProposal({
        status: 'scheduled',
        scheduledStart: '2026-03-14T09:00:00.000Z',
      }),
      {
        ...baseAppointment,
        status: 'in_progress',
        scheduledStart: new Date('2026-03-14T10:00:00Z'),
      },
    );
    expect(result.fresh).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });

  it('identifies scheduling proposal types', () => {
    expect(isSchedulingProposalType('reassign_appointment')).toBe(true);
    expect(isSchedulingProposalType('reschedule_appointment')).toBe(true);
    expect(isSchedulingProposalType('cancel_appointment')).toBe(true);
    expect(isSchedulingProposalType('create_customer')).toBe(false);
    expect(isSchedulingProposalType('draft_invoice')).toBe(false);
  });

  it('is idempotent — same inputs produce same result', () => {
    const proposal = makeProposal({ status: 'scheduled' });
    const result1 = checkSchedulingProposalFreshness(proposal, baseAppointment);
    const result2 = checkSchedulingProposalFreshness(proposal, baseAppointment);
    expect(result1).toEqual(result2);
  });
});
