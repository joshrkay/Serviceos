import { describe, it, expect, beforeEach } from 'vitest';
import { createLogger } from '../../src/logging/logger';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  createProposal,
  InMemoryProposalRepository,
  CreateProposalInput,
  ProposalType,
} from '../../src/proposals/proposal';
import {
  runProposalExpirySweep,
  isProposalExpired,
  ProposalExpiryWorkerDeps,
} from '../../src/workers/proposal-expiry-worker';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-05-14T12:00:00Z');
const PAST = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h ago
const FUTURE = new Date(NOW.getTime() + 60 * 60 * 1000); // 1h ahead

describe('runProposalExpirySweep (§5.5 + §10.4)', () => {
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  function deps(overrides: Partial<ProposalExpiryWorkerDeps> = {}): ProposalExpiryWorkerDeps {
    return {
      proposalRepo,
      auditRepo,
      listTenantIds: async () => ['t1'],
      logger,
      now: () => NOW,
      ...overrides,
    };
  }

  async function seed(
    type: ProposalType,
    opts: { expiresAt?: Date; status?: 'draft' | 'ready_for_review' | 'approved' } = {},
  ) {
    const p = createProposal({
      tenantId: 't1',
      proposalType: type,
      payload: {},
      summary: 's',
      createdBy: 'u1',
      expiresAt: opts.expiresAt,
    } as CreateProposalInput);
    await proposalRepo.create(p);
    if (opts.status && opts.status !== p.status) {
      await proposalRepo.updateStatus('t1', p.id, opts.status);
    }
    return p;
  }

  it('expires a stale schedule proposal and emits an audit event', async () => {
    const p = await seed('create_appointment', { expiresAt: PAST });
    const res = await runProposalExpirySweep(deps());
    expect(res.expired).toBe(1);
    expect((await proposalRepo.findById('t1', p.id))?.status).toBe('expired');
    const events = await auditRepo.findByEntity('t1', 'proposal', p.id);
    expect(events.some((e) => e.eventType === 'proposal.expired')).toBe(true);
  });

  it('expires a ready_for_review schedule proposal too', async () => {
    const p = await seed('create_booking', { expiresAt: PAST, status: 'ready_for_review' });
    const res = await runProposalExpirySweep(deps());
    expect(res.expired).toBe(1);
    expect((await proposalRepo.findById('t1', p.id))?.status).toBe('expired');
  });

  it('expires a stale message proposal too (§10.4) and emits an audit event', async () => {
    // notify_delay is comms-class → a message proposal that lapses after 48h.
    const p = await seed('notify_delay', { expiresAt: PAST });
    const res = await runProposalExpirySweep(deps());
    expect(res.expired).toBe(1);
    expect((await proposalRepo.findById('t1', p.id))?.status).toBe('expired');
    const events = await auditRepo.findByEntity('t1', 'proposal', p.id);
    expect(events.some((e) => e.eventType === 'proposal.expired')).toBe(true);
  });

  it('leaves a schedule proposal whose 48h window is still open', async () => {
    const p = await seed('reschedule_appointment', { expiresAt: FUTURE });
    const res = await runProposalExpirySweep(deps());
    expect(res.expired).toBe(0);
    expect((await proposalRepo.findById('t1', p.id))?.status).toBe('draft');
  });

  it('never expires a persisting (non-schedule, non-message) proposal — no expiry, lives indefinitely', async () => {
    const p = await seed('draft_estimate');
    expect(p.expiresAt).toBeUndefined();
    const res = await runProposalExpirySweep(deps());
    expect(res.expired).toBe(0);
    expect((await proposalRepo.findById('t1', p.id))?.status).toBe('draft');
  });

  it('does not expire a schedule proposal that has already been decided', async () => {
    const p = await seed('create_appointment', { expiresAt: PAST, status: 'approved' });
    const res = await runProposalExpirySweep(deps());
    expect(res.expired).toBe(0);
    expect((await proposalRepo.findById('t1', p.id))?.status).toBe('approved');
  });

  it('does not expire a proposal approved between the status scan and the write', async () => {
    // Simulate the race: findByStatus returns a stale 'draft' snapshot, but the
    // row was approved before the sweep writes. The re-read guard must skip it.
    const past = new Date(NOW.getTime() - 60 * 60 * 1000);
    const stale = createProposal({
      tenantId: 't1', proposalType: 'create_appointment', payload: {}, summary: 's', createdBy: 'u1', expiresAt: past,
    } as CreateProposalInput);
    const updateCalls: string[] = [];
    const racingRepo = {
      async findByStatus(_t: string, status: string) {
        return status === 'draft' ? [stale] : [];
      },
      // by write-time the operator has approved it
      async findById() {
        return { ...stale, status: 'approved' as const };
      },
      async updateStatus(_t: string, id: string, status: string) {
        updateCalls.push(`${id}:${status}`);
        return null;
      },
    } as unknown as InMemoryProposalRepository;

    const res = await runProposalExpirySweep(deps({ proposalRepo: racingRepo }));
    expect(res.expired).toBe(0);
    expect(updateCalls).toEqual([]); // never clobbered the approval
  });

  it('isProposalExpired only fires for pending proposals past their expiry', () => {
    const stale = createProposal({
      tenantId: 't1', proposalType: 'create_appointment', payload: {}, summary: 's', createdBy: 'u', expiresAt: PAST,
    } as CreateProposalInput);
    expect(isProposalExpired(stale, NOW)).toBe(true);

    const open = createProposal({
      tenantId: 't1', proposalType: 'create_appointment', payload: {}, summary: 's', createdBy: 'u', expiresAt: FUTURE,
    } as CreateProposalInput);
    expect(isProposalExpired(open, NOW)).toBe(false);

    const persistent = createProposal({
      tenantId: 't1', proposalType: 'draft_estimate', payload: {}, summary: 's', createdBy: 'u',
    } as CreateProposalInput);
    expect(isProposalExpired(persistent, NOW)).toBe(false);
  });
});
