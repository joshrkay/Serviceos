import { describe, it, expect } from 'vitest';
import { OWNER_PHONE_INVALID_MESSAGE, isCanonicalOwnerPhone, parseOwnerPhone } from '../../../src/onboarding/draft/owner-phone';
import { normalizeMobileE164 } from '../../../src/shared/phone/normalize';
import { ValidationError } from '../../../src/shared/errors';
import {
  DraftAlreadyApprovedError,
  DraftNotFoundError,
  DraftVersionConflictError,
  InMemoryOnboardingDraftRepository,
} from '../../../src/onboarding/draft/repository';
import { buildDraftProposals } from '../../../src/onboarding/draft/approve';
import { assembleTypicalShop } from '../../../src/onboarding/choices/assemble';
import { InMemoryRegionalPriceTierRepository } from '../../../src/onboarding/choices/price-tiers';
import { onboardingTenantSettingsPayloadSchema } from '../../../src/proposals/contracts/onboarding';

const TENANT = '00000000-0000-0000-0000-00000000d0b1';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };

async function newDraft(ownerPhone?: string | null) {
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
    ...(ownerPhone !== undefined ? { ownerPhone } : {}),
  });
  return { repo, draft };
}

describe('parseOwnerPhone', () => {
  it.each(['(216) 555-0142', '216-555-0142', '216.555.0142', '2165550142', '12165550142', '+1 (216) 555-0142', '  +12165550142  '])(
    'normalises %j to E.164, with the same normaliser the identity step uses',
    (raw) => {
      expect(parseOwnerPhone(raw, 'phone')).toBe('+12165550142');
      expect(parseOwnerPhone(raw, 'phone')).toBe(normalizeMobileE164(raw));
    },
  );

  it.each(['abc', '555-0142', '123-456-7890', '+44 20 7946 0958', '', '   '])('rejects %j with a VALIDATION_ERROR naming the field and never echoing the input', (raw) => {
    for (const field of ['phone', 'ownerPhone'] as const) {
      let thrown: unknown;
      try {
        parseOwnerPhone(raw, field);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ValidationError);
      const e = thrown as ValidationError;
      expect(e.statusCode).toBe(400);
      expect(e.code).toBe('VALIDATION_ERROR');
      expect(e.details).toEqual({ issues: [{ path: field, message: OWNER_PHONE_INVALID_MESSAGE }] });
      if (raw.trim() !== '') expect(JSON.stringify(e.details)).not.toContain(raw);
    }
  });
});

describe('isCanonicalOwnerPhone', () => {
  it('is true only for an already-canonical +1XXXXXXXXXX', () => {
    expect(isCanonicalOwnerPhone('+12165550142')).toBe(true);
    expect(isCanonicalOwnerPhone('(216) 555-0142')).toBe(false);
    expect(isCanonicalOwnerPhone('2165550142')).toBe(false);
    expect(isCanonicalOwnerPhone('+442079460958')).toBe(false);
    expect(isCanonicalOwnerPhone('')).toBe(false);
  });
});

describe('InMemoryOnboardingDraftRepository owner phone', () => {
  it('stores the cell when given and an explicit null when omitted', async () => {
    const withCell = await newDraft('+12165550142');
    expect(withCell.draft.ownerPhone).toBe('+12165550142');
    expect((await withCell.repo.getForTenant(TENANT))?.ownerPhone).toBe('+12165550142');

    const without = await newDraft();
    expect(without.draft.ownerPhone).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(without.draft, 'ownerPhone')).toBe(true);
  });

  it('setOwnerPhone sets the value and bumps the version; an identical value still bumps it', async () => {
    const { repo, draft } = await newDraft();
    const a = await repo.setOwnerPhone(TENANT, '+12165550199', draft.version);
    expect(a.ownerPhone).toBe('+12165550199');
    expect(a.version).toBe(draft.version + 1);
    const b = await repo.setOwnerPhone(TENANT, '+12165550199', a.version);
    expect(b.version).toBe(a.version + 1);
  });

  it('refuses a stale version with both numbers', async () => {
    const { repo, draft } = await newDraft();
    await repo.setOwnerPhone(TENANT, '+12165550199', draft.version);
    await expect(repo.setOwnerPhone(TENANT, '+12165550177', draft.version)).rejects.toMatchObject({
      name: 'DraftVersionConflictError',
      expected: draft.version,
      actual: draft.version + 1,
    });
  });

  it('answers DraftAlreadyApproved before the version check', async () => {
    const { repo, draft } = await newDraft();
    await repo.markApproved(TENANT, ['p1', 'p2'], draft.version);
    await expect(repo.setOwnerPhone(TENANT, '+12165550199', 1)).rejects.toBeInstanceOf(DraftAlreadyApprovedError);
    expect((await repo.getForTenant(TENANT))?.ownerPhone).toBeNull();
  });

  it('throws DraftNotFoundError when there is no draft', async () => {
    const repo = new InMemoryOnboardingDraftRepository();
    await expect(repo.setOwnerPhone(TENANT, '+12165550199', 1)).rejects.toBeInstanceOf(DraftNotFoundError);
  });

  it('rejects a non-canonical value before any write', async () => {
    const { repo, draft } = await newDraft();
    await expect(repo.setOwnerPhone(TENANT, '(216) 555-0199', draft.version)).rejects.toThrow();
    const after = await repo.getForTenant(TENANT);
    expect(after?.ownerPhone).toBeNull();
    expect(after?.version).toBe(draft.version);
  });
});

describe('buildDraftProposals owner phone', () => {
  it('carries the cell on the tenant-settings payload, keeps it through the strip-mode schema, and leaves the voice policy alone', async () => {
    const { draft } = await newDraft('+12165550142');
    const { tenantSettings, voicePolicy } = buildDraftProposals(draft, 'user_owner');
    expect(tenantSettings.payload).toHaveProperty('ownerPhone', '+12165550142');
    const parsed = onboardingTenantSettingsPayloadSchema.parse(tenantSettings.payload);
    expect(parsed.ownerPhone).toBe('+12165550142');
    expect(voicePolicy.payload).not.toHaveProperty('ownerPhone');
  });

  // The OWNER_PHONE_REQUIRED gate is deliberately absent: both emergency options
  // ring the owner, so a gate would make every draft without a cell unapprovable
  // until the web read-back asks for the number. The gate and that prompt ship
  // together later (a gate with nothing to lift it can never be approved).
  it.each([undefined, 'a', 'b'] as const)('does not gate approval on a missing cell (emergency option %s) and omits the key', async (option) => {
    const { repo, draft } = await newDraft();
    const d = option ? await repo.stageChoice(TENANT, 'emergency_target', { option }, draft.version) : draft;
    const { tenantSettings } = buildDraftProposals(d, 'user_owner');
    expect(tenantSettings.payload).not.toHaveProperty('ownerPhone');
    expect(onboardingTenantSettingsPayloadSchema.safeParse(tenantSettings.payload).success).toBe(true);
  });

  it('reflects a number changed after the first screen, not the first-screen one', async () => {
    const { repo, draft } = await newDraft('+12165550142');
    const changed = await repo.setOwnerPhone(TENANT, '+12165550177', draft.version);
    const { tenantSettings } = buildDraftProposals(changed, 'user_owner');
    expect(tenantSettings.payload).toHaveProperty('ownerPhone', '+12165550177');
  });
});
