/**
 * U11 — every writer of onboarding_drafts is a thin caller of `updateLocked`.
 *
 * The helper does the four steps in one order: lock the row, refuse the wrong
 * status, check the writer's precondition, compare the caller's version, then
 * compute the change from the LOCKED row and issue the one UPDATE. These tests
 * pin that order on the in-memory repository (the Pg half is
 * test/integration/onboarding-draft-writers-vs-approve.test.ts, on real
 * Postgres), and a guard reads the repository source so a future writer cannot
 * add a second `UPDATE onboarding_drafts` that skips a step.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DraftAlreadyApprovedError,
  DraftNotApprovedError,
  DraftNotFoundError,
  DraftVersionConflictError,
  InMemoryOnboardingDraftRepository,
  type OnboardingDraft,
  type OnboardingDraftRepository,
} from '../../../src/onboarding/draft/repository';
import { assembleTypicalShop } from '../../../src/onboarding/choices/assemble';
import { InMemoryRegionalPriceTierRepository } from '../../../src/onboarding/choices/price-tiers';

const TENANT = '00000000-0000-0000-0000-00000000d0b1';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };

async function draftRepo(): Promise<{ repo: InMemoryOnboardingDraftRepository; draft: OnboardingDraft }> {
  const assembled = await assembleTypicalShop(new InMemoryRegionalPriceTierRepository({ 'plumbing|CLE': CLE }), {
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

/**
 * One row per writer: how to call it with a version, which status it requires,
 * and what it leaves on the row. `version` is undefined for the one writer that
 * takes none (the timezone write), so its stale-version case is skipped.
 */
interface WriterCase {
  name: string;
  requires: 'draft' | 'approved';
  write: (repo: OnboardingDraftRepository, version: number) => Promise<OnboardingDraft>;
  takesVersion: boolean;
  applied: (d: OnboardingDraft) => boolean;
}

const WRITERS: WriterCase[] = [
  {
    name: 'stageChoice',
    requires: 'draft',
    takesVersion: true,
    write: (repo, v) => repo.stageChoice(TENANT, 'greeting', { option: 'b' }, v),
    applied: (d) => d.choices.greeting !== undefined && 'option' in d.choices.greeting && d.choices.greeting.option === 'b',
  },
  {
    name: 'setClientTimezone',
    requires: 'draft',
    takesVersion: false,
    write: (repo) => repo.setClientTimezone(TENANT, 'America/Chicago'),
    applied: (d) => d.clientTimezone === 'America/Chicago',
  },
  {
    name: 'setOwnerPhone',
    requires: 'draft',
    takesVersion: true,
    write: (repo, v) => repo.setOwnerPhone(TENANT, '+12165550142', v),
    applied: (d) => d.ownerPhone === '+12165550142',
  },
  {
    name: 'markApproved',
    requires: 'draft',
    takesVersion: true,
    write: (repo, v) => repo.markApproved(TENANT, ['p1', 'p2'], v),
    applied: (d) => d.status === 'approved' && d.proposalIds.join(',') === 'p1,p2' && d.approvedAt !== null,
  },
  {
    name: 'markRetried',
    requires: 'approved',
    takesVersion: true,
    write: (repo, v) => repo.markRetried(TENANT, v),
    applied: () => true,
  },
];

describe.each(WRITERS)('$name through updateLocked (in-memory)', ({ requires, write, takesVersion, applied }) => {
  /** A draft in the status this writer requires, and one in the status it refuses. */
  async function rowIn(status: 'draft' | 'approved') {
    const { repo, draft } = await draftRepo();
    if (status === 'draft') return { repo, row: draft };
    return { repo, row: await repo.markApproved(TENANT, ['p1', 'p2'], draft.version) };
  }
  const wrong = requires === 'draft' ? 'approved' : 'draft';
  const wrongError = requires === 'draft' ? DraftAlreadyApprovedError : DraftNotApprovedError;

  it(`refuses a ${wrong} draft first, even with a stale version, and writes nothing`, async () => {
    const { repo, row } = await rowIn(wrong);
    await expect(write(repo, row.version + 7)).rejects.toBeInstanceOf(wrongError);
    await expect(write(repo, row.version)).rejects.toBeInstanceOf(wrongError);
    expect(await repo.getForTenant(TENANT)).toEqual(row);
  });

  it('no draft is DraftNotFoundError', async () => {
    const repo = new InMemoryOnboardingDraftRepository();
    await expect(write(repo, 1)).rejects.toBeInstanceOf(DraftNotFoundError);
  });

  if (takesVersion) {
    it('a stale expectedVersion is DraftVersionConflictError naming expected and found, and writes nothing', async () => {
      const { repo, row } = await rowIn(requires);
      for (const stale of [row.version - 1, row.version + 1]) {
        const attempt = write(repo, stale);
        await expect(attempt).rejects.toBeInstanceOf(DraftVersionConflictError);
        await expect(attempt).rejects.toMatchObject({ expected: stale, actual: row.version });
      }
      expect(await repo.getForTenant(TENANT)).toEqual(row);
    });
  }

  it('bumps version by exactly one on success and the value is on the row', async () => {
    const { repo, row } = await rowIn(requires);
    const next = await write(repo, row.version);
    expect(next.version).toBe(row.version + 1);
    expect(applied(next)).toBe(true);
    expect(next.updatedAt.getTime()).toBeGreaterThanOrEqual(row.updatedAt.getTime());
    expect(await repo.getForTenant(TENANT)).toEqual(next);
  });
});

