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

  // Review follow-up N7 — `resolveSpokenDay` runs chrono with
  // `forwardDate: true`, so a phrase said in December can resolve into NEXT
  // year. A bare "January 5" gave the caller no way to hear that.
  it('adds the year to a needed-by label only when it differs from the tenant\'s current year', async () => {
    const materialItemRepo = new InMemoryMaterialItemRepository();
    await materialItemRepo.create({
      tenantId: TENANT, description: 'this year', createdBy: 'u1',
      neededBy: new Date('2026-06-20T00:00:00Z'),
    });
    await materialItemRepo.create({
      tenantId: TENANT, description: 'next year', createdBy: 'u1',
      neededBy: new Date('2027-01-05T00:00:00Z'),
    });

    const res = await lookupMaterials({ tenantId: TENANT, timezone: TZ, now: NOW }, { materialItemRepo });

    expect(res.status).toBe('found');
    if (res.status !== 'found') throw new Error('unreachable');
    expect(res.data.spokenItems[0].neededByLabel).toBe('June 20');
    expect(res.data.spokenItems[1].neededByLabel).toBe('January 5, 2027');
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
    it('resolves "tomorrow" into a bracketed day window plus a bounded overdue probe', async () => {
      const listPending = vi.fn(async () => [] as MaterialItem[]);
      const materialItemRepo = { listPending, create: vi.fn(), markPurchased: vi.fn() };

      await lookupMaterials(
        { tenantId: TENANT, dateTimeDescription: 'tomorrow', timezone: TZ, now: NOW },
        { materialItemRepo: materialItemRepo as never },
      );

      // "tomorrow" relative to 2026-06-11 NY is 2026-06-12. The ANSWER query
      // brackets that day exactly — [2026-06-12, 2026-06-13) — so overdue
      // rows can never consume the spoken cap ahead of it (K3).
      expect(listPending).toHaveBeenNthCalledWith(1, TENANT, {
        neededByFrom: new Date('2026-06-12T00:00:00.000Z'),
        neededByBefore: new Date('2026-06-13T00:00:00.000Z'),
        limit: 6,
      });
      // ...and a second, COUNT-only probe of everything due before that day
      // backs the "there are N items needed sooner" disclosure.
      expect(listPending).toHaveBeenNthCalledWith(2, TENANT, {
        neededByBefore: new Date('2026-06-12T00:00:00.000Z'),
        limit: 21,
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
    //
    // HONESTY NOTE (review follow-up N9, 2026-08-09): this is a DESIGN PIN,
    // not red-first evidence. It also holds against the pre-change code on
    // origin/main, which ignored `dateTimeDescription` entirely and so
    // applied no filter for every phrase, parseable or not. The genuinely
    // red-first companion is "says so when a spoken date phrase could not be
    // resolved…" above (J3), which fails on both origin/main and on this
    // branch's first commit.
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

    // Review follow-up K3 (2026-08-09) — THE defect this whole date path was
    // supposed to prevent, re-created in the other direction. One open-ended
    // `needed_by < boundary` query ordered soonest-first lets OVERDUE rows
    // consume the entire 5-item spoken cap, so the caller who asked "what do
    // I need for tomorrow?" hears five months-old items and "and more beyond
    // that" — and never hears either item actually due tomorrow.
    it('speaks the items due on the asked-for day even when older overdue items would fill the cap', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();
      for (let i = 1; i <= 8; i++) {
        await materialItemRepo.create({
          tenantId: TENANT,
          description: `overdue ${i}`,
          createdBy: 'u1',
          neededBy: new Date(`2026-03-0${i}T00:00:00Z`),
        });
      }
      await materialItemRepo.create({
        tenantId: TENANT, description: 'copper fittings', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00Z'),
      });
      await materialItemRepo.create({
        tenantId: TENANT, description: 'condensate pump', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00Z'),
      });

      const res = await lookupMaterials(
        { tenantId: TENANT, dateTimeDescription: 'tomorrow', timezone: TZ, now: NOW },
        { materialItemRepo },
      );

      expect(res.status).toBe('found');
      if (res.status !== 'found') throw new Error('unreachable');
      expect(res.data.spokenItems.map((i) => i.description)).toEqual([
        'copper fittings',
        'condensate pump',
      ]);
      // ...and the overdue backlog is disclosed, never silently dropped.
      expect(res.summary).toContain('8');
      expect(res.summary).toMatch(/needed sooner/i);
      expect(res.summary).toContain('March 1');
    });

    it('discloses the overdue backlog even when nothing at all is due on the asked-for day', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();
      await materialItemRepo.create({
        tenantId: TENANT, description: 'long overdue', createdBy: 'u1',
        neededBy: new Date('2026-03-02T00:00:00Z'),
      });

      const res = await lookupMaterials(
        { tenantId: TENANT, dateTimeDescription: 'tomorrow', timezone: TZ, now: NOW },
        { materialItemRepo },
      );

      expect(res.status).toBe('none');
      expect(res.summary).toContain('June 12');
      expect(res.summary).toMatch(/needed sooner/i);
      expect(res.summary).toContain('March 2');
    });

    it('says nothing about a sooner backlog when there is none', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();
      await materialItemRepo.create({
        tenantId: TENANT, description: 'due tomorrow', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00Z'),
      });

      const res = await lookupMaterials(
        { tenantId: TENANT, dateTimeDescription: 'tomorrow', timezone: TZ, now: NOW },
        { materialItemRepo },
      );

      expect(res.summary).not.toMatch(/needed sooner/i);
    });

    // Review follow-up J3 — `resolveNeededByScope` returned null for BOTH an
    // absent phrase and an unparseable one, so "what do I need asap?"
    // produced a summary byte-identical to an unscoped ask. The no-today-guess
    // decision stays; the SILENCE about it does not. Mirrors the sibling
    // contract the design cites as its foil: lookup_crew_schedule "always
    // names the day actually being reported".
    it('says so when a spoken date phrase could not be resolved, instead of answering as if none was said', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();
      await materialItemRepo.create({ tenantId: TENANT, description: 'flux paste', createdBy: 'u1' });

      const res = await lookupMaterials(
        { tenantId: TENANT, dateTimeDescription: 'asap', timezone: TZ, now: NOW },
        { materialItemRepo },
      );

      expect(res.status).toBe('found');
      if (res.status !== 'found') throw new Error('unreachable');
      expect(res.summary).toMatch(/couldn't tell/i);
      expect(res.summary).toContain('asap');
      expect(res.summary).toContain('flux paste');
    });

    it('says so on an unresolved phrase even when the list is empty', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();

      const res = await lookupMaterials(
        { tenantId: TENANT, dateTimeDescription: 'right away', timezone: TZ, now: NOW },
        { materialItemRepo },
      );

      expect(res.status).toBe('none');
      expect(res.summary).toMatch(/couldn't tell/i);
      expect(res.summary).toContain('right away');
    });

    // Review follow-up J6 — every date fixture so far used a tenant zone
    // equal to DEFAULT_TENANT_TIMEZONE at an hour where the tenant day and
    // the UTC day coincide, so deleting the `timezone` argument changed
    // nothing. These two pin the tenant-zone resolution in both directions.
    it('resolves "tomorrow" in the TENANT zone when the tenant day is BEHIND the UTC day', async () => {
      const listPending = vi.fn(async () => [] as MaterialItem[]);
      const materialItemRepo = { listPending, create: vi.fn(), markPurchased: vi.fn() };

      // 2026-06-12T02:00Z is 22:00 on 2026-06-11 in New York — tenant
      // "tomorrow" is 2026-06-12, NOT the UTC-day-based 2026-06-13.
      await lookupMaterials(
        {
          tenantId: TENANT,
          dateTimeDescription: 'tomorrow',
          timezone: 'America/New_York',
          now: new Date('2026-06-12T02:00:00.000Z'),
        },
        { materialItemRepo: materialItemRepo as never },
      );

      expect(listPending).toHaveBeenCalledWith(TENANT, {
        neededByFrom: new Date('2026-06-12T00:00:00.000Z'),
        neededByBefore: new Date('2026-06-13T00:00:00.000Z'),
        limit: 6,
      });
    });

    it('resolves "tomorrow" in the TENANT zone when the tenant day is AHEAD of the UTC day', async () => {
      const listPending = vi.fn(async () => [] as MaterialItem[]);
      const materialItemRepo = { listPending, create: vi.fn(), markPurchased: vi.fn() };

      // 2026-06-11T22:00Z is 10:00 on 2026-06-12 in Auckland — tenant
      // "tomorrow" is 2026-06-13, NOT the UTC-day-based 2026-06-12.
      await lookupMaterials(
        {
          tenantId: TENANT,
          dateTimeDescription: 'tomorrow',
          timezone: 'Pacific/Auckland',
          now: new Date('2026-06-11T22:00:00.000Z'),
        },
        { materialItemRepo: materialItemRepo as never },
      );

      expect(listPending).toHaveBeenCalledWith(TENANT, {
        neededByFrom: new Date('2026-06-13T00:00:00.000Z'),
        neededByBefore: new Date('2026-06-14T00:00:00.000Z'),
        limit: 6,
      });
    });

    // Review follow-up N3 — a job-scoped empty result used to assert a fact
    // about the tenant's WHOLE list ("Nothing on the materials list is needed
    // by June 12") from a job-scoped query. Same flaw the module comment
    // correctly identifies one axis over.
    it('keeps the job scope in the empty-result phrasing', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();
      await materialItemRepo.create({
        tenantId: TENANT, description: 'other job, due tomorrow', jobId: 'job-2', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00Z'),
      });

      const res = await lookupMaterials(
        { tenantId: TENANT, jobId: 'job-1', dateTimeDescription: 'tomorrow', timezone: TZ, now: NOW },
        { materialItemRepo },
      );

      expect(res.status).toBe('none');
      expect(res.summary).toMatch(/this job/i);
      expect(res.summary).not.toMatch(/^Nothing on the materials list is needed by/);
    });

    it('keeps the job scope in the unscoped empty-result phrasing too', async () => {
      const materialItemRepo = new InMemoryMaterialItemRepository();

      const res = await lookupMaterials({ tenantId: TENANT, jobId: 'job-1' }, { materialItemRepo });

      expect(res.status).toBe('none');
      expect(res.summary).toMatch(/this job/i);
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
