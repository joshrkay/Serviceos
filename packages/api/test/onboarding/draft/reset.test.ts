/**
 * Whole-draft reset (plan U9, S4-5): POST /draft/reset is the locked way out of
 * an approval that can no longer finish as one unit (the owner split it from
 * the inbox, a member failed beside a terminal one, or a member lapsed). It
 * reverts every member still `approved` inside its window, expires every
 * leftover still `draft` / `ready_for_review` as superseded, leaves every other
 * member exactly as it is, and returns the draft to editing; or it refuses and
 * changes nothing. In-memory repos and a fixed clock; the real-Postgres
 * locking, rollback and races are in test/integration/onboarding-draft-reset.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { approveDraft } from '../../../src/onboarding/draft/approve';
import { resetApprovedDraft } from '../../../src/onboarding/draft/reset';
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
import { deriveOnboardingStatus, type OnboardingFacts } from '../../../src/onboarding/derive-status';
import { lockedSetFact } from '../../../src/onboarding/draft/locked-set';
import { forceStatus } from '../../helpers/proposal-status';

const TENANT = '00000000-0000-0000-0000-00000000e0c5';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };
const OWNER = { userId: 'user-owner-1', role: 'owner' as const };
/** The fixed instant the approval happened at; the clock under test is this plus an offset. */
const APPROVED_AT = new Date('2026-10-19T12:00:00.000Z');
const FORBIDDEN_COPY = /proposal|execut|_|\b(ai|agents?|dashboard|verify|provisioning|stripe|twilio)\b/i;