describe('updateLocked (in-memory)', () => {
  class MetroLockedForTest extends Error {
    constructor() {
      super('metro locked');
      this.name = 'MetroLockedForTest';
    }
  }

  it('answers a failing precondition before the version compare, with nothing written', async () => {
    const { repo, draft } = await draftRepo();
    let computed = 0;
    const attempt = repo.updateLocked(
      TENANT,
      {
        requireStatus: 'draft',
        expectedVersion: draft.version + 3,
        precondition: () => {
          throw new MetroLockedForTest();
        },
      },
      () => {
        computed += 1;
        return { metroCode: 'CMH' };
      },
    );
    await expect(attempt).rejects.toBeInstanceOf(MetroLockedForTest);
    expect(computed).toBe(0);
    expect(await repo.getForTenant(TENANT)).toEqual(draft);
  });

  it('checks the status before the precondition', async () => {
    const { repo, draft } = await draftRepo();
    const approved = await repo.markApproved(TENANT, ['p1'], draft.version);
    const seen: string[] = [];
    const attempt = repo.updateLocked(
      TENANT,
      {
        requireStatus: 'draft',
        precondition: () => {
          seen.push('precondition');
        },
      },
      () => ({}),
    );
    await expect(attempt).rejects.toBeInstanceOf(DraftAlreadyApprovedError);
    expect(seen).toEqual([]);
    expect(await repo.getForTenant(TENANT)).toEqual(approved);
  });

  it('compute receives the locked row, not an earlier read: the patch is computed from what is stored now', async () => {
    const { repo, draft } = await draftRepo();
    const stale = (await repo.getForTenant(TENANT))!;
    await repo.stageChoice(TENANT, 'greeting', { option: 'b' }, draft.version);
    const next = await repo.updateLocked(TENANT, { requireStatus: 'draft' }, (row) => {
      expect(row).not.toEqual(stale);
      expect(row.version).toBe(stale.version + 1);
      return { choices: { ...row.choices, booking_posture: { option: 'b' } } };
    });
    expect(next.choices).toEqual({ greeting: { option: 'b' }, booking_posture: { option: 'b' } });
    expect(next.version).toBe(draft.version + 2);
  });

  it('an empty patch still bumps the version (a retry opens a new attempt without changing a field)', async () => {
    const { repo, draft } = await draftRepo();
    const next = await repo.updateLocked(TENANT, { requireStatus: 'draft', expectedVersion: draft.version }, () => ({}));
    expect(next).toEqual({ ...draft, version: draft.version + 1, updatedAt: next.updatedAt });
  });

  it('no expectedVersion means lock-only: the write lands whatever the version is', async () => {
    const { repo, draft } = await draftRepo();
    const staged = await repo.stageChoice(TENANT, 'greeting', { option: 'b' }, draft.version);
    const next = await repo.updateLocked(TENANT, { requireStatus: 'draft' }, async () => ({ ownerPhone: '+12165550142' }));
    expect(next.version).toBe(staged.version + 1);
    expect(next.ownerPhone).toBe('+12165550142');
    expect(next.choices.greeting).toEqual({ option: 'b' });
  });
});

describe('single-UPDATE guard (repository source)', () => {
  const source = readFileSync(resolve(__dirname, '../../../src/onboarding/draft/repository.ts'), 'utf8');

  /** [start, end) of the `updateLocked` method body in the Pg class. */
  function updateLockedBody(): [number, number] {
    const pgClass = source.indexOf('class PgOnboardingDraftRepository');
    const inMemoryClass = source.indexOf('class InMemoryOnboardingDraftRepository');
    expect(pgClass).toBeGreaterThan(-1);
    expect(inMemoryClass).toBeGreaterThan(pgClass);
    const start = source.indexOf('\n  async updateLocked', pgClass);
    expect(start, 'PgOnboardingDraftRepository.updateLocked must exist').toBeGreaterThan(-1);
    expect(start).toBeLessThan(inMemoryClass);
    // The method ends where the next class-level member starts (two-space indent).
    const nextMember = source.indexOf('\n  async ', start + 1);
    const end = nextMember === -1 || nextMember > inMemoryClass ? inMemoryClass : nextMember;
    return [start, end];
  }

  function occurrences(needle: string): number[] {
    const out: number[] = [];
    let i = source.indexOf(needle);
    while (i !== -1) {
      out.push(i);
      i = source.indexOf(needle, i + 1);
    }
    return out;
  }

  it('`UPDATE onboarding_drafts` occurs exactly once, inside updateLocked', () => {
    const [start, end] = updateLockedBody();
    const hits = occurrences('UPDATE onboarding_drafts');
    expect(hits, 'every draft writer must go through updateLocked').toHaveLength(1);
    expect(hits[0]).toBeGreaterThan(start);
    expect(hits[0]).toBeLessThan(end);
  });

  it('`INSERT INTO onboarding_drafts` occurs only in create', () => {
    const pgClass = source.indexOf('class PgOnboardingDraftRepository');
    const createStart = source.indexOf('\n  async create(', pgClass);
    const createEnd = source.indexOf('\n  async ', createStart + 1);
    const hits = occurrences('INSERT INTO onboarding_drafts');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBeGreaterThan(createStart);
    expect(hits[0]).toBeLessThan(createEnd);
  });

  it('no other statement writes the table (no DELETE, no TRUNCATE)', () => {
    expect(source).not.toMatch(/DELETE FROM onboarding_drafts/);
    expect(source).not.toMatch(/TRUNCATE[^;]*onboarding_drafts/);
  });
});
