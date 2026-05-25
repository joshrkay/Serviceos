import { describe, it, expect } from 'vitest';
import { resolvePendingChangeRequests } from '../../src/dispatch/pending-changes';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';

const tenantId = '550e8400-e29b-41d4-a716-446655440000';

describe('resolvePendingChangeRequests', () => {
  it('maps open cancel/reschedule proposals to their appointment', async () => {
    const repo = new InMemoryProposalRepository();
    await repo.create(createProposal({
      tenantId, proposalType: 'cancel_appointment',
      payload: { appointmentId: 'appt-cancel', reason: 'x', cancellationType: 'customer_request' },
      summary: 'cancel', createdBy: 'portal',
    }));
    await repo.create(createProposal({
      tenantId, proposalType: 'reschedule_appointment',
      payload: { appointmentId: 'appt-resched', newScheduledStart: 'a', newScheduledEnd: 'b' },
      summary: 'reschedule', createdBy: 'portal',
    }));

    const map = await resolvePendingChangeRequests(repo, tenantId, ['appt-cancel', 'appt-resched', 'appt-none']);
    expect(map.get('appt-cancel')).toBe('cancel');
    expect(map.get('appt-resched')).toBe('reschedule');
    expect(map.has('appt-none')).toBe(false);
  });

  it('ignores appointments outside the requested set', async () => {
    const repo = new InMemoryProposalRepository();
    await repo.create(createProposal({
      tenantId, proposalType: 'cancel_appointment',
      payload: { appointmentId: 'other', reason: 'x', cancellationType: 'customer_request' },
      summary: 'cancel', createdBy: 'portal',
    }));
    const map = await resolvePendingChangeRequests(repo, tenantId, ['appt-1']);
    expect(map.size).toBe(0);
  });

  it('returns empty for no appointment ids', async () => {
    const repo = new InMemoryProposalRepository();
    const map = await resolvePendingChangeRequests(repo, tenantId, []);
    expect(map.size).toBe(0);
  });

  it('prefers cancel over reschedule when both target one appointment', async () => {
    const repo = new InMemoryProposalRepository();
    await repo.create(createProposal({
      tenantId, proposalType: 'reschedule_appointment',
      payload: { appointmentId: 'appt-1', newScheduledStart: 'a', newScheduledEnd: 'b' },
      summary: 'reschedule', createdBy: 'portal',
    }));
    await repo.create(createProposal({
      tenantId, proposalType: 'cancel_appointment',
      payload: { appointmentId: 'appt-1', reason: 'x', cancellationType: 'customer_request' },
      summary: 'cancel', createdBy: 'portal',
    }));
    const map = await resolvePendingChangeRequests(repo, tenantId, ['appt-1']);
    expect(map.get('appt-1')).toBe('cancel');
  });
});
