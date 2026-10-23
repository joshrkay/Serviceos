import { describe, it, expect, vi } from 'vitest';
import { ONBOARDING_READBACK_SURFACE, approveDraft, buildDraftProposals, resolveChoices } from '../../../src/onboarding/draft/approve';
import {
  DraftAlreadyApprovedError,
  DraftNotFoundError,
  DraftVersionConflictError,
  InMemoryOnboardingDraftRepository,
  type OnboardingDraft,
  type OnboardingDraftRepository,
} from '../../../src/onboarding/draft/repository';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { assembleTypicalShop } from '../../../src/onboarding/choices/assemble';
import { InMemoryRegionalPriceTierRepository } from '../../../src/onboarding/choices/price-tiers';
import { onboardingTenantSettingsPayloadSchema, onboardingVoicePolicyPayloadSchema } from '../../../src/proposals/contracts/onboarding';

const TENANT = '00000000-0000-0000-0000-00000000d0a1';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };

async function draftFor(overrides: Partial<Parameters<InMemoryOnboardingDraftRepository['create']>[1]> = {}): Promise<{ repo: InMemoryOnboardingDraftRepository; draft: OnboardingDraft }> {
  const tiers = new InMemoryRegionalPriceTierRepository({ 'plumbing|CLE': CLE });
  const assembled = await assembleTypicalShop(tiers, {
    packId: 'plumbing',
    businessName: 'Walsh Plumbing',
    ownerFirstName: 'Jenna',
    metro: { kind: 'metro', metroCode: 'CLE', name: 'Cleveland' },
  });
  const repo = new InMemoryOnboardingDraftRepository();
  const draft = await repo.create(TENANT, {
    packId: 'plumbing',
    trade: 'plumbing',
    metroCode: 'CLE',
    metroName: 'Cleveland',
    businessName: 'Walsh Plumbing',
    ownerFirstName: 'Jenna',
    clientTimezone: 'America/New_York',
    assembled,
    ...overrides,
  });
  return { repo, draft };
}

describe('resolveChoices', () => {
  it('uses the default (most shops) for unanswered choices, the pick for answered ones, and the override text for overrides', async () => {
    const { repo, draft } = await draftFor();
    let d = await repo.stageChoice(TENANT, 'greeting', { option: 'b' }, draft.version);
    d = await repo.stageChoice(TENANT, 'trip_fee_and_rate', { override: { label: '$120 then $175', writes: {}, prices: { tripFeeCents: 12000, hourlyRateCents: 17500 } } }, d.version);
    const r = resolveChoices(d);
    const by = Object.fromEntries(r.map((x) => [x.settingKey, x]));
    expect(by.greeting.source).toBe('b');
    expect(by.greeting.writes.voiceGreeting).toBe("Thanks for calling Walsh Plumbing. What's going on today?");
    expect(by.trip_fee_and_rate.source).toBe('override');
    expect(by.trip_fee_and_rate.prices).toEqual({ tripFeeCents: 12000, hourlyRateCents: 17500 });
    expect(by.booking_posture.source).toBe('a');
    expect(by.booking_posture.writes.autonomousBookingEnabled).toBe(true);
  });
});

