import { describe, it, expect } from 'vitest';
import { buildDraftProposals, resolveChoices } from '../../../src/onboarding/draft/approve';
import { InMemoryOnboardingDraftRepository, type OnboardingDraft } from '../../../src/onboarding/draft/repository';
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
    expect(tenantSettings.sourceContext).toEqual({ surface: 'onboarding_readback', draftId: draft.id });

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

  it('refuses without a recorded, valid timezone rather than guessing one', async () => {
    const none = await draftFor({ clientTimezone: null });
    expect(() => buildDraftProposals(none.draft, 'u')).toThrow(/TIMEZONE_REQUIRED/);
    const bogus = await draftFor({ clientTimezone: 'Mars/Olympus' });
    expect(() => buildDraftProposals(bogus.draft, 'u')).toThrow(/TIMEZONE_REQUIRED/);
  });

  it('refuses an already approved draft', async () => {
    const { repo } = await draftFor();
    const approved = await repo.markApproved(TENANT, ['p1']);
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
