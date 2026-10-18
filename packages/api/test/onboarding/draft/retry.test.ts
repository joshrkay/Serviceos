import { describe, it, expect, beforeEach, vi } from 'vitest';
import { approveDraft } from '../../../src/onboarding/draft/approve';
import { retryFailedDraftProposals } from '../../../src/onboarding/draft/retry';
import { InMemoryOnboardingDraftRepository } from '../../../src/onboarding/draft/repository';
import { InMemoryProposalRepository, type Proposal, type ProposalStatus } from '../../../src/proposals/proposal';
import { isInUndoWindow } from '../../../src/proposals/lifecycle';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { assembleTypicalShop } from '../../../src/onboarding/choices/assemble';
import { InMemoryRegionalPriceTierRepository } from '../../../src/onboarding/choices/price-tiers';
import { ConflictError, NotFoundError } from '../../../src/shared/errors';

const TENANT = '00000000-0000-0000-0000-00000000e0a1';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };
const OWNER = { userId: 'user-owner-1', role: 'owner' as const };

describe('retryFailedDraftProposals', () => {
  let draftRepo: InMemoryOnboardingDraftRepository;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let ids: string[];

  async function createDraft(): Promise<void> {
    const assembled = await assembleTypicalShop(new InMemoryRegionalPriceTierRepository({ 'plumbing|CLE': CLE }), {
      packId: 'plumbing',
      businessName: 'Walsh Plumbing',
      ownerFirstName: 'Jenna',
      metro: { kind: 'metro', metroCode: 'CLE', name: 'Cleveland' },
    });
    await draftRepo.create(TENANT, {
      packId: 'plumbing',
      trade: 'plumbing',
      metroCode: 'CLE',
      metroName: 'Cleveland',
      businessName: 'Walsh Plumbing',
      ownerFirstName: 'Jenna',
      clientTimezone: 'America/New_York',
      assembled,
    });
  }

  /** Force a proposal into a status the way the worker / sweeper would have left it. */
  async function force(id: string, status: ProposalStatus, extra: Partial<Proposal> = {}): Promise<void> {
    await proposalRepo.update(TENANT, id, {
      status,
      ...(status === 'execution_failed'
        ? {
            approvedAt: new Date(Date.now() - 3_600_000),
            executionError: 'handler exploded',
            claimedBy: 'worker-1',
            claimedAt: new Date(Date.now() - 3_600_000),
            executionRetryCount: 3,
          }
        : {}),
      ...extra,
    });
  }

  const deps = () => ({ draftRepo, proposalRepo, auditRepo });
  const retry = () => retryFailedDraftProposals(deps(), TENANT, OWNER);
  const events = async (type: string) => (await auditRepo.findRecentByTenant(TENANT, { limit: 100 })).filter((e) => e.eventType === type);

  beforeEach(async () => {
    draftRepo = new InMemoryOnboardingDraftRepository();
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    await createDraft();
    const approved = await approveDraft(deps(), TENANT, OWNER);
    ids = [...approved.proposalIds].sort();
  });

  it('retries only the failed proposal: fresh undo window, stale state cleared, approver re-stamped, the other untouched', async () => {
    const [a, b] = ids;
    await force(a, 'execution_failed', { executedBy: 'someone-else', executedByRole: 'dispatcher' });
    await force(b, 'executed', { executedAt: new Date() });
    const beforeB = await proposalRepo.findById(TENANT, b);
    const draftBefore = await draftRepo.getForTenant(TENANT);
    const staleApprovedAt = (await proposalRepo.findById(TENANT, a))!.approvedAt!;

    const result = await retry();

    expect(result.retriedProposalIds).toEqual([a]);
    const afterA = (await proposalRepo.findById(TENANT, a))!;
    expect(afterA.status).toBe('approved');
    expect(afterA.approvedAt!.getTime()).toBeGreaterThan(staleApprovedAt.getTime());
    expect(isInUndoWindow(afterA)).toBe(true);
    expect(afterA.executionError).toBeUndefined();
    expect(afterA.claimedBy).toBeUndefined();
    expect(afterA.executionRetryCount).toBe(0);
    expect(afterA.executedBy).toBe(OWNER.userId);
    expect(afterA.executedByRole).toBe('owner');
    expect(await proposalRepo.findById(TENANT, b)).toEqual(beforeB);
    // The draft is frozen once approved: retry does not write it.
    expect(result.draft).toEqual(draftBefore);
    expect(await draftRepo.getForTenant(TENANT)).toEqual(draftBefore);

    const retried = await events('proposal.retried');
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ entityType: 'proposal', entityId: a, actorId: OWNER.userId });
    expect(retried[0].metadata).toMatchObject({ draftId: draftBefore!.id, proposalType: afterA.proposalType, previousExecutionError: 'handler exploded' });
    const drafted = await events('onboarding.draft_retry');
    expect(drafted).toHaveLength(1);
    expect(drafted[0]).toMatchObject({ entityType: 'onboarding_draft', entityId: draftBefore!.id });
    expect(drafted[0].metadata).toMatchObject({ proposalIds: [a], draftVersion: draftBefore!.version });
    // approveProposal wrote its own second approval for the retried proposal only.
    const approvals = (await events('proposal.approved')).filter((e) => e.entityId === a);
    expect(approvals).toHaveLength(2);
  });

  it('retries both when both failed', async () => {
    for (const id of ids) await force(id, 'execution_failed');
    const result = await retry();
    expect(result.retriedProposalIds.sort()).toEqual(ids);
    for (const id of ids) expect((await proposalRepo.findById(TENANT, id))?.status).toBe('approved');
    expect(await events('proposal.retried')).toHaveLength(2);
    expect(await events('onboarding.draft_retry')).toHaveLength(1);
  });

  it('truncates a long previous error in the audit row', async () => {
    await force(ids[0], 'execution_failed', { executionError: 'x'.repeat(2000) });
    await retry();
    const [e] = await events('proposal.retried');
    expect((e.metadata as { previousExecutionError: string }).previousExecutionError).toHaveLength(500);
  });

  it.each([
    [['approved', 'executing']],
    [['executed', 'executed']],
    [['undone', 'approved']],
    [['undone', 'executed']],
  ] as const)('nothing execution_failed (%j) is a 409 DRAFT_RETRY_NOTHING_FAILED with the statuses, and writes nothing', async (statuses) => {
    await force(ids[0], statuses[0]);
    await force(ids[1], statuses[1]);
    const snapshot = await Promise.all(ids.map((id) => proposalRepo.findById(TENANT, id)));
    const auditBefore = (await auditRepo.findRecentByTenant(TENANT, { limit: 100 })).length;

    const err = await retry().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain('DRAFT_RETRY_NOTHING_FAILED');
    expect((err as ConflictError).details).toMatchObject({ statuses: expect.arrayContaining([statuses[0], statuses[1]]) });
    expect(await Promise.all(ids.map((id) => proposalRepo.findById(TENANT, id)))).toEqual(snapshot);
    expect((await auditRepo.findRecentByTenant(TENANT, { limit: 100 })).length).toBe(auditBefore);
  });

  it('a draft that is not approved yet is DRAFT_NOT_APPROVED', async () => {
    const fresh = new InMemoryOnboardingDraftRepository();
    draftRepo = fresh;
    await createDraft();
    const err = await retry().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain('DRAFT_NOT_APPROVED');
  });

  it('no draft at all is a NotFoundError', async () => {
    draftRepo = new InMemoryOnboardingDraftRepository();
    await expect(retry()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a re-approval the reference checks refuse is DRAFT_RETRY_FAILED', async () => {
    await force(ids[0], 'execution_failed');
    const err = await retryFailedDraftProposals(
      { ...deps(), approvalOptions: { referenceChecks: [async () => ['somethingDangling']] } },
      TENANT,
      OWNER,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain('DRAFT_RETRY_FAILED');
    expect(await events('proposal.retried')).toHaveLength(0);
    expect(await events('onboarding.draft_retry')).toHaveLength(0);
  });

  it('locks the draft row before it reads any proposal', async () => {
    await force(ids[0], 'execution_failed');
    const order: string[] = [];
    const lock = vi.spyOn(draftRepo, 'getForTenantForUpdate').mockImplementation(async (t) => {
      order.push('lock');
      return InMemoryOnboardingDraftRepository.prototype.getForTenantForUpdate.call(draftRepo, t);
    });
    const find = proposalRepo.findById.bind(proposalRepo);
    vi.spyOn(proposalRepo, 'findById').mockImplementation(async (t, id) => {
      order.push('proposal');
      return find(t, id);
    });
    await retry();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('lock');
    expect(order).toContain('proposal');
  });
});
