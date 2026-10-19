/**
 * Whole-draft undo (plan U9): POST /draft/undo takes back EVERY proposal an
 * approval made, or none, and returns the draft to editing. In-memory repos and
 * a fixed clock; the real-Postgres locking and races are in
 * test/integration/onboarding-draft-undo.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { approveDraft } from '../../../src/onboarding/draft/approve';
import { undoApprovedDraft } from '../../../src/onboarding/draft/undo';
import {
  DraftNotApprovedError,
  DraftNotFoundError,
  DraftVersionConflictError,
  InMemoryOnboardingDraftRepository,
  type OnboardingDraft,
} from '../../../src/onboarding/draft/repository';
import { InMemoryProposalRepository, type Proposal, type ProposalStatus } from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { assembleTypicalShop } from '../../../src/onboarding/choices/assemble';
import { InMemoryRegionalPriceTierRepository } from '../../../src/onboarding/choices/price-tiers';
import { ConflictError } from '../../../src/shared/errors';

const TENANT = '00000000-0000-0000-0000-00000000e0b1';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };
const OWNER = { userId: 'user-owner-1', role: 'owner' as const };
/** The fixed instant the approval happened at; the clock under test is this plus an offset. */
const APPROVED_AT = new Date('2026-10-19T12:00:00.000Z');