describe('buildDraftProposals', () => {
  it('mints valid onboarding_tenant_settings and onboarding_voice_policy inputs from a draft with defaults', async () => {
    const { draft } = await draftFor();
    const { tenantSettings, voicePolicy } = buildDraftProposals(draft, 'user_owner');

    expect(tenantSettings.proposalType).toBe('onboarding_tenant_settings');
    expect(onboardingTenantSettingsPayloadSchema.safeParse(tenantSettings.payload).success).toBe(true);
    expect(tenantSettings.payload).toMatchObject({
      businessName: 'Walsh Plumbing',
      city: 'Cleveland',
      verticalPacks: ['plumbing'],
      hourlyRateCents: 15000,
      tripFeeCents: 8900,
      timezone: 'America/New_York',
    });
    expect(tenantSettings.sourceContext).toEqual({ surface: ONBOARDING_READBACK_SURFACE, draftId: draft.id });

    expect(voicePolicy.proposalType).toBe('onboarding_voice_policy');
    expect(onboardingVoicePolicyPayloadSchema.safeParse(voicePolicy.payload).success).toBe(true);
    expect(voicePolicy.payload).toEqual({
      voiceGreeting: 'Walsh Plumbing, how can I help?',
      autonomousBookingEnabled: true,
      afterHoursVoiceMode: 'ai_answering',
      emergencyTarget: 'owner_cell',
      paymentCollectionMode: 'pay_link',
      bookingHoursPreset: 'mon_sat_7_5',
    });
    expect(voicePolicy.createdBy).toBe('user_owner');
  });

  it('carries picked options and overrides into the payloads', async () => {
    const { repo, draft } = await draftFor();
    let d = await repo.stageChoice(TENANT, 'trip_fee_and_rate', { option: 'b' }, draft.version);
    d = await repo.stageChoice(TENANT, 'booking_posture', { option: 'b' }, d.version);
    d = await repo.stageChoice(TENANT, 'after_hours_mode', { option: 'b' }, d.version);
    const { tenantSettings, voicePolicy } = buildDraftProposals(d, 'u');
    expect(tenantSettings.payload).toMatchObject({ hourlyRateCents: 18500, tripFeeCents: 12900 });
    expect(voicePolicy.payload).toMatchObject({ autonomousBookingEnabled: false, afterHoursVoiceMode: 'voicemail' });
  });

  it('never puts hasExistingBusinessNumber in the voice policy payload (draft-only answer)', async () => {
    const { repo, draft } = await draftFor();
    const d = await repo.stageChoice(TENANT, 'existing_number', { option: 'a' }, draft.version);
    // The answer exists on the resolved choice (the v3 shell reads it from the draft)...
    const resolved = resolveChoices(d).find((r) => r.settingKey === 'existing_number');
    expect(resolved?.writes.hasExistingBusinessNumber).toBeDefined();
    // ...but is not a tenant setting, so it never lands in the proposal.
    const { voicePolicy } = buildDraftProposals(d, 'u');
    expect(voicePolicy.payload).not.toHaveProperty('hasExistingBusinessNumber');
    expect(Object.keys(voicePolicy.payload).sort()).toEqual(
      ['afterHoursVoiceMode', 'autonomousBookingEnabled', 'bookingHoursPreset', 'emergencyTarget', 'paymentCollectionMode', 'voiceGreeting'],
    );
  });

  it('refuses without a recorded, valid timezone rather than guessing one', async () => {
    const none = await draftFor({ clientTimezone: null });
    expect(() => buildDraftProposals(none.draft, 'u')).toThrow(/TIMEZONE_REQUIRED/);
    const bogus = await draftFor({ clientTimezone: 'Mars/Olympus' });
    expect(() => buildDraftProposals(bogus.draft, 'u')).toThrow(/TIMEZONE_REQUIRED/);
  });

  it('refuses an already approved draft', async () => {
    const { repo, draft } = await draftFor();
    const approved = await repo.markApproved(TENANT, ['p1'], draft.version);
    expect(() => buildDraftProposals(approved, 'u')).toThrow(/DRAFT_ALREADY_APPROVED/);
  });

  it('omits city when the metro was unknown and never fabricates one', async () => {
    const tiers = new InMemoryRegionalPriceTierRepository();
    const assembled = await assembleTypicalShop(tiers, { packId: 'hvac', businessName: 'M&R Mechanical', metro: { kind: 'unknown' } });
    const repo = new InMemoryOnboardingDraftRepository();
    const draft = await repo.create(TENANT, { packId: 'hvac', trade: 'hvac', metroCode: null, metroName: null, businessName: 'M&R Mechanical', ownerFirstName: null, clientTimezone: 'America/Phoenix', assembled });
    const { tenantSettings } = buildDraftProposals(draft, 'u');
    expect(tenantSettings.payload).not.toHaveProperty('city');
    expect(tenantSettings.payload).toMatchObject({ verticalPacks: ['hvac'], hourlyRateCents: 12500, tripFeeCents: 8900 });
  });
});

const ACTOR = { userId: 'user_owner', role: 'owner' as const };

async function approveHarness(overrides: Parameters<typeof draftFor>[0] = {}) {
  const { repo, draft } = await draftFor(overrides);
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  return { repo, draft, proposalRepo, auditRepo, deps: { draftRepo: repo as OnboardingDraftRepository, proposalRepo, auditRepo } };
}

async function approvedAudits(auditRepo: InMemoryAuditRepository) {
  return (await auditRepo.findRecentByTenant(TENANT, { limit: 50 })).filter((a) => a.eventType === 'onboarding.draft_approved');
}

