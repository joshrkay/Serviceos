/**
 * The retry path for a failed execution (U9x): the lifecycle edges it relies on
 * are pinned so a lifecycle change breaks the build instead of silently breaking
 * retry, and `resetFailedForRetry` is proven to give the re-approval a FRESH undo
 * window (transitionProposal keeps an existing approvedAt, so a stale one would
 * hand the worker a proposal whose window is already closed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { canTransition, isInUndoWindow } from '../../src/proposals/lifecycle';
import { createProposal, InMemoryProposalRepository, type Proposal, type ProposalStatus } from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = 'tenant-retry-1';

describe('lifecycle edges that retry depends on', () => {
  it('execution_failed can go back to draft and a draft can be approved', () => {
    expect(canTransition('execution_failed', 'draft')).toBe(true);
    expect(canTransition('draft', 'approved')).toBe(true);
  });

  it('undone cannot be resurrected, which is why retry cannot repair it', () => {
    expect(canTransition('undone', 'draft')).toBe(false);
    expect(canTransition('undone', 'approved')).toBe(false);
  });
});

describe('InMemoryProposalRepository.resetFailedForRetry', () => {
  let repo: InMemoryProposalRepository;

  async function seed(status: ProposalStatus, tenantId = TENANT): Promise<Proposal> {
    const p = await repo.create(
      createProposal({
        tenantId,
        proposalType: 'onboarding_tenant_settings',
        payload: {},
        summary: 'x',
        createdBy: 'user-1',
      }),
    );
    const updated = await repo.update(tenantId, p.id, {
      status,
      approvedAt: new Date(Date.now() - 3_600_000),
      executionError: 'boom',
      claimedBy: 'worker-1',
      claimedAt: new Date(Date.now() - 3_600_000),
      executionRetryCount: 3,
    });
    return updated!;
  }

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
  });

  it('moves an execution_failed row to draft and clears the stale attempt state', async () => {
    const failed = await seed('execution_failed');
    const reset = await repo.resetFailedForRetry(TENANT, failed.id);
    expect(reset?.status).toBe('draft');
    expect(reset?.approvedAt).toBeUndefined();
    expect(reset?.executionError).toBeUndefined();
    expect(reset?.claimedBy).toBeUndefined();
    expect(reset?.claimedAt).toBeUndefined();
    expect(reset?.executionRetryCount).toBe(0);
    expect((await repo.findById(TENANT, failed.id))?.status).toBe('draft');
  });

  it.each(['approved', 'executing', 'executed', 'undone', 'draft'] as const)('returns null and writes nothing for a %s row', async (status) => {
    const row = await seed(status);
    expect(await repo.resetFailedForRetry(TENANT, row.id)).toBeNull();
    const after = await repo.findById(TENANT, row.id);
    expect(after?.status).toBe(status);
    expect(after?.executionError).toBe('boom');
    expect(after?.executionRetryCount).toBe(3);
  });

  it('returns null for an unknown id and for another tenant', async () => {
    const failed = await seed('execution_failed');
    expect(await repo.resetFailedForRetry(TENANT, 'no-such-id')).toBeNull();
    expect(await repo.resetFailedForRetry('other-tenant', failed.id)).toBeNull();
    expect((await repo.findById(TENANT, failed.id))?.status).toBe('execution_failed');
  });

  it('re-approval opens a fresh undo window instead of reusing the closed one', async () => {
    const failed = await seed('execution_failed');
    const oldApprovedAt = failed.approvedAt!;
    expect(isInUndoWindow({ ...failed, status: 'approved' })).toBe(false);

    await repo.resetFailedForRetry(TENANT, failed.id);
    const reapproved = await approveProposal(repo, TENANT, failed.id, 'user-owner', 'owner', new InMemoryAuditRepository(), 'ui');

    expect(reapproved.status).toBe('approved');
    expect(reapproved.approvedAt!.getTime()).toBeGreaterThan(oldApprovedAt.getTime());
    expect(isInUndoWindow(reapproved)).toBe(true);
  });
});