describe('resetApprovedDraft', () => {
  let draftRepo: InMemoryOnboardingDraftRepository;
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  /** The two proposals the approval minted, ascending id. */
  let ids: string[];
  let approved: OnboardingDraft;
  let clockMs: number;

  const deps = () => ({ draftRepo, proposalRepo, auditRepo, now: () => new Date(clockMs) });
  const reset = (expectedVersion: number) => resetApprovedDraft(deps(), TENANT, OWNER, { expectedVersion });
  const events = async (type: string) => (await auditRepo.findRecentByTenant(TENANT, { limit: 200 })).filter((e) => e.eventType === type);
  const statusOf = async (id: string) => (await proposalRepo.findById(TENANT, id))?.status;
  const snapshot = async () => ({
    draft: await draftRepo.getForTenant(TENANT),
    proposals: await Promise.all(ids.map((id) => proposalRepo.findById(TENANT, id))),
    audit: (await auditRepo.findRecentByTenant(TENANT, { limit: 200 })).length,
  });

  async function force(id: string, status: ProposalStatus, extra: Partial<Proposal> = {}): Promise<void> {
    forceStatus(proposalRepo, TENANT, id, status, extra);
  }
  /** What the status read would say about this draft right now (the shell's hint). */
  async function recoveryHint() {
    const draft = (await draftRepo.getForTenant(TENANT))!;
    const members = await proposalRepo.findByIdsForUpdate(TENANT, draft.proposalIds);
    const facts = {
      tenantId: TENANT,
      tenantExists: true,
      identity: { businessName: null, businessHours: null, jobBufferMinutes: null, hourlyRateCents: null },
      packActivated: false,
      twilioStatus: null,
      subscription: { stripeSubscriptionId: null, status: null },
      inboundCallCount: 0,
      testCallSkippedAt: null,
      voiceAgentLiveAt: null,
      activatedAt: null,
      aiConfigPresent: false,
      aiVerificationStatus: null,
      aiVerificationSkippedAt: null,
      draft: {
        status: draft.status,
        choicesAnswered: Object.keys(draft.choices).length,
        version: draft.version,
        proposals: lockedSetFact({ expected: draft.proposalIds.length, members }),
      },
    } satisfies OnboardingFacts;
    return deriveOnboardingStatus(facts, new Date(clockMs)).draft;
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
    const staged = await draftRepo.stageChoice(TENANT, 'greeting', { option: 'b' }, 1);
    const result = await approveDraft({ draftRepo, proposalRepo, auditRepo }, TENANT, OWNER, { expectedVersion: staged.version });
    approved = result.draft;
    ids = [...result.proposalIds].sort();
    for (const id of ids) await proposalRepo.update(TENANT, id, { approvedAt: APPROVED_AT });
    clockMs = APPROVED_AT.getTime() + 1000;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the finding: the owner undid ONE half from the inbox; reset reverts the other, the draft is editable at version + 1 with its choices, audited once', async () => {
    await force(ids[0], 'undone', { undoneAt: new Date(clockMs), undoneBy: OWNER.userId });
    expect(await recoveryHint()).toMatchObject({ execution: 'stopped', recovery: 'reset' });

    const result = await reset(approved.version);

    expect(await statusOf(ids[0])).toBe('undone');
    const reverted = (await proposalRepo.findById(TENANT, ids[1]))!;
    expect(reverted).toMatchObject({ status: 'undone', undoneBy: OWNER.userId });
    expect(reverted.undoneAt).toBeInstanceOf(Date);
    expect(result.draft).toEqual({
      ...approved,
      status: 'draft',
      proposalIds: [],
      approvedAt: null,
      version: approved.version + 1,
      updatedAt: result.draft.updatedAt,
    });
    expect(result.draft.choices).toEqual({ greeting: { option: 'b' } });
    expect(await draftRepo.getForTenant(TENANT)).toEqual(result.draft);
    expect(result).toMatchObject({ revertedProposalIds: [ids[1]], supersededProposalIds: [] });

    const resetEvents = await events('onboarding.draft_reset');
    expect(resetEvents).toHaveLength(1);
    expect(resetEvents[0]).toMatchObject({ entityType: 'onboarding_draft', entityId: approved.id, actorId: OWNER.userId, actorRole: 'owner' });
    expect(resetEvents[0].metadata).toEqual({
      reverted: [ids[1]],
      superseded: [],
      others: [{ id: ids[0], status: 'undone' }],
      supersededReason: 'superseded_by_reset',
      draftVersionBefore: approved.version,
      draftVersionAfter: approved.version + 1,
    });
    const undoneRows = await events('proposal.undone');
    expect(undoneRows.map((e) => e.entityId)).toEqual([ids[1]]);
    expect(undoneRows[0].metadata).toMatchObject({ draftId: approved.id, status: 'undone', via: 'reset' });
    expect(await events('onboarding.draft_undone')).toHaveLength(0);

    // Editing again: a choice PUT at the new version lands, and the next approval mints a fresh pair.
    const restaged = await draftRepo.stageChoice(TENANT, 'greeting', { option: 'a' }, result.draft.version);
    const again = await approveDraft({ draftRepo, proposalRepo, auditRepo }, TENANT, OWNER, { expectedVersion: restaged.version });
    expect(again.proposalIds).toHaveLength(2);
    expect(again.proposalIds.some((id) => ids.includes(id))).toBe(false);
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(4);
  });

  describe('accepted sets: each ends editable with one onboarding.draft_reset', () => {
    type Member = ProposalStatus | 'missing';
    /** [first member, second member, what happens to each: reverted / superseded / left]. */
    const table: Array<[string, Member, Member, ('reverted' | 'superseded' | 'left')[]]> = [
      ['undone + undone (nothing left to revert)', 'undone', 'undone', ['left', 'left']],
      ['rejected + approved in the window', 'rejected', 'approved', ['left', 'reverted']],
      ['expired + approved in the window', 'expired', 'approved', ['left', 'reverted']],
      ['execution_failed + undone (the set retry refuses)', 'execution_failed', 'undone', ['left', 'left']],
      ['execution_failed + execution_failed', 'execution_failed', 'execution_failed', ['left', 'left']],
      ['a stray draft member + undone', 'draft', 'undone', ['superseded', 'left']],
      ['a stray ready_for_review member + undone', 'ready_for_review', 'undone', ['superseded', 'left']],
      ['a listed id with no row + approved in the window', 'missing', 'approved', ['left', 'reverted']],
      ['all approved in the window (a superset of undo)', 'approved', 'approved', ['reverted', 'reverted']],
    ];

    it.each(table)('%s', async (_name, first, second, outcome) => {
      const members: Member[] = [first, second];
      for (const [i, status] of members.entries()) {
        if (status !== 'missing' && status !== 'approved') await force(ids[i], status);
      }
      if (members.includes('missing')) {
        const find = proposalRepo.findByIdsForUpdate.bind(proposalRepo);
        vi.spyOn(proposalRepo, 'findByIdsForUpdate').mockImplementation(async (t, wanted) =>
          (await find(t, wanted)).filter((p) => p.id !== ids[members.indexOf('missing')]),
        );
      }
      // Whenever the hint says Start over for a set that is stopped or failed, the endpoint agrees.
      const hint = await recoveryHint();
      if (hint?.execution === 'stopped' || hint?.execution === 'failed') expect(hint.recovery).toBe('reset');

      const result = await reset(approved.version);
      vi.restoreAllMocks();

      expect(result.draft).toMatchObject({ status: 'draft', proposalIds: [], approvedAt: null, version: approved.version + 1 });
      expect(result.draft.choices).toEqual({ greeting: { option: 'b' } });
      const expectedReverted = ids.filter((_, i) => outcome[i] === 'reverted');
      const expectedSuperseded = ids.filter((_, i) => outcome[i] === 'superseded');
      const expectedOthers = ids
        .map((id, i) => ({ id, status: members[i] as string, i }))
        .filter(({ i }) => outcome[i] === 'left')
        .map(({ id, status }) => ({ id, status }));
      expect(result.revertedProposalIds).toEqual(expectedReverted);
      expect(result.supersededProposalIds).toEqual(expectedSuperseded);
      for (const [i, id] of ids.entries()) {
        const expected = outcome[i] === 'reverted' ? 'undone' : outcome[i] === 'superseded' ? 'expired' : members[i] === 'missing' ? 'approved' : members[i];
        expect(await statusOf(id), `member ${i}`).toBe(expected);
      }
      const resetEvents = await events('onboarding.draft_reset');
      expect(resetEvents).toHaveLength(1);
      expect(resetEvents[0].metadata).toMatchObject({
        reverted: expectedReverted,
        superseded: expectedSuperseded,
        draftVersionBefore: approved.version,
        draftVersionAfter: approved.version + 1,
      });
      const others = resetEvents[0].metadata?.others as { id: string; status: string }[];
      expect(others).toEqual(expect.arrayContaining(expectedOthers));
      expect(others).toHaveLength(expectedOthers.length);
      expect((await events('proposal.undone')).map((e) => e.entityId).sort()).toEqual(expectedReverted);
      const expiredRows = await events('proposal.expired');
      expect(expiredRows.map((e) => e.entityId).sort()).toEqual(expectedSuperseded);
      for (const e of expiredRows) {
        expect(e).toMatchObject({ actorId: OWNER.userId, actorRole: 'owner', entityType: 'proposal' });
        expect(e.metadata).toMatchObject({ reason: 'superseded_by_reset', draftId: approved.id, status: 'expired' });
      }
    });

    it('both leftovers superseded: a draft and a ready_for_review member both end expired, one proposal.expired each', async () => {
      await force(ids[0], 'draft');
      await force(ids[1], 'ready_for_review');
      const result = await reset(approved.version);
      expect(result.supersededProposalIds).toEqual(ids);
      for (const id of ids) expect(await statusOf(id)).toBe('expired');
      expect((await events('proposal.expired')).map((e) => e.entityId).sort()).toEqual(ids);
      expect((await events('onboarding.draft_reset'))[0].metadata).toMatchObject({ superseded: ids, reverted: [], others: [] });
    });
  });

  describe('refusals change nothing', () => {
    async function expectNothingChanged(before: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
      expect(await snapshot()).toEqual(before);
      expect(await events('onboarding.draft_reset')).toHaveLength(0);
    }

    it.each([
      ['executed + undone (the sibling ran before the inbox undo)', 'executed', 'undone', 'applied'],
      ['executed + ready_for_review', 'executed', 'ready_for_review', 'applied'],
      ['executing + undone', 'executing', 'undone', 'executing'],
      ['executing + draft', 'executing', 'draft', 'executing'],
      ['executed + executing (the most final blocker names it)', 'executed', 'executing', 'applied'],
    ] as const)('%s: 409 DRAFT_RESET_REFUSED with its reason, plain words, nothing written', async (_name, a, b, reason) => {
      await force(ids[0], a);
      await force(ids[1], b);
      const before = await snapshot();
      const writes = vi.spyOn(proposalRepo, 'updateStatusIf');

      const err = await reset(approved.version).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictError);
      const { message, details } = err as ConflictError;
      expect(message).toMatch(/^DRAFT_RESET_REFUSED: /);
      expect(details).toEqual({ reason, statuses: [a, b], expected: 2 });
      expect(message.replace(/^DRAFT_RESET_REFUSED: /, '')).not.toMatch(FORBIDDEN_COPY);
      if (reason === 'applied') expect(message).toMatch(/Settings/);
      // Decided before any write: no member write was even attempted.
      expect(writes).not.toHaveBeenCalled();
      await expectNothingChanged(before);
      // The hint agrees: Settings (never a Start over) whenever the set is stopped or failed;
      // a set still landing (executing) offers no way out at all yet.
      const hint = await recoveryHint();
      if (hint?.execution === 'stopped' || hint?.execution === 'failed') expect(hint.recovery).toBe('settings');
      else expect(hint).not.toHaveProperty('recovery');
    });

    it.each([
      ['approved past its window + undone', 'undone'],
      ['approved past its window + draft (the leftover is not superseded either)', 'draft'],
    ] as const)('%s: 409 UNDO_WINDOW_CLOSED, nothing written', async (_name, sibling) => {
      await force(ids[0], sibling);
      clockMs = APPROVED_AT.getTime() + 5000;
      const before = await snapshot();
      const writes = vi.spyOn(proposalRepo, 'updateStatusIf');

      const err = await reset(approved.version).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toMatch(/^UNDO_WINDOW_CLOSED: /);
      expect((err as ConflictError).message.replace(/^UNDO_WINDOW_CLOSED: /, '')).not.toMatch(FORBIDDEN_COPY);
      expect((err as ConflictError).details).toEqual({ statuses: [sibling, 'approved'].sort((x, y) => (x === sibling ? -1 : 1) - (y === sibling ? -1 : 1)), expected: 2 });
      expect(writes).not.toHaveBeenCalled();
      await expectNothingChanged(before);
      expect(await statusOf(ids[0])).toBe(sibling);
    });

    it('the last millisecond of the window still resets; the first one after it does not', async () => {
      await force(ids[0], 'undone');
      clockMs = APPROVED_AT.getTime() + 5000;
      await expect(reset(approved.version)).rejects.toThrow(/^UNDO_WINDOW_CLOSED: /);
      clockMs = APPROVED_AT.getTime() + 4999;
      await expect(reset(approved.version)).resolves.toMatchObject({ draft: { status: 'draft' } });
    });

    it('a stale or ahead version is VERSION_CONFLICT naming both, decided before any proposal is read', async () => {
      await force(ids[0], 'undone');
      const before = await snapshot();
      const read = vi.spyOn(proposalRepo, 'findByIdsForUpdate');
      for (const stale of [approved.version - 1, approved.version + 1]) {
        const err = await reset(stale).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DraftVersionConflictError);
        expect(err).toMatchObject({ expected: stale, actual: approved.version });
      }
      expect(read).not.toHaveBeenCalled();
      await expectNothingChanged(before);
    });

    it('a second reset, or a reset after undo, finds the draft editing again: DraftNotApprovedError, nothing written', async () => {
      await force(ids[0], 'undone');
      await reset(approved.version);
      const before = await snapshot();
      const read = vi.spyOn(proposalRepo, 'findByIdsForUpdate');
      await expect(reset(approved.version)).rejects.toBeInstanceOf(DraftNotApprovedError);
      await expect(reset(approved.version + 1)).rejects.toBeInstanceOf(DraftNotApprovedError);
      expect(read).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(await events('onboarding.draft_reset')).toHaveLength(1);
    });

    it('no draft at all is DraftNotFoundError', async () => {
      draftRepo = new InMemoryOnboardingDraftRepository();
      await expect(reset(1)).rejects.toBeInstanceOf(DraftNotFoundError);
    });
  });

  it('supersede is all or nothing: the second leftover\'s write throwing leaves the draft approved and emits no draft_reset (Pg rolls the first back too)', async () => {
    await force(ids[0], 'draft');
    await force(ids[1], 'ready_for_review');
    const write = proposalRepo.updateStatusIf.bind(proposalRepo);
    vi.spyOn(proposalRepo, 'updateStatusIf').mockImplementation(async (t, id, from, to, updates) => {
      if (id === ids[1]) throw new Error('connection lost');
      return write(t, id, from, to, updates);
    });
    const draftBefore = await draftRepo.getForTenant(TENANT);

    await expect(reset(approved.version)).rejects.toThrow('connection lost');

    // updateLocked's compute threw before the draft UPDATE: the draft is untouched in memory.
    // (The in-memory proposal repo has no transaction, so the first leftover's write is not
    // undone here; the integration test proves Postgres rolls it back.)
    expect(await draftRepo.getForTenant(TENANT)).toEqual(draftBefore);
    expect(await events('onboarding.draft_reset')).toHaveLength(0);
    expect(await statusOf(ids[1])).toBe('ready_for_review');
  });

  it('a conditional member write that matches nothing fails closed instead of half-resetting', async () => {
    await force(ids[0], 'undone');
    vi.spyOn(proposalRepo, 'updateStatusIf').mockResolvedValue(null);
    const draftBefore = await draftRepo.getForTenant(TENANT);
    const err = await reset(approved.version).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toMatch(/^DRAFT_RESET_REFUSED: /);
    expect(await draftRepo.getForTenant(TENANT)).toEqual(draftBefore);
  });

  it('locks the draft, then reads the set through the ordered locking read, then writes', async () => {
    await force(ids[0], 'undone');
    const order: string[] = [];
    const lock = draftRepo.updateLocked.bind(draftRepo);
    vi.spyOn(draftRepo, 'updateLocked').mockImplementation(async (t, opts, compute) => {
      order.push(`lock:${opts.requireStatus}:${opts.expectedVersion}`);
      return lock(t, opts, compute);
    });
    const read = proposalRepo.findByIdsForUpdate.bind(proposalRepo);
    vi.spyOn(proposalRepo, 'findByIdsForUpdate').mockImplementation(async (t, wanted) => {
      order.push(`read:${wanted.join(',')}`);
      return read(t, wanted);
    });
    const write = proposalRepo.updateStatusIf.bind(proposalRepo);
    vi.spyOn(proposalRepo, 'updateStatusIf').mockImplementation(async (t, id, from, to, updates) => {
      order.push(`write:${id}:${to}`);
      return write(t, id, from, to, updates);
    });

    await reset(approved.version);

    expect(order).toEqual([`lock:approved:${approved.version}`, `read:${ids.join(',')}`, `write:${ids[1]}:undone`]);
  });
});