describe('undoApprovedDraft', () => {
  let draftRepo: InMemoryOnboardingDraftRepository;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let ids: string[];
  let approved: OnboardingDraft;
  let clockMs: number;

  const deps = () => ({ draftRepo, proposalRepo, auditRepo, now: () => new Date(clockMs) });
  const undo = (expectedVersion: number) => undoApprovedDraft(deps(), TENANT, OWNER, { expectedVersion });
  const events = async (type: string) => (await auditRepo.findRecentByTenant(TENANT, { limit: 100 })).filter((e) => e.eventType === type);
  const snapshot = async () => ({
    draft: await draftRepo.getForTenant(TENANT),
    proposals: await Promise.all(ids.map((id) => proposalRepo.findById(TENANT, id))),
    audit: (await auditRepo.findRecentByTenant(TENANT, { limit: 100 })).length,
  });

  async function force(id: string, status: ProposalStatus, extra: Partial<Proposal> = {}): Promise<void> {
    await proposalRepo.update(TENANT, id, { status, ...extra });
  }

  beforeEach(async () => {
    draftRepo = new InMemoryOnboardingDraftRepository();
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
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
    const result = await approveDraft({ draftRepo, proposalRepo, auditRepo }, TENANT, OWNER);
    approved = result.draft;
    ids = [...result.proposalIds].sort();
    // Pin the window to the fixed clock: both approved at APPROVED_AT, the clock 1 s later.
    for (const id of ids) await proposalRepo.update(TENANT, id, { approvedAt: APPROVED_AT });
    clockMs = APPROVED_AT.getTime() + 1000;
  });

  it('inside the window, with the approve response version: every proposal undone, the draft editable again at version + 1, audited once', async () => {
    const result = await undo(approved.version);

    for (const id of ids) {
      const p = (await proposalRepo.findById(TENANT, id))!;
      expect(p.status).toBe('undone');
      expect(p.undoneAt).toBeInstanceOf(Date);
      expect(p.undoneBy).toBe(OWNER.userId);
    }
    expect(result.draft).toMatchObject({ status: 'draft', proposalIds: [], approvedAt: null, version: approved.version + 1 });
    // Everything the owner chose is still there to edit; nothing else on the row moved.
    expect(result.draft).toEqual({
      ...approved,
      status: 'draft',
      proposalIds: [],
      approvedAt: null,
      version: approved.version + 1,
      updatedAt: result.draft.updatedAt,
    });
    expect(await draftRepo.getForTenant(TENANT)).toEqual(result.draft);
    expect(result.undoneProposalIds).toEqual(ids);

    const draftUndone = await events('onboarding.draft_undone');
    expect(draftUndone).toHaveLength(1);
    expect(draftUndone[0]).toMatchObject({ entityType: 'onboarding_draft', entityId: approved.id, actorId: OWNER.userId, actorRole: 'owner' });
    expect(draftUndone[0].metadata).toMatchObject({
      proposalIds: ids,
      draftVersionBefore: approved.version,
      draftVersionAfter: approved.version + 1,
    });
    const perMember = await events('proposal.undone');
    expect(perMember.map((e) => e.entityId).sort()).toEqual(ids);
    for (const e of perMember) expect(e.metadata).toMatchObject({ draftId: approved.id, status: 'undone' });
  });

  it('the last millisecond of the window still undoes; the first one after it does not', async () => {
    clockMs = APPROVED_AT.getTime() + 4999;
    await expect(undo(approved.version)).resolves.toMatchObject({ draft: { status: 'draft' } });

    // A second approval of the now-editable draft, pinned to the same instant, one millisecond past its window.
    const again = await approveDraft({ draftRepo, proposalRepo, auditRepo }, TENANT, OWNER);
    for (const id of again.proposalIds) await proposalRepo.update(TENANT, id, { approvedAt: APPROVED_AT });
    clockMs = APPROVED_AT.getTime() + 5000;
    const err = await undo(again.draft.version).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toMatch(/^UNDO_WINDOW_CLOSED: /);
  });

  describe('refusals change nothing', () => {
    async function expectNothingChanged(before: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
      expect(await snapshot()).toEqual(before);
      expect(await events('onboarding.draft_undone')).toHaveLength(0);
      expect(await events('proposal.undone')).toHaveLength(0);
    }

    it.each(['executing', 'executed', 'execution_failed', 'undone'] as const)(
      'one member %s: 409 DRAFT_UNDO_REFUSED naming the statuses, the draft still approved',
      async (status) => {
        await force(ids[1], status);
        const before = await snapshot();

        const err = await undo(approved.version).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ConflictError);
        const { message, details } = err as ConflictError;
        expect(message).toMatch(/^DRAFT_UNDO_REFUSED: /);
        expect(details).toEqual({ statuses: expect.arrayContaining(['approved', status]), expected: 2 });
        // Plain words after the code: no raw status, no internal vocabulary.
        const sentence = message.replace(/^DRAFT_UNDO_REFUSED: /, '');
        expect(sentence).not.toMatch(/proposal|execut|_|\b(ai|agents?|dashboard|verify|provisioning|stripe|twilio)\b/i);
        await expectNothingChanged(before);
      },
    );

    it('a listed proposal whose row is gone: DRAFT_UNDO_REFUSED naming missing', async () => {
      const find = proposalRepo.findByIdsForUpdate.bind(proposalRepo);
      vi.spyOn(proposalRepo, 'findByIdsForUpdate').mockImplementation(async (t, wanted) => (await find(t, wanted)).filter((p) => p.id !== ids[0]));
      const before = await snapshot();

      const err = await undo(approved.version).catch((e: unknown) => e);

      expect((err as ConflictError).message).toMatch(/^DRAFT_UNDO_REFUSED: /);
      expect((err as ConflictError).details).toEqual({ statuses: ['approved', 'missing'], expected: 2 });
      await expectNothingChanged(before);
    });

    it('one window closed (the other still open): 409 UNDO_WINDOW_CLOSED', async () => {
      await proposalRepo.update(TENANT, ids[0], { approvedAt: new Date(APPROVED_AT.getTime() - 5000) });
      const before = await snapshot();

      const err = await undo(approved.version).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toMatch(/^UNDO_WINDOW_CLOSED: /);
      const sentence = (err as ConflictError).message.replace(/^UNDO_WINDOW_CLOSED: /, '');
      expect(sentence).not.toMatch(/proposal|\d+ ?ms\b|_/i);
      await expectNothingChanged(before);
    });

    it('a stale version is a VERSION_CONFLICT naming both, decided before any proposal is read', async () => {
      // A closed window too: the version is what refuses it, because the set is never read.
      clockMs = APPROVED_AT.getTime() + 60_000;
      const before = await snapshot();
      const read = vi.spyOn(proposalRepo, 'findByIdsForUpdate');
      const byId = vi.spyOn(proposalRepo, 'findById');

      for (const stale of [approved.version - 1, approved.version + 1]) {
        const err = await undo(stale).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DraftVersionConflictError);
        expect(err).toMatchObject({ expected: stale, actual: approved.version });
      }
      expect(read).not.toHaveBeenCalled();
      expect(byId).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      await expectNothingChanged(before);
    });

    it('the same tap twice: the second finds the draft editing again and is DraftNotApprovedError, writing nothing', async () => {
      await undo(approved.version);
      const before = await snapshot();
      const read = vi.spyOn(proposalRepo, 'findByIdsForUpdate');

      await expect(undo(approved.version)).rejects.toBeInstanceOf(DraftNotApprovedError);
      expect(read).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(await events('onboarding.draft_undone')).toHaveLength(1);
    });

    it('no draft at all is DraftNotFoundError', async () => {
      draftRepo = new InMemoryOnboardingDraftRepository();
      await expect(undo(1)).rejects.toBeInstanceOf(DraftNotFoundError);
    });
  });

  it('reads the set through the ordered locking read, inside the draft lock, after the version is checked', async () => {
    const order: string[] = [];
    const lock = draftRepo.updateLocked.bind(draftRepo);
    vi.spyOn(draftRepo, 'updateLocked').mockImplementation(async (t, opts, compute) => {
      order.push(`lock:${opts.requireStatus}:${opts.expectedVersion}`);
      return lock(t, opts, async (row) => {
        order.push('compute');
        return compute(row);
      });
    });
    const read = proposalRepo.findByIdsForUpdate.bind(proposalRepo);
    vi.spyOn(proposalRepo, 'findByIdsForUpdate').mockImplementation(async (t, wanted) => {
      order.push(`read:${wanted.join(',')}`);
      return read(t, wanted);
    });

    await undo(approved.version);

    expect(order).toEqual([`lock:approved:${approved.version}`, 'compute', `read:${ids.join(',')}`]);
  });
});

describe('InMemoryProposalRepository.findByIdsForUpdate', () => {
  it('returns this tenant\'s rows for the ids, ordered by id, skipping missing and foreign ones', async () => {
    const repo = new InMemoryProposalRepository();
    const base = { proposalType: 'onboarding_tenant_settings', payload: {}, summary: 'x', createdBy: 'u', createdAt: new Date(), updatedAt: new Date(), status: 'approved' } as const;
    await repo.create({ ...base, id: 'b-2', tenantId: TENANT } as unknown as Proposal);
    await repo.create({ ...base, id: 'a-1', tenantId: TENANT } as unknown as Proposal);
    await repo.create({ ...base, id: 'c-3', tenantId: 'other-tenant' } as unknown as Proposal);

    const rows = await repo.findByIdsForUpdate(TENANT, ['c-3', 'b-2', 'zz-missing', 'a-1']);

    expect(rows.map((p) => p.id)).toEqual(['a-1', 'b-2']);
    expect(await repo.findByIdsForUpdate(TENANT, [])).toEqual([]);
  });
});
