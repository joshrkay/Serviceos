/**
 * S4-2 (U5) — `setMetro`, the metro change on an unapproved draft with nothing staged.
 *
 * A thin caller of `updateLocked`: lock, refuse once approved (DraftAlreadyApprovedError),
 * refuse once ANY choice is staged (DraftMetroLockedError, the precondition, so it wins
 * over a stale version), compare the version, then build the shop for the new metro
 * from the LOCKED row and store it whole with the code and the name in one write.
 *
 * In-memory repository here; the Pg half (same order, the one UPDATE, the race with a
 * choice PUT, the approve mint) is test/integration/onboarding-draft-metro.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  DraftAlreadyApprovedError,
  DraftMetroLockedError,
  DraftNotFoundError,
  DraftVersionConflictError,
  InMemoryOnboardingDraftRepository,
  type OnboardingDraft,
} from '../../../src/onboarding/draft/repository';
import { assembleTypicalShop, type AssembledShop } from '../../../src/onboarding/choices/assemble';
import { InMemoryRegionalPriceTierRepository } from '../../../src/onboarding/choices/price-tiers';
import type { StagedChoice } from '../../../src/onboarding/draft/contracts';

const TENANT = '00000000-0000-0000-0000-00000000d0c2';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };
const CMH = { standard: { tripFeeCents: 7900, hourlyRateCents: 13500 }, premium: { tripFeeCents: 10900, hourlyRateCents: 16500 } };
const tiers = new InMemoryRegionalPriceTierRepository({ 'plumbing|CLE': CLE, 'plumbing|CMH': CMH });

const columbus = { kind: 'metro' as const, metroCode: 'CMH', name: 'Columbus' };

async function seed(): Promise<{ repo: InMemoryOnboardingDraftRepository; draft: OnboardingDraft }> {
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
  });
  return { repo, draft };
}

/** An assemble callback that records the rows it was given. */
function recordingAssemble() {
  const seen: OnboardingDraft[] = [];
  const assemble = async (row: OnboardingDraft): Promise<AssembledShop> => {
    seen.push(row);
    return assembleTypicalShop(tiers, {
      packId: row.packId,
      businessName: row.businessName,
      ownerFirstName: row.ownerFirstName ?? undefined,
      metro: columbus,
    });
  };
  return { seen, assemble };
}

const STAGED: Array<[string, StagedChoice]> = [
  ["option 'a'", { option: 'a' }],
  ["option 'b'", { option: 'b' }],
  ['an override', { override: { label: 'Walsh, go ahead', writes: { voiceGreeting: 'Walsh, go ahead' } } }],
];

describe('setMetro (in-memory)', () => {
  it('rebuilds the shop for the new metro from the locked row and stores code, name and the whole shop in one bump', async () => {
    const { repo, draft } = await seed();
    const { seen, assemble } = recordingAssemble();
    const next = await repo.setMetro(TENANT, 'CMH', draft.version, assemble);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(draft);
    const expected = await assembleTypicalShop(tiers, { packId: 'plumbing', businessName: 'Walsh Plumbing', ownerFirstName: 'Jenna', metro: columbus });
    expect(next.assembled).toEqual(expected);
    expect(next.metroCode).toBe('CMH');
    expect(next.metroName).toBe('Columbus');
    expect(next.version).toBe(draft.version + 1);
    expect(next.choices).toEqual({});
    // Nothing of Cleveland is left: the shown prices are Columbus's.
    const price = next.assembled.choices.find((c) => c.settingKey === 'trip_fee_and_rate')!;
    expect(price.options.map((o) => o.prices)).toEqual([CMH.standard, CMH.premium]);
    expect(price.options[0].label).toBe('$79 to come out, then $135 an hour');
    expect(JSON.stringify(next.assembled)).not.toMatch(/Cleveland|\$89|\$150/);
    expect(await repo.getForTenant(TENANT)).toEqual(next);
  });

  it('an approved draft is DraftAlreadyApprovedError, even with a stale version; nothing changes and assemble never runs', async () => {
    const { repo, draft } = await seed();
    const approved = await repo.markApproved(TENANT, ['p1', 'p2'], draft.version);
    const { seen, assemble } = recordingAssemble();
    await expect(repo.setMetro(TENANT, 'CMH', approved.version, assemble)).rejects.toBeInstanceOf(DraftAlreadyApprovedError);
    await expect(repo.setMetro(TENANT, 'CMH', approved.version + 4, assemble)).rejects.toBeInstanceOf(DraftAlreadyApprovedError);
    expect(seen).toHaveLength(0);
    expect(await repo.getForTenant(TENANT)).toEqual(approved);
  });

  describe.each(STAGED)('with %s staged', (_name, choice) => {
    it('is DraftMetroLockedError at the current version and at a stale one (the lock wins over the version); nothing changes and assemble never runs', async () => {
      const { repo, draft } = await seed();
      const staged = await repo.stageChoice(TENANT, 'greeting', choice, draft.version);
      const { seen, assemble } = recordingAssemble();
      await expect(repo.setMetro(TENANT, 'CMH', staged.version, assemble)).rejects.toBeInstanceOf(DraftMetroLockedError);
      await expect(repo.setMetro(TENANT, 'CMH', staged.version - 1, assemble)).rejects.toBeInstanceOf(DraftMetroLockedError);
      expect(seen).toHaveLength(0);
      const after = await repo.getForTenant(TENANT);
      expect(after).toEqual(staged);
      expect(after).toMatchObject({ metroCode: 'CLE', metroName: 'Cleveland', version: staged.version });
    });
  });

  it('unstaged with a stale version is DraftVersionConflictError naming both; nothing changes and assemble never runs', async () => {
    const { repo, draft } = await seed();
    const { seen, assemble } = recordingAssemble();
    for (const stale of [draft.version - 1, draft.version + 1]) {
      await expect(repo.setMetro(TENANT, 'CMH', stale, assemble)).rejects.toSatisfy(
        (e: unknown) => e instanceof DraftVersionConflictError && e.expected === stale && e.actual === draft.version,
      );
    }
    expect(seen).toHaveLength(0);
    expect(await repo.getForTenant(TENANT)).toEqual(draft);
  });

  it('a code with no tier row stores the national (or pack default) shop with the city dropped from the copy, as POST /draft does', async () => {
    const { repo, draft } = await seed();
    const next = await repo.setMetro(TENANT, 'BUF', draft.version, (row) =>
      assembleTypicalShop(tiers, { packId: row.packId, businessName: row.businessName, metro: { kind: 'metro', metroCode: 'BUF', name: 'Buffalo' } }),
    );
    expect(next).toMatchObject({ metroCode: 'BUF', metroName: 'Buffalo' });
    expect(next.assembled).toMatchObject({ metroCode: 'BUF', showsCity: false, priceSource: 'pack_default' });
  });

  it('no draft is DraftNotFoundError', async () => {
    const repo = new InMemoryOnboardingDraftRepository();
    await expect(repo.setMetro(TENANT, 'CMH', 1, recordingAssemble().assemble)).rejects.toBeInstanceOf(DraftNotFoundError);
  });
});
