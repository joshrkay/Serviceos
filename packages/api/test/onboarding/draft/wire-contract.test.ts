/**
 * Wire-contract pin: the draft the API builds must parse, field for field,
 * with the schemas in @ai-service-os/shared that the web client uses. The
 * API's own schemas stay where they are; this test fails when either side
 * adds, renames or drops a field, so api and web cannot drift silently.
 */
import { describe, it, expect } from 'vitest';
import {
  ApproveOnboardingDraftResponseSchema,
  CreateOnboardingDraftBodySchema,
  CreateOnboardingDraftResponseSchema,
  ONBOARDING_CHOICE_KEYS,
  ONBOARDING_CORE_CHOICE_KEYS,
  ONBOARDING_REGISTRY_TRADES,
  OnboardingDraftResponseSchema,
  OnboardingDraftSchema,
  StageOnboardingChoiceBodySchema,
} from '@ai-service-os/shared';
import { assembleTypicalShop } from '../../../src/onboarding/choices/assemble';
import { InMemoryRegionalPriceTierRepository } from '../../../src/onboarding/choices/price-tiers';
import { ALL_CHOICE_KEYS, CHOICE_KEYS } from '../../../src/onboarding/choices/schema';
import { REGISTRY_TRADES } from '../../../src/onboarding/choices/registry';
import { metroForPhone } from '../../../src/compliance/us-geography';
import { InMemoryOnboardingDraftRepository } from '../../../src/onboarding/draft/repository';
import { CreateDraftInputSchema, StageChoiceBodySchema } from '../../../src/onboarding/draft/contracts';

const TENANT_ID = '00000000-0000-0000-0000-0000000000a1';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };

/** What Express does to a response body: Dates become ISO strings, undefined keys vanish. */
const overTheWire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

async function buildDraft(packId: string, phone: string | null) {
  const tierRepo = new InMemoryRegionalPriceTierRepository({ 'plumbing|CLE': CLE });
  const assembled = await assembleTypicalShop(tierRepo, {
    packId,
    businessName: 'Walsh Plumbing',
    ownerFirstName: 'Jenna',
    metro: phone ? metroForPhone(phone) : null,
  });
  const repo = new InMemoryOnboardingDraftRepository();
  const draft = await repo.create(TENANT_ID, {
    packId,
    trade: assembled.trade,
    metroCode: assembled.metroCode,
    metroName: assembled.metroName,
    businessName: 'Walsh Plumbing',
    ownerFirstName: 'Jenna',
    clientTimezone: 'America/New_York',
    assembled,
  });
  return { repo, draft };
}

describe('onboarding draft wire contract (api <-> shared)', () => {
  it('parses a freshly created metro draft and loses no field', async () => {
    const { draft } = await buildDraft('plumbing', '(216) 555-0142');
    const wire = overTheWire(draft);
    const parsed = OnboardingDraftSchema.parse(wire);
    expect(parsed).toEqual(wire);
    expect(parsed.assembled.showsCity).toBe(true);
    expect(parsed.assembled.choices).toHaveLength(ALL_CHOICE_KEYS.length);
  });

  it('parses draft variants: pack-default prices, generic trade, staged option and override, approved', async () => {
    const generic = await buildDraft('painting', null);
    expect(OnboardingDraftSchema.parse(overTheWire(generic.draft))).toEqual(overTheWire(generic.draft));

    const { repo, draft } = await buildDraft('plumbing', '(216) 555-0142');
    const s1 = await repo.stageChoice(TENANT_ID, 'booking_posture', { option: 'b' }, draft.version);
    const s2 = await repo.stageChoice(
      TENANT_ID,
      'trip_fee_and_rate',
      { override: { label: '$95, then $140 an hour', writes: {}, prices: { tripFeeCents: 9500, hourlyRateCents: 14000 } } },
      s1.version,
    );
    const s3 = await repo.stageChoice(
      TENANT_ID,
      'greeting',
      { override: { label: 'Walsh, go ahead', writes: { voiceGreeting: 'Walsh, go ahead' } } },
      s2.version,
    );
    expect(OnboardingDraftSchema.parse(overTheWire(s3))).toEqual(overTheWire(s3));

    const approved = await repo.markApproved(TENANT_ID, ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
    const wire = overTheWire(approved);
    expect(OnboardingDraftSchema.parse(wire)).toEqual(wire);
  });

  it('parses every response envelope the draft routes send', async () => {
    const { draft } = await buildDraft('plumbing', '(216) 555-0142');
    const wireDraft = overTheWire(draft);
    expect(CreateOnboardingDraftResponseSchema.parse({ draft: wireDraft, created: true }).created).toBe(true);
    expect(OnboardingDraftResponseSchema.parse({ draft: wireDraft }).draft.version).toBe(1);
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    expect(ApproveOnboardingDraftResponseSchema.parse({ draft: wireDraft, proposalIds: ids, approvedNow: true }).proposalIds).toEqual(ids);
  });

  it('accepts exactly the request bodies the API accepts', () => {
    const create = { packId: 'plumbing', businessName: 'Walsh Plumbing', ownerFirstName: 'Jenna', phone: '(216) 555-0142', clientTimezone: 'America/New_York' };
    expect(CreateDraftInputSchema.safeParse(create).success).toBe(true);
    expect(CreateOnboardingDraftBodySchema.safeParse(create).success).toBe(true);
    for (const bad of [{ packId: '' }, { ...create, extra: 1 }, { ...create, businessName: 'x'.repeat(121) }]) {
      expect(CreateOnboardingDraftBodySchema.safeParse(bad).success).toBe(CreateDraftInputSchema.safeParse(bad).success);
    }

    const stage = [
      { choice: { option: 'a' }, version: 1 },
      { choice: { option: 'c' }, version: 1 },
      { choice: { option: 'a' }, version: 0 },
      { choice: { override: { label: 'x', writes: { voiceGreeting: 'hi' } } }, version: 3 },
      { choice: { override: { label: '', writes: {} } }, version: 3 },
      { choice: { option: 'a' }, version: 1, extra: true },
    ];
    for (const body of stage) {
      expect(StageOnboardingChoiceBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(StageChoiceBodySchema.safeParse(body).success);
    }
  });

  it('keeps the shared choice-key and trade lists equal to the API registry', () => {
    expect([...ONBOARDING_CHOICE_KEYS]).toEqual([...ALL_CHOICE_KEYS]);
    expect([...ONBOARDING_CORE_CHOICE_KEYS]).toEqual([...CHOICE_KEYS]);
    expect([...ONBOARDING_REGISTRY_TRADES]).toEqual([...REGISTRY_TRADES]);
  });
});
