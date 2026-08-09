/**
 * Task 9 (2026-08-07 tradesperson plan) — lookupMaterials skill tests.
 *
 * Quality-review I3: this file was missing entirely, breaking the
 * one-test-file-per-lookup-skill convention (test/ai/skills/lookup-*.test.ts)
 * and CLAUDE.md's same-commit testing rule. Covers the three behaviors the
 * review specifically flagged as untested — (a) the 5-item truncation +
 * "and more" tail past MAX_ITEMS_SPOKEN, (b) the error path, (c)
 * lookupEvents.record firing on 'none' and 'error', not just 'found' — plus
 * the redesign this same review forced: bounded fetch (I4)/count semantics
 * (M2), TTS-safe quantity wording (I2), description truncation (M1),
 * needed-by surfacing (spec-review MAJOR B).
 *
 * Follow-up (2026-08-09) — `neededByBefore` date scoping. Covers: the
 * `dateTimeDescription` -> `resolveSpokenDay` -> `neededByBefore` wiring,
 * the NULL-exclusion/ordering contract inherited from the repo layer, the
 * date-aware summary phrasing, and the deliberate "unparseable phrase means
 * NO filter" behavior (unlike lookup-crew-schedule.ts's today-fallback).
 */
import { describe, it, expect, vi } from 'vitest';
import { lookupMaterials } from '../../../src/ai/skills/lookup-materials';
import { InMemoryMaterialItemRepository, type MaterialItem } from '../../../src/materials/material-item';
import type { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

const TENANT = 't-1';
const TZ = 'America/New_York';
// 2026-06-11 (Thursday) ~07:00 New York (11:00 UTC).
const NOW = new Date('2026-06-11T11:00:00.000Z');

function eventsSpy(): LookupEventService {
  return { record: vi.fn(async () => ({}) as never) } as unknown as LookupEventService;
}

describe('lookupMaterials skill', () => {
  it('reports an empty list as status "none" and records the lookup event', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    const lookupEvents = eventsSpy();

    const res = await lookupMaterials({ tenantId: TENANT }, { materialItemRepo, lookupEvents });

    expect(res.status).toBe('none');
    expect(res.data.count).toBe(0);
    expect(res.data.spokenItems).toEqual([]);
    expect(res.summary).toMatch(/clear/i);
    // I3(c) — record() must fire on 'none', not just 'found'.
    expect(lookupEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, intent: 'lookup_materials', resultStatus: 'none', resultCount: 0 }),
    );
  });

  it('reports an exact count and all items when at or under MAX_ITEMS_SPOKEN (5)', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    await materialItemRepo.create({ tenantId: TENANT, description: '3 boxes 1/2" PEX', quantity: 3, createdBy: 'u1' });
    await materialItemRepo.create({ tenantId: TENANT, description: 'Flue liner kit', quantity: 1, createdBy: 'u1' });

    const res = await lookupMaterials({ tenantId: TENANT }, { materialItemRepo });

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.count).toBe(2);
    expect(res.data.spokenItems).toHaveLength(2);
    expect(res.summary).toContain('2 items on the materials list');
    expect(res.summary).not.toContain('and more');
  });

  // I3(a) — the exact behavior the review named: 6+ items must truncate to
  // 5 spoken AND carry an honest "more exist" tail, never a false-precise
  // total past the fetch boundary (I4/M2).
  it('caps spokenItems at 5 and reports count as null (never a guessed total) when more than 5 items are pending', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    for (let i = 0; i < 7; i++) {
      await materialItemRepo.create({ tenantId: TENANT, description: `item ${i}`, createdBy: 'u1' });
    }

    const res = await lookupMaterials({ tenantId: TENANT }, { materialItemRepo });

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.spokenItems).toHaveLength(5);
    expect(res.data.count).toBeNull();
    expect(res.summary).toContain('5+ items on the materials list');
    expect(res.summary).toContain('and more');
    // The 5 OLDEST are spoken (M4) — item 0..4, not the newest (item 6).
    expect(res.data.spokenItems.map((i) => i.description)).toEqual([
      'item 0',
      'item 1',
      'item 2',
      'item 3',
      'item 4',
    ]);
  });

  // I4 — the fetch is bounded at the repo boundary (MAX_ITEMS_SPOKEN + 1),
  // never an unbounded SELECT sliced app-side.
  it('requests at most MAX_ITEMS_SPOKEN + 1 rows from the repo (bounded fetch, not an app-side slice)', async () => {
    const listPending = vi.fn(async () => [] as MaterialItem[]);
    const materialItemRepo = { listPending, create: vi.fn(), markPurchased: vi.fn() };

    await lookupMaterials({ tenantId: TENANT, jobId: 'job-1' }, { materialItemRepo: materialItemRepo as never });

    expect(listPending).toHaveBeenCalledWith(TENANT, { jobId: 'job-1', limit: 6 });
  });

  // I2 — the multiplication-sign regression this whole file exists to pin.
  // Amazon Polly reads "3×" as "three times" in a numeric context; Google
  // Cloud TTS typically drops it. Neither engine may ever see it here.
  it('never emits the multiplication sign — quantity is always spoken as a word', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    await materialItemRepo.create({ tenantId: TENANT, description: '3 boxes 1/2" PEX', quantity: 3, createdBy: 'u1' });

    const res = await lookupMaterials({ tenantId: TENANT }, { materialItemRepo });

    expect(res.summary).not.toContain('×');
    expect(res.summary).toContain('3 boxes 1/2" PEX, quantity 3');
  });

  // M1 — five long descriptions joined into one sentence must not blow past
  // buildAnswer's 2000-char hard slice (voice-lookup-answer.ts) and
  // silently drop the "and more" tail.
  it('truncates a long description before it joins the spoken summary', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    const longDescription = 'a'.repeat(200);
    await materialItemRepo.create({ tenantId: TENANT, description: longDescription, createdBy: 'u1' });

    const res = await lookupMaterials({ tenantId: TENANT }, { materialItemRepo });

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    // The raw item keeps its full description (data is not lossy)...
    expect(res.data.spokenItems[0].description).toBe(longDescription);
    // ...but the SPOKEN sentence truncates it well under the 2000-char cap.
    expect(res.summary.length).toBeLessThan(150);
    expect(res.summary).toContain('…');
  });

  // spec-review MAJOR B(2) — neededBy is captured by add_material and must
  // not be silently dropped on the read side.
  it('surfaces vendor and a TTS-safe needed-by date when the item has them', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    await materialItemRepo.create({
      tenantId: TENANT,
      description: '40-gallon water heater',
      quantity: 2,
      vendor: 'Ferguson',
      neededBy: new Date('2026-08-09T00:00:00Z'),
      createdBy: 'u1',
    });

    const res = await lookupMaterials({ tenantId: TENANT }, { materialItemRepo });

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.spokenItems[0].vendor).toBe('Ferguson');
    expect(res.data.spokenItems[0].neededByLabel).toBe('August 9');
    expect(res.summary).toContain('from Ferguson');
    expect(res.summary).toContain('needed by August 9');
  });

  it('omits vendor/needed-by phrasing entirely when the item has neither (never fabricated)', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    await materialItemRepo.create({ tenantId: TENANT, description: 'flux paste', createdBy: 'u1' });

    const res = await lookupMaterials({ tenantId: TENANT }, { materialItemRepo });

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.spokenItems[0].vendor).toBeUndefined();
    expect(res.data.spokenItems[0].neededByLabel).toBeUndefined();
    expect(res.summary).not.toContain('from ');
    expect(res.summary).not.toContain('needed by');
  });

  it('scopes to one job when jobId is given', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    await materialItemRepo.create({ tenantId: TENANT, description: 'job item', jobId: 'job-1', createdBy: 'u1' });
    await materialItemRepo.create({ tenantId: TENANT, description: 'unscoped item', createdBy: 'u1' });

    const res = await lookupMaterials({ tenantId: TENANT, jobId: 'job-1' }, { materialItemRepo });

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.spokenItems).toHaveLength(1);
    expect(res.data.spokenItems[0].description).toBe('job item');
  });

  it('is tenant-scoped', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    await materialItemRepo.create({ tenantId: 't-other', description: 'not mine', createdBy: 'u1' });

    const res = await lookupMaterials({ tenantId: TENANT }, { materialItemRepo });

    expect(res.status).toBe('none');
  });

  // Follow-up (2026-08-09) — date-scoping via dateTimeDescription.
  describe('date scoping (neededByBefore)', () => {
    it('resolves "tomorrow" and passes the day-after boundary to the repo', async () => {
      const listPending = vi.fn(async () => [] as MaterialItem[]);
      const materialItemRepo = { listPending, create: vi.fn(), markPurchased: vi.fn() };

      await lookupMaterials(
        { tenantId: TENANT, dateTimeDescription: 'tomorrow', timezone: TZ, now: NOW },
        { materialItemRepo: materialItemRepo as never },
      );

      // "tomorrow" relative to 2026-06-11 NY is 2026-06-12; the boundary is
      // the START of the day AFTER that (needed_by < boundary keeps
      // everything ON 2026-06-12 and earlier/overdue).
      expect(listPending).toHaveBeenCalledWith(TENANT, {
        neededByBefore: new Date('2026-06-13T00:00:00.000Z'),
        limit: 6,
      });
    });

    it('only speaks items due before the resolved boundary, and orders them soonest-first', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();
      const dueTomorrow = await materialItemRepo.create({
        tenantId: TENANT, description: 'due tomorrow', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00Z'),
      });
      await materialItemRepo.create({
        tenantId: TENANT, description: 'due next week', createdBy: 'u1',
        neededBy: new Date('2026-06-19T00:00:00Z'),
      });
      await materialItemRepo.create({ tenantId: TENANT, description: 'undated', createdBy: 'u1' });

      const res = await lookupMaterials(
        { tenantId: TENANT, dateTimeDescription: 'tomorrow', timezone: TZ, now: NOW },
        { materialItemRepo },
      );

      expect(res.status).toBe('found');
      if (res.status !== 'found') throw new Error('unreachable');
      expect(res.data.spokenItems.map((i) => i.description)).toEqual([dueTomorrow.description]);
    });

    it('states the resolved date scope in the summary', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();
      await materialItemRepo.create({
        tenantId: TENANT, description: 'due tomorrow', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00Z'),
      });

      const res = await lookupMaterials(
        { tenantId: TENANT, dateTimeDescription: 'tomorrow', timezone: TZ, now: NOW },
        { materialItemRepo },
      );

      expect(res.status).toBe('found');
      if (res.status !== 'found') throw new Error('unreachable');
      expect(res.summary).toContain('needed by June 12');
    });

    // A date-scoped empty result must NOT claim "the materials list is
    // clear" — there could be plenty pending, just none matching this
    // window. Saying so would misrepresent an unrelated fact as an answer
    // to the question actually asked.
    it('a date-scoped empty result is honest about the SCOPE being empty, not the whole list', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();
      await materialItemRepo.create({
        tenantId: TENANT, description: 'due way later', createdBy: 'u1',
        neededBy: new Date('2026-12-01T00:00:00Z'),
      });

      const res = await lookupMaterials(
        { tenantId: TENANT, dateTimeDescription: 'tomorrow', timezone: TZ, now: NOW },
        { materialItemRepo },
      );

      expect(res.status).toBe('none');
      expect(res.summary).toContain('June 12');
      expect(res.summary).not.toMatch(/materials list is clear/i);
    });

    // Deliberately DIFFERENT from lookup-crew-schedule.ts's today-fallback:
    // that skill always has something to report (today is always a valid
    // answer), but silently narrowing an unparseable phrase to "today" here
    // could hide a real, later-dated item behind a guessed filter. An
    // unparseable phrase is treated as no filter at all.
    it('an unparseable dateTimeDescription applies no filter — never a silent today-guess', async () => {
      const listPending = vi.fn(async () => [] as MaterialItem[]);
      const materialItemRepo = { listPending, create: vi.fn(), markPurchased: vi.fn() };

      await lookupMaterials(
        { tenantId: TENANT, dateTimeDescription: 'gibberish not a date', timezone: TZ, now: NOW },
        { materialItemRepo: materialItemRepo as never },
      );

      expect(listPending).toHaveBeenCalledWith(TENANT, { limit: 6 });
    });

    it('combines a date scope with a job scope', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();
      const match = await materialItemRepo.create({
        tenantId: TENANT, description: 'job item due tomorrow', jobId: 'job-1', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00Z'),
      });
      await materialItemRepo.create({
        tenantId: TENANT, description: 'job item due later', jobId: 'job-1', createdBy: 'u1',
        neededBy: new Date('2026-12-01T00:00:00Z'),
      });
      await materialItemRepo.create({
        tenantId: TENANT, description: 'other job due tomorrow', jobId: 'job-2', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00Z'),
      });

      const res = await lookupMaterials(
        { tenantId: TENANT, jobId: 'job-1', dateTimeDescription: 'tomorrow', timezone: TZ, now: NOW },
        { materialItemRepo },
      );

      expect(res.status).toBe('found');
      if (res.status !== 'found') throw new Error('unreachable');
      expect(res.data.spokenItems.map((i) => i.description)).toEqual([match.description]);
    });

    it('no dateTimeDescription at all applies no filter (unchanged default behavior)', async () => {
      const listPending = vi.fn(async () => [] as MaterialItem[]);
      const materialItemRepo = { listPending, create: vi.fn(), markPurchased: vi.fn() };

      await lookupMaterials({ tenantId: TENANT, timezone: TZ, now: NOW }, { materialItemRepo: materialItemRepo as never });

      expect(listPending).toHaveBeenCalledWith(TENANT, { limit: 6 });
    });
  });

  // I3(b) — the error path: previously untested entirely.
  describe('error path', () => {
    it('reports status "error" with an honest error message, never throwing', async () => {
      const materialItemRepo = {
        listPending: vi.fn(async () => {
          throw new Error('connection reset');
        }),
        create: vi.fn(),
        markPurchased: vi.fn(),
      };

      const res = await lookupMaterials({ tenantId: TENANT }, { materialItemRepo: materialItemRepo as never });

      expect(res.status).toBe('error');
      if (res.status !== 'error') throw new Error('unreachable');
      expect(res.data.error).toBe('connection reset');
      expect(res.summary).toMatch(/trouble/i);
    });

    // I3(c) — record() must fire on 'error' too, not just 'found'. Missing
    // record() calls on non-'found' branches is the exact bug class that
    // forced this skill-module refactor in the first place.
    it('records the lookup event on the error branch', async () => {
      const lookupEvents = eventsSpy();
      const materialItemRepo = {
        listPending: vi.fn(async () => {
          throw new Error('db down');
        }),
        create: vi.fn(),
        markPurchased: vi.fn(),
      };

      await lookupMaterials({ tenantId: TENANT }, { materialItemRepo: materialItemRepo as never, lookupEvents });

      expect(lookupEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, intent: 'lookup_materials', resultStatus: 'error', resultCount: 0 }),
      );
    });

    it('a lookupEvents.record failure never breaks the caller-facing result', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();
      const failingEvents = {
        record: vi.fn(async () => {
          throw new Error('audit write failed');
        }),
      } as unknown as LookupEventService;

      const res = await lookupMaterials(
        { tenantId: TENANT },
        { materialItemRepo, lookupEvents: failingEvents },
      );

      expect(res.status).toBe('none');
    });
  });
});