describe('approveDraft (lock, version check, idempotence)', () => {
  it('approves with expectedVersion = draft.version, bumps the version, and audits once with draftVersion', async () => {
    const h = await approveHarness();
    const res = await approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: h.draft.version });
    expect(res.approvedNow).toBe(true);
    expect(res.proposalIds).toHaveLength(2);
    expect(res.draft.status).toBe('approved');
    expect(res.draft.version).toBe(h.draft.version + 1);
    expect(res.draft.proposalIds).toEqual(res.proposalIds);
    const proposals = await h.proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(2);
    for (const p of proposals) {
      expect(p.status).toBe('approved');
      expect(p.sourceContext).toMatchObject({ draftId: h.draft.id });
    }
    const audits = await approvedAudits(h.auditRepo);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ draftVersion: h.draft.version, proposalIds: res.proposalIds });
  });

  it('still approves when expectedVersion is omitted (lock-only mode)', async () => {
    const h = await approveHarness();
    const res = await approveDraft(h.deps, TENANT, ACTOR);
    expect(res.approvedNow).toBe(true);
    expect(await h.proposalRepo.findByTenant(TENANT)).toHaveLength(2);
  });

  it('a stale expectedVersion (behind or ahead) throws DraftVersionConflictError and mints nothing', async () => {
    const h = await approveHarness();
    const staged = await h.repo.stageChoice(TENANT, 'greeting', { option: 'b' }, h.draft.version);
    const behind = approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: h.draft.version });
    await expect(behind).rejects.toBeInstanceOf(DraftVersionConflictError);
    await expect(behind).rejects.toMatchObject({ expected: h.draft.version, actual: staged.version });
    await expect(approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: staged.version + 5 })).rejects.toBeInstanceOf(DraftVersionConflictError);
    expect(await h.proposalRepo.findByTenant(TENANT)).toHaveLength(0);
    expect((await h.repo.getForTenant(TENANT))!.status).toBe('draft');
    expect(await approvedAudits(h.auditRepo)).toHaveLength(0);
  });

  it('builds from the row getForTenantForUpdate returned, never from a plain read', async () => {
    const h = await approveHarness();
    const stale = (await h.repo.getForTenant(TENANT))!;
    await h.repo.stageChoice(TENANT, 'greeting', { option: 'b' }, h.draft.version);
    const calls: string[] = [];
    const getForTenant = vi.fn(async () => {
      calls.push('getForTenant');
      return stale;
    });
    const double: OnboardingDraftRepository = {
      getForTenant,
      getForTenantForUpdate: async (t) => {
        calls.push('getForTenantForUpdate');
        return h.repo.getForTenantForUpdate(t);
      },
      create: (t, i) => h.repo.create(t, i),
      stageChoice: (t, k, c, v) => h.repo.stageChoice(t, k, c, v),
      setClientTimezone: (t, z) => h.repo.setClientTimezone(t, z),
      setOwnerPhone: (t, p, v) => h.repo.setOwnerPhone(t, p, v),
      markApproved: (t, ids, v) => h.repo.markApproved(t, ids, v),
      markRetried: (t, v) => h.repo.markRetried(t, v),
      updateLocked: (t, o, c) => h.repo.updateLocked(t, o, c),
    };
    await approveDraft({ ...h.deps, draftRepo: double }, TENANT, ACTOR);
    expect(getForTenant).not.toHaveBeenCalled();
    expect(calls[0]).toBe('getForTenantForUpdate');
    const policy = (await h.proposalRepo.findByTenant(TENANT)).find((p) => p.proposalType === 'onboarding_voice_policy')!;
    expect(policy.payload).toMatchObject({ voiceGreeting: "Thanks for calling Walsh Plumbing. What's going on today?" });
  });

  it('an already approved draft returns the first call\'s ids and mints nothing, with no expectedVersion or the version it was approved from', async () => {
    const h = await approveHarness();
    const first = await approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: h.draft.version });
    const retap = await approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: h.draft.version });
    const bare = await approveDraft(h.deps, TENANT, ACTOR);
    for (const second of [retap, bare]) {
      expect(second.approvedNow).toBe(false);
      expect(second.proposalIds).toEqual(first.proposalIds);
    }
    expect(await h.proposalRepo.findByTenant(TENANT)).toHaveLength(2);
    expect(await approvedAudits(h.auditRepo)).toHaveLength(1);
  });

  it('an already approved draft refuses any other expectedVersion with DraftVersionConflictError (stale tab or ahead of the row), minting nothing', async () => {
    const h = await approveHarness();
    const first = await approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: h.draft.version });
    const approvedFrom = first.draft.version - 1;
    // Tab A rendered an older read-back; tab B's changes and approval moved the draft on.
    const stale = approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: approvedFrom - 1 });
    await expect(stale).rejects.toBeInstanceOf(DraftVersionConflictError);
    await expect(stale).rejects.toMatchObject({ expected: approvedFrom - 1, actual: approvedFrom });
    // The approved row's own version is not "the version it was approved from" either.
    await expect(approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: first.draft.version })).rejects.toBeInstanceOf(DraftVersionConflictError);
    await expect(approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: first.draft.version + 5 })).rejects.toBeInstanceOf(DraftVersionConflictError);
    expect(await h.proposalRepo.findByTenant(TENANT)).toHaveLength(2);
    expect(await approvedAudits(h.auditRepo)).toHaveLength(1);
  });

  // A retry opens a new approval attempt and moves the version (retry.ts), so the
  // original confirmation is now a stale one. Intended: no counter column, the
  // version itself names the attempt.
  it('once a retry has moved the version on, the original expectedVersion is refused while a bare approve stays the idempotent 200', async () => {
    const h = await approveHarness();
    const first = await approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: h.draft.version });
    const retried = await h.repo.markRetried(TENANT, first.draft.version);
    expect(retried.version).toBe(h.draft.version + 2);

    const stale = approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: h.draft.version });
    await expect(stale).rejects.toBeInstanceOf(DraftVersionConflictError);
    await expect(stale).rejects.toMatchObject({ expected: h.draft.version, actual: h.draft.version + 1 });
    const bare = await approveDraft(h.deps, TENANT, ACTOR);
    expect(bare).toMatchObject({ approvedNow: false, proposalIds: first.proposalIds });
    expect(await h.proposalRepo.findByTenant(TENANT)).toHaveLength(2);
    expect(await approvedAudits(h.auditRepo)).toHaveLength(1);
  });

  it.each([1, 2, 3])('after %i retries the version it was approved from is `version - 1 - r`: that one and none are 200, every other is refused', async (r) => {
    const h = await approveHarness();
    const first = await approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: h.draft.version });
    let row = first.draft;
    for (let i = 0; i < r; i++) row = await h.repo.markRetried(TENANT, row.version);
    expect(row.version).toBe(h.draft.version + 1 + r);
    const approvedFrom = row.version - 1 - r;
    expect(approvedFrom).toBe(h.draft.version);

    // The original confirmation (and anything else but the latest attempt's base) is a stale tab now.
    for (const stale of [approvedFrom, approvedFrom - 1, row.version, row.version + 1]) {
      const attempt = approveDraft(h.deps, TENANT, ACTOR, { expectedVersion: stale });
      await expect(attempt).rejects.toBeInstanceOf(DraftVersionConflictError);
      await expect(attempt).rejects.toMatchObject({ expected: stale, actual: row.version - 1 });
    }
    for (const body of [{}, { expectedVersion: row.version - 1 }]) {
      expect(await approveDraft(h.deps, TENANT, ACTOR, body)).toMatchObject({ approvedNow: false, proposalIds: first.proposalIds });
    }
    expect(await h.proposalRepo.findByTenant(TENANT)).toHaveLength(2);
    expect(await approvedAudits(h.auditRepo)).toHaveLength(1);
  });

  it('no draft rejects with DraftNotFoundError', async () => {
    const h = await approveHarness();
    await expect(approveDraft(h.deps, '00000000-0000-0000-0000-00000000ffff', ACTOR)).rejects.toBeInstanceOf(DraftNotFoundError);
  });

  it('a missing timezone still rejects with TIMEZONE_REQUIRED after the locked read, minting nothing', async () => {
    const h = await approveHarness({ clientTimezone: null });
    const order: string[] = [];
    const spy: OnboardingDraftRepository = {
      getForTenant: (t) => h.repo.getForTenant(t),
      getForTenantForUpdate: async (t) => {
        order.push('lock');
        return h.repo.getForTenantForUpdate(t);
      },
      create: (t, i) => h.repo.create(t, i),
      stageChoice: (t, k, c, v) => h.repo.stageChoice(t, k, c, v),
      setClientTimezone: (t, z) => h.repo.setClientTimezone(t, z),
      setOwnerPhone: (t, p, v) => h.repo.setOwnerPhone(t, p, v),
      markApproved: (t, ids, v) => h.repo.markApproved(t, ids, v),
      markRetried: (t, v) => h.repo.markRetried(t, v),
      updateLocked: (t, o, c) => h.repo.updateLocked(t, o, c),
    };
    await expect(approveDraft({ ...h.deps, draftRepo: spy }, TENANT, ACTOR)).rejects.toThrow(/TIMEZONE_REQUIRED/);
    expect(order).toEqual(['lock']);
    expect(await h.proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});

describe('InMemoryOnboardingDraftRepository.markApproved (compare-and-swap)', () => {
  it('throws the typed error for a stale version, an approved draft, or no draft, and writes nothing', async () => {
    const { repo, draft } = await draftFor();
    await expect(repo.markApproved(TENANT, ['p1'], draft.version + 1)).rejects.toBeInstanceOf(DraftVersionConflictError);
    await expect(repo.markApproved('00000000-0000-0000-0000-00000000ffff', ['p1'], 1)).rejects.toBeInstanceOf(DraftNotFoundError);
    expect(await repo.getForTenant(TENANT)).toMatchObject({ status: 'draft', version: draft.version, proposalIds: [] });

    const approved = await repo.markApproved(TENANT, ['p1'], draft.version);
    expect(approved).toMatchObject({ status: 'approved', version: draft.version + 1, proposalIds: ['p1'] });
    await expect(repo.markApproved(TENANT, ['p2'], approved.version)).rejects.toBeInstanceOf(DraftAlreadyApprovedError);
    expect(await repo.getForTenant(TENANT)).toMatchObject({ status: 'approved', version: draft.version + 1, proposalIds: ['p1'] });
  });
});

/**
 * Without a pool getForTenantForUpdate holds no lock, so a PUT /choices can
 * land between approve's read and its markApproved write. That write already
 * compares the version approve read, so a choice saved before it is never
 * erased; the in-memory updateLocked now also takes the row one writer at a
 * time, so a choice saved while it is being written cannot slip through the
 * compare either. (The two proposals a refused approve minted stay in this
 * repository: nothing rolls back in memory. On Postgres the PUT waits on the
 * row lock and the refused request's transaction drops them.)
 */
describe('approveDraft without a row lock (no pool): a choice saved after the locked read', () => {
  it('a choice saved before the approval is written is kept, and approve is refused with VERSION_CONFLICT', async () => {
    const h = await approveHarness();
    const realLock = h.repo.getForTenantForUpdate.bind(h.repo);
    h.repo.getForTenantForUpdate = async (t) => {
      const row = await realLock(t);
      await h.repo.stageChoice(t, 'greeting', { option: 'b' }, row!.version);
      return row;
    };

    const err = await approveDraft(h.deps, TENANT, ACTOR).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DraftVersionConflictError);
    expect(err).toMatchObject({ expected: h.draft.version, actual: h.draft.version + 1 });
    const stored = (await h.repo.getForTenant(TENANT))!;
    expect(stored).toMatchObject({ status: 'draft', proposalIds: [], version: h.draft.version + 1 });
    expect(stored.choices.greeting).toEqual({ option: 'b' });
    expect(await approvedAudits(h.auditRepo)).toHaveLength(0);
  });

  it('a choice saved while the approval is being written: only one lands, and the choice is never erased', async () => {
    const h = await approveHarness();
    const realMarkApproved = h.repo.markApproved.bind(h.repo);
    let put: Promise<OnboardingDraft> | undefined;
    h.repo.markApproved = (t, ids, v) => {
      // The PUT from the same read-back starts writing first; the approval's write follows it.
      put = h.repo.stageChoice(t, 'greeting', { option: 'b' }, v);
      return realMarkApproved(t, ids, v);
    };

    const [approved] = await Promise.allSettled([approveDraft(h.deps, TENANT, ACTOR)]);
    const staged = await put!;

    expect(approved.status).toBe('rejected');
    expect((approved as PromiseRejectedResult).reason).toBeInstanceOf(DraftVersionConflictError);
    expect(staged.choices.greeting).toEqual({ option: 'b' });
    const stored = (await h.repo.getForTenant(TENANT))!;
    expect(stored).toMatchObject({ status: 'draft', proposalIds: [], version: h.draft.version + 1 });
    expect(stored.choices.greeting).toEqual({ option: 'b' });
    expect(await approvedAudits(h.auditRepo)).toHaveLength(0);
  });
});
