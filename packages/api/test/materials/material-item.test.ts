import { describe, it, expect } from 'vitest';
import { InMemoryMaterialItemRepository } from '../../src/materials/material-item';
import { ValidationError } from '../../src/shared/errors';

describe('MaterialItemRepository', () => {
  it('creates and lists pending items by tenant, optional job filter', async () => {
    const repo = new InMemoryMaterialItemRepository();
    await repo.create({
      tenantId: 't1', description: '3 boxes 1/2" PEX', quantity: 3,
      jobId: 'job-1', createdBy: 'u1',
    });
    await repo.create({ tenantId: 't1', description: 'Flue liner kit', quantity: 1, createdBy: 'u1' });
    await repo.create({ tenantId: 't2', description: 'other tenant', quantity: 1, createdBy: 'u2' });

    const all = await repo.listPending('t1');
    expect(all).toHaveLength(2);
    const forJob = await repo.listPending('t1', { jobId: 'job-1' });
    expect(forJob).toHaveLength(1);
    expect(forJob[0].description).toBe('3 boxes 1/2" PEX');

    await repo.markPurchased('t1', all[0].id, 'u1');
    expect(await repo.listPending('t1')).toHaveLength(1);
  });

  it(
    "a non-matching/malformed jobId filter returns [] — never falls back to the " +
      "tenant's whole pending list",
    async () => {
      // Mirrors the Pg-side guard (pg-material-item.ts): a jobId that can't
      // match anything (an unresolved spoken job reference on the voice
      // path, or simply malformed) must scope down to nothing, not silently
      // drop the filter and hand back every pending item.
      const repo = new InMemoryMaterialItemRepository();
      await repo.create({ tenantId: 't1', description: 'unscoped', createdBy: 'u1' });
      await repo.create({ tenantId: 't1', description: 'job-1 item', jobId: 'job-1', createdBy: 'u1' });

      expect(await repo.listPending('t1')).toHaveLength(2);
      expect(await repo.listPending('t1', { jobId: 'not-a-real-job' })).toEqual([]);
    },
  );

  it('never leaks another tenant into listPending, even with a matching jobId filter', async () => {
    const repo = new InMemoryMaterialItemRepository();
    await repo.create({ tenantId: 't1', description: 'a', jobId: 'job-1', createdBy: 'u1' });
    await repo.create({ tenantId: 't2', description: 'b', jobId: 'job-1', createdBy: 'u2' });

    expect(await repo.listPending('t2')).toHaveLength(1);
    expect((await repo.listPending('t2'))[0].description).toBe('b');
    expect(await repo.listPending('t2', { jobId: 'job-1' })).toHaveLength(1);
    expect(await repo.listPending('nonexistent-tenant')).toHaveLength(0);
  });

  // Quality-review I4 — lookup_materials must be able to cap the fetch at
  // the repo boundary instead of loading every pending row for the tenant.
  it('limit caps the returned rows to the N OLDEST pending items', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const first = await repo.create({ tenantId: 't1', description: 'first', createdBy: 'u1' });
    const second = await repo.create({ tenantId: 't1', description: 'second', createdBy: 'u1' });
    await repo.create({ tenantId: 't1', description: 'third', createdBy: 'u1' });

    const limited = await repo.listPending('t1', { limit: 2 });
    expect(limited.map((i) => i.id)).toEqual([first.id, second.id]);
  });

  it('an absent limit returns every pending row (unbounded, current behavior)', async () => {
    const repo = new InMemoryMaterialItemRepository();
    for (let i = 0; i < 4; i++) {
      await repo.create({ tenantId: 't1', description: `item ${i}`, createdBy: 'u1' });
    }
    expect(await repo.listPending('t1')).toHaveLength(4);
  });

  it('combines limit with a jobId filter', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const firstForJob = await repo.create({ tenantId: 't1', description: 'a', jobId: 'job-1', createdBy: 'u1' });
    await repo.create({ tenantId: 't1', description: 'b', jobId: 'job-1', createdBy: 'u1' });
    await repo.create({ tenantId: 't1', description: 'unrelated', createdBy: 'u1' });

    const limited = await repo.listPending('t1', { jobId: 'job-1', limit: 1 });
    expect(limited.map((i) => i.id)).toEqual([firstForJob.id]);
  });

  it('returns UNDATED pending items oldest-created first', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const first = await repo.create({ tenantId: 't1', description: 'first', createdBy: 'u1' });
    const second = await repo.create({ tenantId: 't1', description: 'second', createdBy: 'u1' });
    const third = await repo.create({ tenantId: 't1', description: 'third', createdBy: 'u1' });

    const pending = await repo.listPending('t1');
    expect(pending.map((i) => i.id)).toEqual([first.id, second.id, third.id]);
  });

  /**
   * F2 — the DEFAULT (no `needed_by` bound) ordering. #819 fixed the
   * DATE-SCOPED ask; the un-scoped one kept the original defect:
   * `created_at ASC` under `lookup_materials`'s 6-row fetch / 5-item spoken
   * cap meant "what do I need?" spoke five ancient items and never mentioned
   * one due tomorrow. Worse than a one-off omission, because the shopping
   * list is append-mostly (only `markPurchased` prunes it) — the SAME five
   * stalest rows own the whole spoken answer forever.
   *
   * One ordering now serves both shapes: `needed_by ASC NULLS LAST,
   * created_at ASC` (+ `id ASC` in Pg). NULLS LAST is what makes it safe:
   * an undated item has no deadline, so it is not infinitely urgent.
   */
  describe('F2 — default ordering is by urgency, undated last', () => {
    it('puts a dated item ahead of undated ones however much older they are', async () => {
      const repo = new InMemoryMaterialItemRepository();
      for (let i = 0; i < 6; i++) {
        await repo.create({ tenantId: 't1', description: `ancient undated ${i}`, createdBy: 'u1' });
      }
      const urgent = await repo.create({
        tenantId: 't1', description: 'PEX for tomorrow', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00.000Z'),
      });

      const top = await repo.listPending('t1', { limit: 6 });
      expect(top[0].id).toBe(urgent.id);
      expect(top.map((i) => i.id)).toContain(urgent.id);
    });

    it('sorts undated items LAST — no needed_by is NOT infinite urgency', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const undated = await repo.create({ tenantId: 't1', description: 'undated', createdBy: 'u1' });
      const farFuture = await repo.create({
        tenantId: 't1', description: 'due in a year', createdBy: 'u1',
        neededBy: new Date('2027-01-01T00:00:00.000Z'),
      });

      expect((await repo.listPending('t1')).map((i) => i.id)).toEqual([farFuture.id, undated.id]);
    });

    it('orders dated items soonest-first, overdue ahead of upcoming', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const upcoming = await repo.create({
        tenantId: 't1', description: 'due next week', createdBy: 'u1',
        neededBy: new Date('2026-06-19T00:00:00.000Z'),
      });
      const overdue = await repo.create({
        tenantId: 't1', description: 'overdue since March', createdBy: 'u1',
        neededBy: new Date('2026-03-02T00:00:00.000Z'),
      });

      expect((await repo.listPending('t1')).map((i) => i.id)).toEqual([overdue.id, upcoming.id]);
    });

    it('breaks a needed_by tie on created_at, same key Pg breaks it on', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const sameDay = new Date('2026-06-12T00:00:00.000Z');
      const firstCreated = await repo.create({
        tenantId: 't1', description: 'first created', createdBy: 'u1', neededBy: sameDay,
      });
      // Force a distinct created_at: the InMemory clock is millisecond
      // precision, and a same-millisecond tie falls to insertion order (the
      // documented, deliberate residual divergence from Pg's `id ASC`).
      await new Promise((r) => setTimeout(r, 2));
      const secondCreated = await repo.create({
        tenantId: 't1', description: 'second created', createdBy: 'u1', neededBy: sameDay,
      });

      expect((await repo.listPending('t1')).map((i) => i.id)).toEqual([
        firstCreated.id,
        secondCreated.id,
      ]);
    });
  });

  // Follow-up to Task 9's I4/M4 fetch-bound work: lookup_materials's bounded
  // fetch (oldest-created-first, capped at MAX_ITEMS_SPOKEN + 1) meant a
  // tenant with more pending items than the cap could have a genuinely
  // time-sensitive item never spoken at all — it only "self-corrects" once
  // the item ages into the oldest-N window. A real date filter, applied at
  // the repo/SQL boundary (not sliced app-side), is the actual fix.
  describe('neededByBefore filter', () => {
    it('returns only items whose neededBy is strictly before the boundary', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const dueBefore = await repo.create({
        tenantId: 't1', description: 'due before', createdBy: 'u1',
        neededBy: new Date('2026-08-09T00:00:00Z'),
      });
      await repo.create({
        tenantId: 't1', description: 'due at boundary (excluded, exclusive)', createdBy: 'u1',
        neededBy: new Date('2026-08-10T00:00:00Z'),
      });
      await repo.create({
        tenantId: 't1', description: 'due after boundary', createdBy: 'u1',
        neededBy: new Date('2026-08-11T00:00:00Z'),
      });

      const result = await repo.listPending('t1', { neededByBefore: new Date('2026-08-10T00:00:00Z') });
      expect(result.map((i) => i.id)).toEqual([dueBefore.id]);
    });

    // Decision (documented on MaterialItemListOptions.neededByBefore): a
    // NULL/undefined neededBy does NOT match a date-scoped query. An
    // undated item has no known deadline, so it can't honestly be said to
    // be "needed by" any particular date — and this is also what a plain
    // SQL `needed_by < $1` does for free (three-valued logic excludes
    // NULL), so both backends agree on this without any extra branching.
    it('excludes items with no neededBy at all — an undated item is not "needed by" any date', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const dated = await repo.create({
        tenantId: 't1', description: 'dated', createdBy: 'u1',
        neededBy: new Date('2026-08-01T00:00:00Z'),
      });
      await repo.create({ tenantId: 't1', description: 'undated', createdBy: 'u1' });

      const result = await repo.listPending('t1', { neededByBefore: new Date('2026-09-01T00:00:00Z') });
      expect(result.map((i) => i.id)).toEqual([dated.id]);
    });

    it('combines neededByBefore with a jobId filter', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const match = await repo.create({
        tenantId: 't1', description: 'job + due soon', jobId: 'job-1', createdBy: 'u1',
        neededBy: new Date('2026-08-01T00:00:00Z'),
      });
      await repo.create({
        tenantId: 't1', description: 'job + due later', jobId: 'job-1', createdBy: 'u1',
        neededBy: new Date('2026-09-01T00:00:00Z'),
      });
      await repo.create({
        tenantId: 't1', description: 'other job, due soon', jobId: 'job-2', createdBy: 'u1',
        neededBy: new Date('2026-08-01T00:00:00Z'),
      });

      const result = await repo.listPending('t1', {
        jobId: 'job-1',
        neededByBefore: new Date('2026-08-15T00:00:00Z'),
      });
      expect(result.map((i) => i.id)).toEqual([match.id]);
    });

    it('combines neededByBefore with limit', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const soonest = await repo.create({
        tenantId: 't1', description: 'soonest', createdBy: 'u1',
        neededBy: new Date('2026-08-01T00:00:00Z'),
      });
      await repo.create({
        tenantId: 't1', description: 'next soonest', createdBy: 'u1',
        neededBy: new Date('2026-08-05T00:00:00Z'),
      });

      const result = await repo.listPending('t1', {
        neededByBefore: new Date('2026-09-01T00:00:00Z'),
        limit: 1,
      });
      expect(result.map((i) => i.id)).toEqual([soonest.id]);
    });

    // Ordering decision (documented on MaterialItemListOptions.neededByBefore):
    // a date-scoped ask cares about URGENCY, not insertion order — the
    // fetch is capped (lookup-materials.ts's FETCH_LIMIT), so if more
    // matching items exist than the cap, the ones due SOONEST must be the
    // ones that make the cut, not merely the ones created first.
    it('orders date-scoped results by neededBy ascending (soonest first), not creation order', async () => {
      const repo = new InMemoryMaterialItemRepository();
      // Created FIRST, but due LATER — if order were still creation-order,
      // this would come first; it must not.
      const createdFirstDueLater = await repo.create({
        tenantId: 't1', description: 'created first, due later', createdBy: 'u1',
        neededBy: new Date('2026-08-09T00:00:00Z'),
      });
      // Created SECOND, but due SOONER — must be spoken first in a
      // date-scoped ask despite being the newer row.
      const createdSecondDueSooner = await repo.create({
        tenantId: 't1', description: 'created second, due sooner', createdBy: 'u1',
        neededBy: new Date('2026-08-01T00:00:00Z'),
      });

      const result = await repo.listPending('t1', { neededByBefore: new Date('2026-08-10T00:00:00Z') });
      expect(result.map((i) => i.id)).toEqual([
        createdSecondDueSooner.id,
        createdFirstDueLater.id,
      ]);
    });

    // Review follow-up J1 (2026-08-09) — the tie-break the two backends must
    // AGREE on. `add-material-handler.ts` writes every voice-captured
    // needed_by as `new Date(\`${neededBy}T00:00:00Z\`)`, so two items due the
    // same day tie EXACTLY on the sort key — the normal case, not an edge
    // case. Both backends now break that tie on created_at (Pg adds `id ASC`
    // after it purely for determinism); before this fix Pg went straight to a
    // random v4 `id` while InMemory's stable sort gave insertion order, so
    // under lookup_materials's 5-item cap they spoke DIFFERENT SUBSETS.
    it('breaks an exact needed_by tie on created_at (the key both backends share)', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const sameDay = new Date('2026-06-12T00:00:00.000Z');
      const first = await repo.create({
        tenantId: 't1', description: 'first captured', createdBy: 'u1', neededBy: sameDay,
      });
      // Distinct millisecond so this pins created_at ordering itself, not
      // merely the stable-sort fallback (Pg's created_at is DB NOW() at
      // microsecond precision, so it effectively never ties there).
      await new Promise((r) => setTimeout(r, 2));
      const second = await repo.create({
        tenantId: 't1', description: 'second captured', createdBy: 'u1', neededBy: sameDay,
      });

      const result = await repo.listPending('t1', { neededByBefore: new Date('2026-06-13T00:00:00.000Z') });
      expect(result.map((i) => i.id)).toEqual([first.id, second.id]);
    });

    // Review follow-up J2 — a malformed date bound must behave like a
    // malformed jobId: return [], never a silently WIDENED list. Pg used to
    // drop the predicate entirely (whole pending list under a date-scoped
    // question); InMemory used to throw a raw TypeError. Same input, opposite
    // outcomes — now one shared guard.
    it('returns [] for a non-Date neededByBefore instead of throwing', async () => {
      const repo = new InMemoryMaterialItemRepository();
      await repo.create({
        tenantId: 't1', description: 'dated', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00.000Z'),
      });

      const result = await repo.listPending('t1', {
        neededByBefore: '2026-06-13T00:00:00.000Z' as unknown as Date,
      });
      expect(result).toEqual([]);
    });

    it('returns [] for an Invalid Date neededByBefore', async () => {
      const repo = new InMemoryMaterialItemRepository();
      await repo.create({
        tenantId: 't1', description: 'dated', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00.000Z'),
      });

      expect(await repo.listPending('t1', { neededByBefore: new Date('nonsense') })).toEqual([]);
    });

    // F2 REVERSED THIS PIN. It used to assert that an absent bound kept
    // oldest-created-first even when that buried the sooner-due item — i.e.
    // it encoded the exact defect F2 fixes. The un-scoped list now orders by
    // urgency too, so the same two rows come back sooner-due first.
    it('an absent neededByBefore still orders by urgency, sooner-due first', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const dueLater = await repo.create({
        tenantId: 't1', description: 'first, due later', createdBy: 'u1',
        neededBy: new Date('2026-09-01T00:00:00Z'),
      });
      const dueSooner = await repo.create({
        tenantId: 't1', description: 'second, due sooner', createdBy: 'u1',
        neededBy: new Date('2026-08-01T00:00:00Z'),
      });

      const result = await repo.listPending('t1');
      expect(result.map((i) => i.id)).toEqual([dueSooner.id, dueLater.id]);
    });
  });

  // Review follow-up K3 (2026-08-09) — the INCLUSIVE lower bound that lets
  // lookup_materials isolate "due ON the day you asked about" from "due
  // sooner (possibly long overdue)". Without it, one open-ended
  // `neededByBefore` query ordered soonest-first let overdue rows consume the
  // whole spoken cap and silently omit every item due on the asked-for day.
  describe('neededByFrom (inclusive lower bound)', () => {
    it('includes an item due exactly ON the lower bound, excludes anything earlier', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const onBound = await repo.create({
        tenantId: 't1', description: 'due on the boundary', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00.000Z'),
      });
      await repo.create({
        tenantId: 't1', description: 'due a day earlier', createdBy: 'u1',
        neededBy: new Date('2026-06-11T00:00:00.000Z'),
      });

      const result = await repo.listPending('t1', {
        neededByFrom: new Date('2026-06-12T00:00:00.000Z'),
      });
      expect(result.map((i) => i.id)).toEqual([onBound.id]);
    });

    it('brackets a single day when combined with neededByBefore', async () => {
      const repo = new InMemoryMaterialItemRepository();
      await repo.create({
        tenantId: 't1', description: 'overdue', createdBy: 'u1',
        neededBy: new Date('2026-03-02T00:00:00.000Z'),
      });
      const onDay = await repo.create({
        tenantId: 't1', description: 'due that day', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00.000Z'),
      });
      await repo.create({
        tenantId: 't1', description: 'due later', createdBy: 'u1',
        neededBy: new Date('2026-06-19T00:00:00.000Z'),
      });

      const result = await repo.listPending('t1', {
        neededByFrom: new Date('2026-06-12T00:00:00.000Z'),
        neededByBefore: new Date('2026-06-13T00:00:00.000Z'),
      });
      expect(result.map((i) => i.id)).toEqual([onDay.id]);
    });

    it('excludes undated items, exactly like neededByBefore', async () => {
      const repo = new InMemoryMaterialItemRepository();
      await repo.create({ tenantId: 't1', description: 'undated', createdBy: 'u1' });

      expect(
        await repo.listPending('t1', { neededByFrom: new Date('2020-01-01T00:00:00.000Z') }),
      ).toEqual([]);
    });

    it('returns [] for a malformed neededByFrom rather than widening the answer', async () => {
      const repo = new InMemoryMaterialItemRepository();
      await repo.create({
        tenantId: 't1', description: 'dated', createdBy: 'u1',
        neededBy: new Date('2026-06-12T00:00:00.000Z'),
      });

      expect(
        await repo.listPending('t1', { neededByFrom: 'yesterday' as unknown as Date }),
      ).toEqual([]);
    });
  });

  it('defaults quantity to 1 when omitted, matching the DB column default', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const created = await repo.create({ tenantId: 't1', description: 'flux paste', createdBy: 'u1' });
    expect(created.quantity).toBe(1);
    const [found] = await repo.listPending('t1');
    expect(found.quantity).toBe(1);
  });

  it('defaults status to pending and leaves purchasedBy/purchasedAt unset on create', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const created = await repo.create({ tenantId: 't1', description: 'copper fittings', createdBy: 'u1' });
    expect(created.status).toBe('pending');
    expect(created.purchasedBy).toBeUndefined();
    expect(created.purchasedAt).toBeUndefined();
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('leaves optional fields (jobId, vendor, neededBy) undefined when not provided', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const created = await repo.create({ tenantId: 't1', description: 'no extras', createdBy: 'u1' });
    expect(created.jobId).toBeUndefined();
    expect(created.vendor).toBeUndefined();
    expect(created.neededBy).toBeUndefined();
  });

  it('round-trips optional fields when provided', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const neededBy = new Date('2026-09-01T00:00:00Z');
    const created = await repo.create({
      tenantId: 't1',
      description: 'flue liner kit',
      quantity: 2,
      jobId: 'job-9',
      vendor: 'Acme Supply',
      neededBy,
      createdBy: 'u1',
    });
    expect(created.jobId).toBe('job-9');
    expect(created.vendor).toBe('Acme Supply');
    expect(created.neededBy).toEqual(neededBy);
  });

  it('rejects a non-positive quantity', async () => {
    const repo = new InMemoryMaterialItemRepository();
    await expect(
      repo.create({ tenantId: 't1', description: 'bad qty', quantity: 0, createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.create({ tenantId: 't1', description: 'bad qty', quantity: -1, createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a non-integer quantity', async () => {
    const repo = new InMemoryMaterialItemRepository();
    await expect(
      repo.create({ tenantId: 't1', description: 'bad qty', quantity: 1.5, createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a quantity that would overflow Postgres INTEGER (int4)', async () => {
    const repo = new InMemoryMaterialItemRepository();
    // A garbled transcript quantity ("two billion nails") is not exotic on
    // the voice path — this must be a clean ValidationError, not a raw
    // Postgres 22003 overflow surfacing as a 500.
    await expect(
      repo.create({ tenantId: 't1', description: 'way too many', quantity: 2_147_483_648, createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
  });

  it('accepts the quantity domain cap boundary (1,000,000)', async () => {
    const repo = new InMemoryMaterialItemRepository();
    const created = await repo.create({
      tenantId: 't1',
      description: 'at the cap',
      quantity: 1_000_000,
      createdBy: 'u1',
    });
    expect(created.quantity).toBe(1_000_000);
  });

  it('rejects a missing/blank description, tenantId, or createdBy', async () => {
    const repo = new InMemoryMaterialItemRepository();
    await expect(
      // @ts-expect-error -- deliberately omitting a required field
      repo.create({ tenantId: 't1', createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.create({ tenantId: 't1', description: '   ', createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      // @ts-expect-error -- deliberately omitting a required field
      repo.create({ description: 'x', createdBy: 'u1' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      // @ts-expect-error -- deliberately omitting a required field
      repo.create({ tenantId: 't1', description: 'x' }),
    ).rejects.toThrow(ValidationError);
  });

  describe('markPurchased', () => {
    it('transitions pending -> purchased, stamping purchasedBy/purchasedAt', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const created = await repo.create({ tenantId: 't1', description: 'PEX', createdBy: 'u1' });
      const before = Date.now();
      const purchased = await repo.markPurchased('t1', created.id, 'u2');
      expect(purchased).not.toBeNull();
      expect(purchased!.status).toBe('purchased');
      expect(purchased!.purchasedBy).toBe('u2');
      expect(purchased!.purchasedAt).toBeInstanceOf(Date);
      expect(purchased!.purchasedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(await repo.listPending('t1')).toHaveLength(0);
    });

    it('returns null for a nonexistent id', async () => {
      const repo = new InMemoryMaterialItemRepository();
      expect(await repo.markPurchased('t1', 'no-such-id', 'u1')).toBeNull();
    });

    it("returns null when the id belongs to a different tenant (no cross-tenant mutation)", async () => {
      const repo = new InMemoryMaterialItemRepository();
      const created = await repo.create({ tenantId: 't1', description: 'PEX', createdBy: 'u1' });
      expect(await repo.markPurchased('t2', created.id, 'u2')).toBeNull();
      // Untouched — still pending under its real tenant.
      expect(await repo.listPending('t1')).toHaveLength(1);
    });

    it('returns null on a second markPurchased call (no pending -> purchased -> purchased)', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const created = await repo.create({ tenantId: 't1', description: 'PEX', createdBy: 'u1' });
      const first = await repo.markPurchased('t1', created.id, 'u2');
      expect(first).not.toBeNull();
      const second = await repo.markPurchased('t1', created.id, 'u3');
      expect(second).toBeNull();
      // The original purchase is left intact, not clobbered by the second actor.
      expect(first!.purchasedBy).toBe('u2');
    });

    it('rejects an empty or blank actorId instead of writing purchased_by = \'\'', async () => {
      const repo = new InMemoryMaterialItemRepository();
      const created = await repo.create({ tenantId: 't1', description: 'PEX', createdBy: 'u1' });
      await expect(repo.markPurchased('t1', created.id, '')).rejects.toThrow(ValidationError);
      await expect(repo.markPurchased('t1', created.id, '   ')).rejects.toThrow(ValidationError);
      // Untouched — still pending, not silently "purchased by nobody".
      expect(await repo.listPending('t1')).toHaveLength(1);
    });
  });
});
