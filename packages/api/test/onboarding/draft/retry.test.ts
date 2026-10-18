import { describe, it, expect, beforeEach, vi } from 'vitest';
import { approveDraft } from '../../../src/onboarding/draft/approve';
import { retryFailedDraftProposals } from '../../../src/onboarding/draft/retry';
import {
  DraftNotApprovedError,
  DraftNotFoundError,
  DraftVersionConflictError,
  InMemoryOnboardingDraftRepository,
} from '../../../src/onboarding/draft/repository';
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
  /** The version the owner's read-back was rendered from, i.e. what the approving tab sends as expectedVersion. */
  let preApprovalVersion: number;

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
    preApprovalVersion = (await draftRepo.getForTenant(TENANT))!.version;
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
    // A retry is a new approval attempt: the draft moves on exactly one version,
    // the response carries it, and nothing else about the row changes.
    expect(result.draft.version).toBe(draftBefore!.version + 1);
    expect(result.draft.updatedAt.getTime()).toBeGreaterThanOrEqual(draftBefore!.updatedAt.getTime());
    expect(result.draft).toEqual({ ...draftBefore!, version: draftBefore!.version + 1, updatedAt: result.draft.updatedAt });
    expect(await draftRepo.getForTenant(TENANT)).toEqual(result.draft);

    const retried = await events('proposal.retried');
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ entityType: 'proposal', entityId: a, actorId: OWNER.userId });
    expect(retried[0].metadata).toMatchObject({ draftId: draftBefore!.id, proposalType: afterA.proposalType, previousExecutionError: 'handler exploded' });
    const drafted = await events('onboarding.draft_retry');
    expect(drafted).toHaveLength(1);
    expect(drafted[0]).toMatchObject({ entityType: 'onboarding_draft', entityId: draftBefore!.id });
    expect(drafted[0].metadata).toMatchObject({
      proposalIds: [a],
      draftVersionBefore: draftBefore!.version,
      draftVersionAfter: draftBefore!.version + 1,
    });
    // One name per fact: the old single `draftVersion` was ambiguous once a retry moves it.
    expect(drafted[0].metadata).not.toHaveProperty('draftVersion');
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
    // One retry is one attempt, however many proposals it re-queues.
    expect((await draftRepo.getForTenant(TENANT))!.version).toBe(preApprovalVersion + 2);
  });

  it('every successful retry opens its own attempt: the version moves once per retry and the audit rows chain', async () => {
    await force(ids[0], 'execution_failed');
    const first = await retry();
    await force(ids[0], 'execution_failed');
    const second = await retry();

    expect(first.draft.version).toBe(preApprovalVersion + 2);
    expect(second.draft.version).toBe(preApprovalVersion + 3);
    const chain = (await events('onboarding.draft_retry')).map((e) => e.metadata).sort((x, y) => (x!.draftVersionBefore as number) - (y!.draftVersionBefore as number));
    expect(chain.map((m) => [m!.draftVersionBefore, m!.draftVersionAfter])).toEqual([
      [preApprovalVersion + 1, preApprovalVersion + 2],
      [preApprovalVersion + 2, preApprovalVersion + 3],
    ]);
  });

  it('truncates a long previous error in the audit row', async () => {
    await force(ids[0], 'execution_failed', { executionError: 'x'.repeat(2000) });
    await retry();
    const [e] = await events('proposal.retried');
    expect((e.metadata as { previousExecutionError: string }).previousExecutionError).toHaveLength(500);
  });

  it('retries the failed proposal when the other one is executed or still approved (the pair can complete)', async () => {
    for (const sibling of ['executed', 'approved', 'executing'] as const) {
      // Fresh fixtures per sibling status.
      draftRepo = new InMemoryOnboardingDraftRepository();
      proposalRepo = new InMemoryProposalRepository();
      auditRepo = new InMemoryAuditRepository();
      await createDraft();
      ids = [...(await approveDraft(deps(), TENANT, OWNER)).proposalIds].sort();
      await force(ids[0], 'execution_failed');
      await force(ids[1], sibling);

      const result = await retry();

      expect(result.retriedProposalIds, sibling).toEqual([ids[0]]);
      expect((await proposalRepo.findById(TENANT, ids[0]))?.status, sibling).toBe('approved');
      expect((await proposalRepo.findById(TENANT, ids[1]))?.status, sibling).toBe(sibling);
    }
  });

  it.each([
    [['approved', 'executing']],
    [['executed', 'executed']],
    [['approved', 'approved']],
  ] as const)('nothing execution_failed (%j) is a 409 DRAFT_RETRY_NOTHING_FAILED with the statuses, and writes nothing', async (statuses) => {
    await force(ids[0], statuses[0]);
    await force(ids[1], statuses[1]);
    const snapshot = await Promise.all(ids.map((id) => proposalRepo.findById(TENANT, id)));
    const draftBefore = await draftRepo.getForTenant(TENANT);
    const auditBefore = (await auditRepo.findRecentByTenant(TENANT, { limit: 100 })).length;

    const err = await retry().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain('DRAFT_RETRY_NOTHING_FAILED');
    expect((err as ConflictError).details).toMatchObject({ statuses: expect.arrayContaining([statuses[0], statuses[1]]) });
    expect(await Promise.all(ids.map((id) => proposalRepo.findById(TENANT, id)))).toEqual(snapshot);
    // A refused retry opened no attempt: the draft is untouched.
    expect(await draftRepo.getForTenant(TENANT)).toEqual(draftBefore);
    expect((await auditRepo.findRecentByTenant(TENANT, { limit: 100 })).length).toBe(auditBefore);
  });

  // The defect: re-queueing only the failed half while its sibling can never run
  // would execute that half alone ("executed + undone": half the approved
  // configuration live, recoverable only from Settings). Retry must refuse the
  // whole set instead, and change nothing.
  describe('a sibling in a state retry cannot recover is DRAFT_RETRY_UNSAFE', () => {
    function expectUnsafe(err: unknown, phrase: string): void {
      expect(err).toBeInstanceOf(ConflictError);
      const { message, details } = err as ConflictError;
      expect(message).toContain('DRAFT_RETRY_UNSAFE');
      // Owner-safe wording: says what is wrong in plain words and the way out.
      expect(message).toContain(phrase);
      // Points only at what exists today (the inbox and Settings), never at a reset.
      expect(message).toMatch(/Check your inbox, or finish it from Settings\./);
      expect(message).not.toMatch(/reset/i);
      // Owner vocabulary: no internal terms, no vendor names, no AI jargon.
      expect(message).not.toMatch(/proposal|lifecycle|execution_failed|ready_for_review/i);
      expect(message).not.toMatch(/\b(ai|agents?|dashboard|verify|verification|provisioning|stripe|twilio)\b/i);
      // The raw statuses are in the details, not the sentence.
      expect(details).toMatchObject({ expected: 2, statuses: expect.any(Array) });
    }

    it.each([
      [['execution_failed', 'undone'], 'was undone'],
      [['undone', 'execution_failed'], 'was undone'],
      [['execution_failed', 'rejected'], 'was declined'],
      [['execution_failed', 'expired'], 'expired'],
      [['execution_failed', 'draft'], 'was never approved'],
      [['execution_failed', 'ready_for_review'], 'is still waiting for review'],
    ] as const)('refuses %j and changes nothing', async (statuses, phrase) => {
      await force(ids[0], statuses[0]);
      await force(ids[1], statuses[1]);
      const snapshot = await Promise.all(ids.map((id) => proposalRepo.findById(TENANT, id)));
      const draftBefore = await draftRepo.getForTenant(TENANT);
      const auditBefore = (await auditRepo.findRecentByTenant(TENANT, { limit: 100 })).length;

      const err = await retry().catch((e: unknown) => e);

      expectUnsafe(err, phrase);
      expect((err as ConflictError).details).toMatchObject({ statuses: expect.arrayContaining([...statuses]) });
      // Neither row was reset, re-approved or re-stamped; no audit row of any kind;
      // the draft version did not move.
      expect(await Promise.all(ids.map((id) => proposalRepo.findById(TENANT, id)))).toEqual(snapshot);
      expect(await draftRepo.getForTenant(TENANT)).toEqual(draftBefore);
      expect((await auditRepo.findRecentByTenant(TENANT, { limit: 100 })).length).toBe(auditBefore);
      expect(await events('proposal.retried')).toHaveLength(0);
      expect(await events('onboarding.draft_retry')).toHaveLength(0);
    });

    it('refuses a failed proposal whose sibling row no longer exists, and changes nothing', async () => {
      await force(ids[0], 'execution_failed');
      const snapshot = await proposalRepo.findById(TENANT, ids[0]);
      const find = proposalRepo.findById.bind(proposalRepo);
      vi.spyOn(proposalRepo, 'findById').mockImplementation(async (t, id) => (id === ids[1] ? null : find(t, id)));
      const reset = vi.spyOn(proposalRepo, 'resetFailedForRetry');

      const err = await retry().catch((e: unknown) => e);

      expectUnsafe(err, 'is missing');
      expect((err as ConflictError).details).toMatchObject({ statuses: ['execution_failed'] });
      expect(reset).not.toHaveBeenCalled();
      expect((await draftRepo.getForTenant(TENANT))!.version).toBe(preApprovalVersion + 1);
      expect(await find(TENANT, ids[0])).toEqual(snapshot);
      expect(await events('proposal.retried')).toHaveLength(0);
    });

    it.each([
      [['undone', 'approved']],
      [['undone', 'executed']],
      [['undone', 'undone']],
    ] as const)('%j (nothing failed, but not recoverable either) is unsafe, not "nothing failed"', async (statuses) => {
      await force(ids[0], statuses[0]);
      await force(ids[1], statuses[1]);
      const err = await retry().catch((e: unknown) => e);
      expectUnsafe(err, 'was undone');
      expect((await draftRepo.getForTenant(TENANT))!.version).toBe(preApprovalVersion + 1);
    });
  });

  it('a draft that is not approved yet is DRAFT_NOT_APPROVED', async () => {
    const fresh = new InMemoryOnboardingDraftRepository();
    draftRepo = fresh;
    await createDraft();
    const draftBefore = await draftRepo.getForTenant(TENANT);
    const err = await retry().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain('DRAFT_NOT_APPROVED');
    expect(await draftRepo.getForTenant(TENANT)).toEqual(draftBefore);
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
    // The version moves only once the re-approval has succeeded, so a refusal
    // leaves it alone even where nothing rolls the request back (this repository).
    expect((await draftRepo.getForTenant(TENANT))!.version).toBe(preApprovalVersion + 1);
  });

  it('losing the reset to another path (nothing moved) is NOTHING_FAILED and leaves the version alone', async () => {
    await force(ids[0], 'execution_failed');
    vi.spyOn(proposalRepo, 'resetFailedForRetry').mockResolvedValue(null);
    const err = await retry().catch((e: unknown) => e);
    expect((err as ConflictError).message).toContain('DRAFT_RETRY_NOTHING_FAILED');
    expect((await draftRepo.getForTenant(TENANT))!.version).toBe(preApprovalVersion + 1);
    expect(await events('onboarding.draft_retry')).toHaveLength(0);
  });

  // The defect this pins (Codex P1): a retry opens a NEW undo window, so the
  // draft version has to name the attempt. A tab that rendered the original
  // approval must not be able to act on the retry it never saw.
  it('a tab holding the original approval is refused after a retry: its expectedVersion is a VERSION_CONFLICT, a bare approve is still the idempotent 200', async () => {
    await force(ids[0], 'execution_failed');
    // Before the retry the same confirmation is the idempotent re-tap.
    const beforeRetry = await approveDraft(deps(), TENANT, OWNER, { expectedVersion: preApprovalVersion });
    expect(beforeRetry.approvedNow).toBe(false);
    expect([...beforeRetry.proposalIds].sort()).toEqual(ids);

    const { draft } = await retry();

    const stale = approveDraft(deps(), TENANT, OWNER, { expectedVersion: preApprovalVersion });
    await expect(stale).rejects.toBeInstanceOf(DraftVersionConflictError);
    await expect(stale).rejects.toMatchObject({ expected: preApprovalVersion, actual: draft.version - 1 });
    const bare = await approveDraft(deps(), TENANT, OWNER);
    expect(bare.approvedNow).toBe(false);
    expect([...bare.proposalIds].sort()).toEqual(ids);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(2);
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

describe('InMemoryOnboardingDraftRepository.markRetried (compare-and-swap)', () => {
  async function approvedRepo() {
    const tiers = new InMemoryRegionalPriceTierRepository({ 'plumbing|CLE': CLE });
    const assembled = await assembleTypicalShop(tiers, { packId: 'plumbing', businessName: 'Walsh Plumbing', metro: { kind: 'metro', metroCode: 'CLE', name: 'Cleveland' } });
    const repo = new InMemoryOnboardingDraftRepository();
    const draft = await repo.create(TENANT, { packId: 'plumbing', trade: 'plumbing', metroCode: 'CLE', metroName: 'Cleveland', businessName: 'Walsh Plumbing', ownerFirstName: null, clientTimezone: 'America/New_York', assembled });
    return { repo, draft };
  }

  it('bumps only the version (and updatedAt) of an approved draft at the expected version', async () => {
    const { repo, draft } = await approvedRepo();
    const approved = await repo.markApproved(TENANT, ['p1', 'p2'], draft.version);
    const retried = await repo.markRetried(TENANT, approved.version);
    expect(retried).toEqual({ ...approved, version: approved.version + 1, updatedAt: retried.updatedAt });
    expect(await repo.getForTenant(TENANT)).toEqual(retried);
  });

  it('refuses a stale version, a draft that was never approved, and no draft, and writes nothing', async () => {
    const { repo, draft } = await approvedRepo();
    await expect(repo.markRetried(TENANT, draft.version)).rejects.toBeInstanceOf(DraftNotApprovedError);
    const approved = await repo.markApproved(TENANT, ['p1'], draft.version);
    await expect(repo.markRetried(TENANT, approved.version - 1)).rejects.toMatchObject({ expected: approved.version - 1, actual: approved.version });
    await expect(repo.markRetried(TENANT, approved.version + 1)).rejects.toBeInstanceOf(DraftVersionConflictError);
    await expect(repo.markRetried('00000000-0000-0000-0000-00000000ffff', 1)).rejects.toBeInstanceOf(DraftNotFoundError);
    expect(await repo.getForTenant(TENANT)).toEqual(approved);
  });
});
